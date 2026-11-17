import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { DiaOperativoService } from '../comun/dia-operativo/dia-operativo.service';
import { fijarAutor } from '../comun/prisma/autor';
import { nuevoId } from '../comun/id';
import { Prisma } from '../generated/prisma/client';
import { ClientesService } from '../clientes/clientes.service';
import { CobrarClienteDto, CorregirCobroDto } from './dto/comanda.dto';
import { bloquearLineas, crearLineas, elegirLineas, idsDeSeleccion, partirLinea, redondear4, siguienteOrden } from './lineas';

const TOLERANCIA_CUADRE = new Prisma.Decimal('0.01');
const CERO = new Prisma.Decimal(0);

/** Lo que lleva una factura al devolverse: pagos, líneas (con el número de su comanda), cliente y mesa. */
const INCLUDE_COBRO = {
  pagos: { orderBy: { recibidoEn: 'asc' } },
  lineas: {
    include: { comanda: { select: { id: true, numeroDia: true } } },
    orderBy: [{ comanda: { creadaEn: 'asc' } }, { orden: 'asc' }, { creadoEn: 'asc' }],
  },
  cliente: { select: { id: true, nombre: true, mesaId: true, cerradoEn: true } },
  mesa: true,
} satisfies Prisma.CobroInclude;

function exigirReferencias(pagos: { metodo: string; referencia?: string }[]) {
  for (const p of pagos) {
    if ((p.metodo === 'pago_movil' || p.metodo === 'transferencia') && !p.referencia?.trim()) {
      throw new BadRequestException('Pago móvil y transferencia exigen número de referencia');
    }
  }
}

/** Nombre de la factura: presente = manda (vacío → NULL); ausente = el del cliente. */
const nombreDeFactura = (dto: string | null | undefined, delCliente: string) =>
  dto === undefined ? delCliente : dto?.trim() || null;

/**
 * Cobro y facturas.
 *
 * El cobro es del CLIENTE y cubre LÍNEAS (`comanda_item.cobro_id`): dividir la
 * cuenta es elegir qué líneas (o qué parte de una) entran en esta factura. Lo
 * no facturado sigue siendo deuda del mismo cliente (docs/DECISIONES-DATOS.md
 * §15). El servidor calcula la factura entera; la base la verifica al COMMIT
 * (`cobro_coherente`): por eso al cobro recién creado NUNCA se le hace UPDATE
 * en la misma transacción (quedaría en la bitácora como una corrección).
 */
@Injectable()
export class CobrosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly diaOperativo: DiaOperativoService,
    private readonly clientes: ClientesService,
  ) {}

  // ═════════════════════════ Lectura ═════════════════════════

  /** GET /cobros/:id — la factura completa, para reimprimirla. */
  async obtener(restauranteId: string, id: string) {
    const cobro = await this.prisma.cobro.findFirst({ where: { restauranteId, id }, include: INCLUDE_COBRO });
    if (!cobro) throw new NotFoundException('Cobro no encontrado');
    return cobro;
  }

  /**
   * GET /cobros?fecha= — el histórico de facturas de un día operativo, para
   * "Cuentas cobradas" de Ventas. Sin `fecha` = el día operativo en curso.
   *
   * El filtro por `fecha_operativa` va en SQL crudo: es una columna `date` y
   * comparar contra un `Date` de JS arrastra la zona horaria del proceso Node.
   */
  async delDia(restauranteId: string, fecha?: string) {
    let fechaResuelta = fecha;
    if (!fechaResuelta) {
      const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });
      const { fechaOperativa } = await this.diaOperativo.resolver(restaurante.zonaHoraria, restaurante.horaCorteDia);
      fechaResuelta = fechaOperativa.toISOString().slice(0, 10);
    }

    const filas = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM cobro
       WHERE restaurante_id = ${restauranteId}::uuid
         AND fecha_operativa = ${fechaResuelta}::date
       ORDER BY cobrado_en DESC
    `;
    if (filas.length === 0) return [];

    const cobros = await this.prisma.cobro.findMany({
      where: { restauranteId, id: { in: filas.map((f) => f.id) } },
      include: INCLUDE_COBRO,
    });
    // `id: { in }` no respeta el orden: se reordena por el `ORDER BY` de la consulta cruda.
    const porId = new Map(cobros.map((c) => [c.id, c]));
    return filas.map((f) => porId.get(f.id)!);
  }

  // ═════════════════════════ Cobrar ═════════════════════════

  /** La tasa del DÓLAR vigente. `divisa: 'USD'` no es opcional (DECISIONES-DATOS §10.4: el euro es informativo). */
  private async tasaDolar(tx: Prisma.TransactionClient, restauranteId: string) {
    const tasa = await tx.tasaCambio.findFirst({
      where: { restauranteId, divisa: 'USD' },
      orderBy: [{ fecha: 'desc' }, { creadaEn: 'desc' }],
    });
    if (!tasa) throw new BadRequestException('No hay una tasa de cambio registrada; regístrala antes de cobrar');
    return tasa;
  }

  /**
   * POST /clientes/:id/cobrar — emite una factura al cliente por las líneas
   * elegidas (o por todo lo facturable).
   *
   * ⭐ El `FOR UPDATE` de `bloquearLineas` serializa a dos cajeros: el segundo
   * espera, re-evalúa el predicado tras el COMMIT del primero, no ve las líneas
   * (ya tienen `cobro_id`) y recibe 409. La red de último recurso es el
   * constraint trigger diferido `cobro_coherente` (`cobro_no_vacio`).
   *
   * Lo que sigue en cocina nunca entra. Una `cantidad` menor que la de la línea
   * la parte (§15.4): lo no cobrado queda como deuda del mismo cliente.
   */
  async cobrarCliente(restauranteId: string, clienteId: string, dto: CobrarClienteDto, cobradoPorId: string) {
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });
    const ids = idsDeSeleccion(dto.lineas);
    exigirReferencias(dto.pagos);

    return this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, cobradoPorId);

      const cliente = await tx.cliente.findFirst({ where: { restauranteId, id: clienteId } });
      if (!cliente) throw new NotFoundException('Cliente no encontrado');
      const mesa = cliente.mesaId ? await tx.mesa.findFirst({ where: { restauranteId, id: cliente.mesaId } }) : null;

      // ── 1 · Bloquear y elegir las líneas ────────────────────────────────
      const bloqueadas = await bloquearLineas(tx, restauranteId, clienteId, ids, true);
      if (bloqueadas.length === 0) {
        throw new ConflictException('Ese cliente no tiene nada despachado por cobrar (¿ya lo cobró otro cajero?)');
      }
      const elegidas = elegirLineas(bloqueadas, dto.lineas);

      // ── 2 · Totales, calculados en el servidor ──────────────────────────
      const subtotal = elegidas.reduce((acc, e) => acc.add(e.particion.totalLinea), CERO);
      const descuento = new Prisma.Decimal(dto.descuento ?? 0);
      const propina = new Prisma.Decimal(dto.propina ?? 0);
      const impuesto = CERO; // DECISIONES-DATOS §9 A1: el precio ya lo incluye.
      const total = subtotal.minus(descuento).plus(impuesto).plus(propina);
      if (total.lt(0)) throw new BadRequestException('El descuento no puede superar el subtotal');

      // ── 3 · Tasa congelada y pagos que cuadren ──────────────────────────
      const tasa = await this.tasaDolar(tx, restauranteId);
      const enUsd = (p: { moneda: string; monto: number }) => {
        const monto = new Prisma.Decimal(p.monto);
        return p.moneda === 'USD' ? monto : monto.div(tasa.valor);
      };
      const sumaPagosUsd = dto.pagos.reduce((acc, p) => acc.add(enUsd(p)), CERO);
      if (sumaPagosUsd.minus(total).abs().gt(TOLERANCIA_CUADRE)) {
        throw new BadRequestException('Los pagos no cuadran con el total de la cuenta');
      }

      // ── 4 · Día operativo y número de factura (atómico) ─────────────────
      const { fechaOperativa, turno } = await this.diaOperativo.resolver(
        restaurante.zonaHoraria,
        restaurante.horaCorteDia,
      );
      const contador = await tx.$queryRaw<{ ultimo_cobro: number }[]>`
        INSERT INTO contador_dia (restaurante_id, fecha_operativa, ultimo_comanda, ultimo_cobro)
        VALUES (${restauranteId}::uuid, ${fechaOperativa}::date, 0, 1)
        ON CONFLICT (restaurante_id, fecha_operativa)
        DO UPDATE SET ultimo_cobro = contador_dia.ultimo_cobro + 1
        RETURNING ultimo_cobro
      `;

      // ── 5 · La factura, con sus totales FINALES ─────────────────────────
      const cobroId = nuevoId();
      await tx.cobro.create({
        data: {
          id: cobroId,
          restauranteId,
          clienteId,
          mesaId: mesa?.id ?? null,
          salonId: mesa?.salonId ?? null,
          numeroDia: contador[0].ultimo_cobro,
          fechaOperativa,
          turno,
          comensales: Math.max(...elegidas.map((e) => e.linea.comensales)),
          clienteNombre: nombreDeFactura(dto.clienteNombre, cliente.nombre),
          subtotal,
          descuento,
          impuesto,
          propina,
          total,
          tasaId: tasa.id,
          tasaValor: tasa.valor,
          totalBs: redondear4(total.mul(tasa.valor)),
          cobradoPorId,
        },
      });

      // ── 6 · Apuntar las líneas (partiendo las parciales) ────────────────
      for (const e of elegidas) {
        if (e.parcial) await partirLinea(tx, restauranteId, e, { cobroId });
        else await tx.comandaItem.update({ where: { id: e.linea.id }, data: { cobroId } });
      }

      // ── 7 · Los pagos ───────────────────────────────────────────────────
      for (const p of dto.pagos) {
        await tx.cobroPago.create({
          data: {
            id: nuevoId(),
            restauranteId,
            cobroId,
            metodo: p.metodo,
            moneda: p.moneda,
            monto: new Prisma.Decimal(p.monto),
            tasaAplicada: p.moneda === 'BS' ? tasa.valor : null,
            montoUsd: enUsd(p),
            referencia: p.referencia,
            registradoPorId: cobradoPorId,
          },
        });
      }

      // ── 8 · Cerrar al cliente si ya no debe nada y se pidió ─────────────
      if (dto.cerrarCliente && !cliente.cerradoEn) {
        const deuda = await this.clientes.deudaDe(tx, restauranteId, clienteId);
        if (deuda.lineas === 0) await this.clientes.cerrarEnTx(tx, restauranteId, clienteId, cobradoPorId);
      }

      return tx.cobro.findFirstOrThrow({ where: { id: cobroId }, include: INCLUDE_COBRO });
    });
  }

  // ═════════════════════════ Corregir ═════════════════════════

  /**
   * POST /cobros/:id/corregir — corrige una factura ya emitida, de cualquier
   * día (decisión del dueño, §15.3 regla 5): cambiar/anular líneas, agregar
   * líneas, descuento, propina y nombre.
   *
   * El servidor recalcula subtotal, total y total_bs desde las líneas vivas, y
   * la DIFERENCIA con lo ya pagado tiene que venir en `pagos` en la misma
   * transacción: un cobro adicional (+) si subió, una devolución (−) si bajó. El
   * libro de pagos es de sólo agregar: nunca se edita un pago. La devolución en
   * Bs usa la tasa congelada de la factura, y no puede devolver por un método
   * más de lo cobrado por él. Todo queda en la bitácora con autor y `motivo`.
   */
  async corregir(restauranteId: string, cobroId: string, dto: CorregirCobroDto, usuarioId: string) {
    exigirReferencias(dto.pagos ?? []);

    return this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, usuarioId, dto.motivo);

      // Bloquear la factura y sus líneas: dos correcciones a la vez se serializan.
      await tx.$queryRaw`
        SELECT "id" FROM "cobro" WHERE "restaurante_id" = ${restauranteId}::uuid AND "id" = ${cobroId}::uuid FOR UPDATE
      `;
      const cobro = await tx.cobro.findFirst({ where: { restauranteId, id: cobroId } });
      if (!cobro) throw new NotFoundException('Cobro no encontrado');
      if (cobro.anuladoEn) throw new ConflictException('Esa factura está anulada: no se corrige');

      await tx.$queryRaw`
        SELECT "id" FROM "comanda_item" WHERE "restaurante_id" = ${restauranteId}::uuid AND "cobro_id" = ${cobroId}::uuid FOR UPDATE
      `;
      const lineas = new Map(
        (await tx.comandaItem.findMany({ where: { restauranteId, cobroId } })).map((l) => [l.id, l]),
      );

      // ── 1 · Cambios sobre líneas facturadas ─────────────────────────────
      for (const c of dto.cambios ?? []) {
        const linea = lineas.get(c.lineaId);
        if (!linea) throw new NotFoundException(`La línea ${c.lineaId} no pertenece a esta factura`);
        if (linea.canceladoEn) throw new ConflictException(`"${linea.nombreSnap}" ya está anulada`);
        if (!c.anular && c.cantidad === undefined && c.nota === undefined) {
          throw new BadRequestException(`El cambio sobre "${linea.nombreSnap}" no dice qué cambiar`);
        }

        if (c.anular) {
          await tx.comandaItem.update({
            where: { id: linea.id },
            data: { canceladoEn: new Date(), motivoCancelacion: dto.motivo?.trim() || null, canceladoPorId: usuarioId },
          });
        } else {
          const cantidad = c.cantidad === undefined ? linea.cantidad : new Prisma.Decimal(c.cantidad);
          await tx.comandaItem.update({
            where: { id: linea.id },
            data: {
              cantidad,
              totalLinea: redondear4(linea.precioUnitarioSnap.mul(cantidad).minus(linea.descuentoLinea)),
              nota: c.nota ?? linea.nota,
            },
          });
        }
      }

      // ── 2 · Líneas nuevas, directo en la factura ────────────────────────
      for (const a of dto.agregar ?? []) {
        const comanda = await tx.comanda.findFirst({ where: { restauranteId, id: a.comandaId } });
        if (!comanda) throw new NotFoundException(`Comanda ${a.comandaId} no encontrada`);
        if (comanda.anuladaEn) throw new ConflictException('Esa comanda está anulada');
        if (!comanda.despachadaEn) throw new ConflictException('Esa comanda sigue en cocina: todavía no se factura');
        if (comanda.clienteId !== cobro.clienteId) {
          throw new ConflictException('Esa comanda no es del cliente de la factura');
        }
        await crearLineas(
          tx,
          restauranteId,
          comanda.id,
          cobro.clienteId,
          [{ productoId: a.productoId, cantidad: a.cantidad, nota: a.nota }],
          await siguienteOrden(tx, restauranteId, comanda.id),
          cobroId,
        );
      }

      // ── 3 · Recalcular la factura desde sus líneas vivas ────────────────
      const vivas = await tx.comandaItem.findMany({ where: { restauranteId, cobroId, canceladoEn: null } });
      if (vivas.length === 0) {
        throw new ConflictException('La factura se quedaría sin líneas: anúlala en vez de corregirla');
      }
      const subtotal = vivas.reduce((acc, l) => acc.add(l.totalLinea), CERO);
      const descuento = dto.descuento === undefined ? cobro.descuento : new Prisma.Decimal(dto.descuento);
      const propina = dto.propina === undefined ? cobro.propina : new Prisma.Decimal(dto.propina);
      const total = subtotal.minus(descuento).plus(cobro.impuesto).plus(propina);
      if (total.lt(0)) throw new BadRequestException('El descuento no puede superar el subtotal');

      await tx.cobro.update({
        where: { id: cobroId },
        data: {
          subtotal,
          descuento,
          propina,
          total,
          totalBs: redondear4(total.mul(cobro.tasaValor)),
          ...(dto.clienteNombre !== undefined ? { clienteNombre: dto.clienteNombre?.trim() || null } : {}),
        },
      });

      // ── 4 · La diferencia con lo ya pagado, asentada como pagos ─────────
      const pagos = dto.pagos ?? [];
      const yaPagado = await tx.cobroPago.aggregate({ where: { restauranteId, cobroId }, _sum: { montoUsd: true } });
      const diferencia = total.minus(yaPagado._sum.montoUsd ?? CERO);

      const tasa = cobro.tasaValor; // la congelada de la factura, no la del día
      const enUsd = (p: { moneda: string; monto: number }) =>
        p.moneda === 'USD' ? new Prisma.Decimal(p.monto) : new Prisma.Decimal(p.monto).div(tasa);
      const sumaPagosUsd = pagos.reduce((acc, p) => acc.add(enUsd(p)), CERO);
      if (sumaPagosUsd.minus(diferencia).abs().gt(TOLERANCIA_CUADRE)) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          message:
            diferencia.isZero()
              ? 'El total de la factura no cambia: los pagos/devoluciones enviados tienen que netear cero'
              : diferencia.gt(0)
                ? `El total subió ${diferencia.toFixed(4)} USD: registra el cobro adicional`
                : `El total bajó ${diferencia.abs().toFixed(4)} USD: registra la devolución (monto negativo)`,
          diferenciaUsd: diferencia.toFixed(4),
        });
      }

      // No se devuelve por un método más de lo que se cobró por él.
      if (pagos.some((p) => p.monto < 0)) {
        const previos = await tx.cobroPago.groupBy({
          by: ['metodo', 'moneda'],
          where: { restauranteId, cobroId },
          _sum: { monto: true },
        });
        const saldo = new Map(previos.map((g) => [`${g.metodo}/${g.moneda}`, g._sum.monto ?? CERO]));
        for (const p of pagos) {
          const clave = `${p.metodo}/${p.moneda}`;
          saldo.set(clave, (saldo.get(clave) ?? CERO).add(p.monto));
        }
        for (const [clave, monto] of saldo) {
          if (monto.lt(0)) {
            throw new UnprocessableEntityException(`No se puede devolver más de lo cobrado por ${clave.replace('/', ' en ')}`);
          }
        }
      }

      for (const p of pagos) {
        await tx.cobroPago.create({
          data: {
            id: nuevoId(),
            restauranteId,
            cobroId,
            metodo: p.metodo,
            moneda: p.moneda,
            monto: new Prisma.Decimal(p.monto),
            tasaAplicada: p.moneda === 'BS' ? tasa : null,
            montoUsd: enUsd(p),
            referencia: p.referencia,
            registradoPorId: usuarioId,
          },
        });
      }

      return tx.cobro.findFirstOrThrow({ where: { id: cobroId }, include: INCLUDE_COBRO });
    });
  }

  // ═════════════════════════ Anular ═════════════════════════

  /**
   * POST /cobros/:id/anular — anula una factura ya emitida, de cualquier día.
   *
   * Sale de los reportes (todas las vistas filtran `anulado_en IS NULL`) pero
   * las líneas SIGUEN cubiertas por ella: el pedido se sirvió, lo que se
   * deshace es el cobro. Si hay que volver a cobrar, se hace sobre consumo
   * nuevo. Es un UPDATE de `cobro`: queda en la bitácora con autor y motivo.
   */
  async anular(restauranteId: string, cobroId: string, motivo: string, anuladoPorId: string) {
    await this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, anuladoPorId, motivo);
      const { count } = await tx.cobro.updateMany({
        where: { restauranteId, id: cobroId, anuladoEn: null },
        data: { anuladoEn: new Date(), motivoAnulacion: motivo, anuladoPorId },
      });
      if (count === 0) {
        const cobro = await tx.cobro.findFirst({ where: { restauranteId, id: cobroId } });
        if (!cobro) throw new NotFoundException('Cobro no encontrado');
        throw new ConflictException('Ese cobro ya estaba anulado');
      }
    });
    return this.obtener(restauranteId, cobroId);
  }
}
