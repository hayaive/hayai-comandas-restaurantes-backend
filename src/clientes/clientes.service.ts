import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { DiaOperativoService } from '../comun/dia-operativo/dia-operativo.service';
import { fijarAutor } from '../comun/prisma/autor';
import { nuevoId } from '../comun/id';
import { Prisma } from '../generated/prisma/client';
import { bloquearLineas, elegirLineas, idsDeSeleccion, partirLinea } from '../comandas/lineas';
import { ReasignarLineasDto } from './dto/cliente.dto';

/**
 * Clientes: la unidad de cobro (docs/DECISIONES-DATOS.md §15).
 *
 * Un `Cliente` es una VISITA: quién consume, dónde está sentado (o no) y qué
 * debe. La mesa está ocupada ⟺ hay un cliente ABIERTO sentado en ella. Se
 * cierra al terminar (sólo sin deuda) y no se borra.
 *
 * Toda transacción que escriba abre con `fijarAutor`: los UPDATE de `cliente`
 * (mover, cerrar, reabrir) y de `comanda_item` quedan en la bitácora.
 */
@Injectable()
export class ClientesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly diaOperativo: DiaOperativoService,
  ) {}

  // ═════════════════════════ Asiento ═════════════════════════

  /**
   * Una mesa donde se puede sentar o pedir: viva, en la distribución ACTIVA de
   * su salón y no bloqueada. Devuelve la foto (salón y plantilla) que la
   * comanda congela. Única fuente de la regla (la usan sentar, mover y pedir).
   */
  async resolverAsiento(tx: Prisma.TransactionClient, restauranteId: string, mesaId: string) {
    const mesa = await tx.mesa.findFirst({ where: { restauranteId, id: mesaId, eliminadaEn: null } });
    if (!mesa) throw new NotFoundException('Mesa no encontrada');

    const plantilla = await tx.plantilla.findFirst({ where: { restauranteId, salonId: mesa.salonId, activa: true } });
    if (!plantilla) throw new BadRequestException('El salón de esa mesa no tiene una distribución activa');

    const enPlano = await tx.plantillaMesa.findFirst({
      where: { restauranteId, plantillaId: plantilla.id, mesaId },
    });
    if (!enPlano) throw new BadRequestException('Esa mesa no está en la distribución activa');
    if (enPlano.bloqueada) throw new ConflictException('Esa mesa está bloqueada');

    return { mesa, salonId: mesa.salonId, plantillaId: plantilla.id };
  }

  /** El cliente, o 404. */
  private async obtenerCliente(tx: Prisma.TransactionClient, restauranteId: string, id: string) {
    const cliente = await tx.cliente.findFirst({ where: { restauranteId, id } });
    if (!cliente) throw new NotFoundException('Cliente no encontrado');
    return cliente;
  }

  /** El cliente, 404 si no existe y 409 si ya cerró (para tocarle mesa o deuda). */
  async obtenerAbierto(tx: Prisma.TransactionClient, restauranteId: string, id: string) {
    const cliente = await this.obtenerCliente(tx, restauranteId, id);
    if (cliente.cerradoEn) {
      throw new ConflictException('Ese cliente ya cerró su cuenta: reábrelo para anotarle consumo');
    }
    return cliente;
  }

  // ═════════════════════════ Abrir ═════════════════════════

  /**
   * Abre un cliente (INSERT: no necesita autor). Lo usan `POST /clientes`,
   * sentar una reserva, el check-in por QR y reasignar a un cliente nuevo.
   * `fecha_operativa` sale de la hora de corte, nunca de TypeScript.
   */
  async abrir(
    tx: Prisma.TransactionClient,
    restauranteId: string,
    d: { nombre: string; mesaId?: string | null; reservacionId?: string | null; creadoPorId?: string | null },
    opciones: { validarMesa: boolean } = { validarMesa: true },
  ) {
    if (d.mesaId && opciones.validarMesa) await this.resolverAsiento(tx, restauranteId, d.mesaId);
    const restaurante = await tx.restaurante.findFirstOrThrow({ where: { id: restauranteId } });
    const { fechaOperativa } = await this.diaOperativo.resolver(restaurante.zonaHoraria, restaurante.horaCorteDia);
    return tx.cliente.create({
      data: {
        id: nuevoId(),
        restauranteId,
        nombre: d.nombre.trim(),
        mesaId: d.mesaId ?? null,
        reservacionId: d.reservacionId ?? null,
        fechaOperativa,
        creadoPorId: d.creadoPorId ?? null,
      },
    });
  }

  crear(restauranteId: string, usuarioId: string, dto: { nombre: string; mesaId?: string }) {
    return this.abrir(this.prisma, restauranteId, { ...dto, creadoPorId: usuarioId });
  }

  // ═════════════════════════ Lectura ═════════════════════════

  /** Clientes abiertos con su cuenta (`v_cuenta_cliente`), por orden de llegada. */
  listar(restauranteId: string, filtros: { mesaId?: string; sinMesa?: boolean }) {
    const porMesa = filtros.mesaId ? Prisma.sql`AND "mesa_id" = ${filtros.mesaId}::uuid` : Prisma.empty;
    const sinMesa = filtros.sinMesa ? Prisma.sql`AND "mesa_id" IS NULL` : Prisma.empty;
    return this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT * FROM v_cuenta_cliente
       WHERE restaurante_id = ${restauranteId}::uuid ${porMesa} ${sinMesa}
       ORDER BY ocupada_desde ASC
    `);
  }

  /**
   * Quién debe algo. `soloCobrable`: sólo lo ya despachado (el menú del cajero,
   * `GET /cuentas-por-cobrar`); si no, todo lo que le consta al cliente, también
   * lo que sigue en cocina (`GET /clientes/deudas`).
   */
  deudas(restauranteId: string, soloCobrable: boolean) {
    const condicion = soloCobrable ? Prisma.sql`total_por_cobrar > 0` : Prisma.sql`cuenta_total > 0`;
    return this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT * FROM v_cuenta_cliente
       WHERE restaurante_id = ${restauranteId}::uuid AND ${condicion}
       ORDER BY ocupada_desde ASC
    `);
  }

  /**
   * GET /clientes/:id — la cuenta: el resumen de `v_cuenta_cliente`, las líneas
   * que debe (con su comanda) y sus facturas. `cuenta` es null si ya cerró
   * (la vista sólo lista clientes abiertos); las líneas y facturas siguen.
   */
  async cuenta(restauranteId: string, id: string) {
    const cliente = await this.obtenerCliente(this.prisma, restauranteId, id);

    const [filaCuenta] = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM v_cuenta_cliente
       WHERE restaurante_id = ${restauranteId}::uuid AND cliente_id = ${id}::uuid
    `;

    const lineas = await this.prisma.comandaItem.findMany({
      where: { restauranteId, clienteId: id, cobroId: null, canceladoEn: null, comanda: { anuladaEn: null } },
      include: {
        comanda: {
          select: { id: true, numeroDia: true, estado: true, tipo: true, mesaId: true, creadaEn: true, despachadaEn: true },
        },
      },
      orderBy: [{ comanda: { creadaEn: 'asc' } }, { orden: 'asc' }, { creadoEn: 'asc' }],
    });

    const facturas = await this.prisma.cobro.findMany({
      where: { restauranteId, clienteId: id },
      select: {
        id: true, numeroDia: true, fechaOperativa: true, clienteNombre: true, subtotal: true, descuento: true,
        propina: true, total: true, totalBs: true, cobradoEn: true, anuladoEn: true,
      },
      orderBy: { cobradoEn: 'asc' },
    });

    return { cliente, cuenta: filaCuenta ?? null, lineas, facturas };
  }

  /** GET /mesas/:mesaId/cuenta — quiénes están sentados en la mesa, con su cuenta. */
  async cuentaDeMesa(restauranteId: string, mesaId: string) {
    const mesa = await this.prisma.mesa.findFirst({ where: { restauranteId, id: mesaId } });
    if (!mesa) throw new NotFoundException('Mesa no encontrada');
    const clientes = await this.listar(restauranteId, { mesaId });
    return { mesa, clientes };
  }

  // ═════════════════════════ Mesa ═════════════════════════

  /**
   * POST /clientes/:id/sentar — sienta (si no tenía mesa) o MUEVE (si ya tenía)
   * al cliente. Sus comandas que siguen en cocina se mudan con él; las ya
   * despachadas conservan la mesa donde se sirvieron.
   */
  async sentar(restauranteId: string, usuarioId: string, id: string, mesaId: string) {
    return this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, usuarioId);
      await this.obtenerAbierto(tx, restauranteId, id);
      const { salonId, plantillaId } = await this.resolverAsiento(tx, restauranteId, mesaId);

      await tx.comanda.updateMany({
        where: { restauranteId, clienteId: id, despachadaEn: null, anuladaEn: null, tipo: 'mesa' },
        data: { mesaId, salonId, plantillaId },
      });
      return tx.cliente.update({ where: { id }, data: { mesaId } });
    });
  }

  /** POST /clientes/:id/liberar — se levanta de la mesa; sigue abierto (y debiendo, si debe). */
  async liberar(restauranteId: string, usuarioId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, usuarioId);
      await this.obtenerAbierto(tx, restauranteId, id);
      await tx.comanda.updateMany({
        where: { restauranteId, clienteId: id, despachadaEn: null, anuladaEn: null, tipo: 'mesa' },
        data: { mesaId: null, salonId: null, plantillaId: null },
      });
      return tx.cliente.update({ where: { id }, data: { mesaId: null } });
    });
  }

  // ═════════════════════════ Cerrar / reabrir ═════════════════════════

  /** Lo que el cliente debe: líneas vivas sin factura en comandas no anuladas (incluye lo que sigue en cocina). */
  async deudaDe(tx: Prisma.TransactionClient, restauranteId: string, id: string) {
    const [deuda] = await tx.$queryRaw<{ lineas: number; monto: Prisma.Decimal }[]>`
      SELECT count(*)::int AS lineas, coalesce(sum(ci."total_linea"), 0) AS monto
        FROM "comanda_item" ci
        JOIN "comanda" c ON c."restaurante_id" = ci."restaurante_id" AND c."id" = ci."comanda_id"
       WHERE ci."restaurante_id" = ${restauranteId}::uuid
         AND ci."cliente_id"     = ${id}::uuid
         AND ci."cobro_id"     IS NULL
         AND ci."cancelado_en" IS NULL
         AND c."anulada_en"    IS NULL
    `;
    return deuda;
  }

  /**
   * Cierra un cliente (dentro de una transacción que ya fijó el autor): no
   * puede deber nada, ni lo que sigue en cocina. Si venía de una reserva
   * `sentada`, la pasa a `completada`. El trigger `cliente_cierre_sin_deuda` es
   * la garantía real (también ante la carrera con una línea nueva); esto da el
   * 409 con el mensaje del dominio.
   */
  async cerrarEnTx(tx: Prisma.TransactionClient, restauranteId: string, id: string, usuarioId: string) {
    const cliente = await this.obtenerAbierto(tx, restauranteId, id);

    const deuda = await this.deudaDe(tx, restauranteId, id);
    if (deuda.lineas > 0) {
      throw new ConflictException(
        `${cliente.nombre} todavía debe ${deuda.lineas} línea(s) por ${new Prisma.Decimal(deuda.monto).toFixed(2)} USD: cóbralas, reasígnalas o cancélalas antes de cerrarlo`,
      );
    }

    const cerrado = await tx.cliente.update({ where: { id }, data: { cerradoEn: new Date(), cerradoPorId: usuarioId } });
    if (cliente.reservacionId) {
      await tx.reservacion.updateMany({
        where: { restauranteId, id: cliente.reservacionId, estado: 'sentada' },
        data: { estado: 'completada' },
      });
    }
    return cerrado;
  }

  /** POST /clientes/:id/cerrar */
  cerrar(restauranteId: string, usuarioId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, usuarioId);
      return this.cerrarEnTx(tx, restauranteId, id, usuarioId);
    });
  }

  /** POST /clientes/:id/reabrir — para anotarle consumo a quien ya cerró. */
  async reabrir(restauranteId: string, usuarioId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, usuarioId);
      const cliente = await this.obtenerCliente(tx, restauranteId, id);
      if (!cliente.cerradoEn) throw new ConflictException('Ese cliente ya está abierto');
      return tx.cliente.update({ where: { id }, data: { cerradoEn: null, cerradoPorId: null } });
    });
  }

  // ═════════════════════════ Reasignar deuda ═════════════════════════

  /**
   * POST /clientes/:id/reasignar — pasa líneas SIN FACTURA (incluso lo que sigue
   * en cocina) a otro cliente existente o a uno nuevo con otro nombre. Una
   * `cantidad` parcial parte la línea. "Facturar a otro nombre" NO es esto: es
   * `clienteNombre` al cobrar.
   */
  async reasignar(restauranteId: string, usuarioId: string, origenId: string, dto: ReasignarLineasDto) {
    if (!!dto.clienteDestinoId === !!dto.nuevoCliente) {
      throw new BadRequestException('Indica clienteDestinoId o nuevoCliente (uno solo de los dos)');
    }
    if (dto.clienteDestinoId === origenId) throw new BadRequestException('El cliente destino es el mismo de origen');
    const ids = idsDeSeleccion(dto.lineas);

    return this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, usuarioId);
      const origen = await this.obtenerCliente(tx, restauranteId, origenId);

      const destino = dto.clienteDestinoId
        ? await this.obtenerAbierto(tx, restauranteId, dto.clienteDestinoId)
        : await this.abrir(
            tx,
            restauranteId,
            {
              nombre: dto.nuevoCliente!.nombre,
              mesaId: dto.nuevoCliente!.mesaId ?? origen.mesaId,
              creadoPorId: usuarioId,
            },
            // Heredar la mesa del origen no se revalida: ya estaba sentado ahí.
            { validarMesa: !!dto.nuevoCliente!.mesaId },
          );

      const bloqueadas = await bloquearLineas(tx, restauranteId, origenId, ids, false);
      const elegidas = elegirLineas(bloqueadas, dto.lineas);

      const lineas: Prisma.ComandaItemGetPayload<object>[] = [];
      for (const e of elegidas) {
        lineas.push(
          e.parcial
            ? await partirLinea(tx, restauranteId, e, { clienteId: destino.id })
            : await tx.comandaItem.update({ where: { id: e.linea.id }, data: { clienteId: destino.id } }),
        );
      }
      return { origenId, destino, lineas };
    });
  }
}
