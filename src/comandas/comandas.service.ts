import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { DiaOperativoService } from '../comun/dia-operativo/dia-operativo.service';
import { fijarAutor } from '../comun/prisma/autor';
import { nuevoId } from '../comun/id';
import { Prisma } from '../generated/prisma/client';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { ClientesService } from '../clientes/clientes.service';
import { AgregarItemsDto, CrearComandaDto } from './dto/comanda.dto';
import { crearLineas, redondear4, siguienteOrden } from './lineas';

/**
 * Comandas: el PEDIDO (lo que se manda a cocina de una vez y sale de una vez).
 *
 *   · Es de un CLIENTE. La mesa de la comanda es la foto de dónde estaba
 *     sentado al pedir; un cliente sin mesa también pide.
 *   · `comanda.estado` y `comanda.total` son DERIVADOS de las líneas por el
 *     trigger `comanda_estado`. Aquí nunca se escriben: se escriben los hechos
 *     (`despachadaEn`, `anuladaEn`, las líneas) y la base deriva la palabra.
 *   · Las líneas se pueden agregar, cambiar y cancelar también DESPUÉS del
 *     despacho (docs/DECISIONES-DATOS.md §15.2). Una línea agregada a una
 *     comanda ya despachada NO vuelve a cocina: se considera servida y queda
 *     como deuda del cliente. Las líneas ya FACTURADAS se corrigen con la
 *     factura (`CobrosService.corregir`), no desde aquí.
 *   · El cobro vive en `CobrosService`; la cuenta del cliente en `ClientesService`.
 */
@Injectable()
export class ComandasService {
  private readonly logger = new Logger(ComandasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly diaOperativo: DiaOperativoService,
    private readonly notificaciones: NotificacionesService,
    private readonly clientes: ClientesService,
  ) {}

  // ═════════════════════════ Lectura ═════════════════════════

  /**
   * GET /despacho/cola — la cola del KDS: global, FIFO estricto, con las líneas
   * embebidas en jsonb para que la pantalla no haga un N+1 cada pocos segundos.
   */
  colaDespacho(restauranteId: string) {
    return this.prisma.$queryRaw`
      SELECT * FROM v_cola_despacho
       WHERE restaurante_id = ${restauranteId}::uuid
       ORDER BY creada_en ASC
    `;
  }

  async obtenerConDetalle(restauranteId: string, id: string) {
    const comanda = await this.prisma.comanda.findFirst({
      where: { restauranteId, id },
      include: {
        items: { orderBy: [{ orden: 'asc' }, { creadoEn: 'asc' }] },
        mesa: true,
        cliente: { select: { id: true, nombre: true, mesaId: true, cerradoEn: true } },
      },
    });
    if (!comanda) throw new NotFoundException('Comanda no encontrada');
    return comanda;
  }

  // ═════════════════════════ Escritura ═════════════════════════

  /** La comanda existe y no está anulada (una anulada ya no se toca). 404 / 409. */
  private async requerirEditable(tx: Prisma.TransactionClient, restauranteId: string, id: string) {
    const comanda = await tx.comanda.findFirst({ where: { restauranteId, id } });
    if (!comanda) throw new NotFoundException('Comanda no encontrada');
    if (comanda.anuladaEn) throw new ConflictException('Esa comanda está anulada');
    return comanda;
  }

  /** Una línea que se puede editar desde la comanda: viva y SIN factura (las facturadas se corrigen con su factura). */
  private async requerirLineaSinFactura(
    tx: Prisma.TransactionClient,
    restauranteId: string,
    comandaId: string,
    itemId: string,
  ) {
    const item = await tx.comandaItem.findFirst({ where: { restauranteId, comandaId, id: itemId } });
    if (!item) throw new NotFoundException('Ítem no encontrado');
    if (item.canceladoEn) throw new ConflictException('Ese ítem ya está anulado');
    if (item.cobroId) {
      throw new ConflictException(
        `Esa línea ya está facturada: corrígela con la factura (POST /cobros/${item.cobroId}/corregir)`,
      );
    }
    return item;
  }

  /**
   * POST /comandas — el pedido nace YA en la cola de despacho, con sus líneas,
   * en UNA transacción. Cada envío a cocina es una comanda nueva: "crear" y
   * "enviar" son el mismo acto, y un cliente que pide tres veces genera tres
   * comandas vivas.
   *
   * Mesa, salón y distribución son la FOTO de donde está sentado el cliente
   * ahora (mesa viva, distribución activa, no bloqueada). Sin mesa, la comanda
   * queda sin mesa. `para_llevar` nunca lleva mesa.
   */
  async crearComanda(restauranteId: string, meseroId: string, dto: CrearComandaDto) {
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });
    const tipo = dto.tipo ?? 'mesa';

    const comanda = await this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, meseroId);

      const cliente = await this.clientes.obtenerAbierto(tx, restauranteId, dto.clienteId);

      let mesaId: string | null = null;
      let salonId: string | null = null;
      let plantillaId: string | null = null;
      if (tipo === 'mesa' && cliente.mesaId) {
        const asiento = await this.clientes.resolverAsiento(tx, restauranteId, cliente.mesaId);
        mesaId = cliente.mesaId;
        salonId = asiento.salonId;
        plantillaId = asiento.plantillaId;
      }

      const { fechaOperativa, turno } = await this.diaOperativo.resolver(
        restaurante.zonaHoraria,
        restaurante.horaCorteDia,
      );

      // UPSERT atómico del número visible del pedido: nunca MAX()+1, que
      // duplica números en cuanto entran dos meseros a la vez.
      const contador = await tx.$queryRaw<{ ultimo_comanda: number }[]>`
        INSERT INTO contador_dia (restaurante_id, fecha_operativa, ultimo_comanda, ultimo_cobro)
        VALUES (${restauranteId}::uuid, ${fechaOperativa}::date, 1, 0)
        ON CONFLICT (restaurante_id, fecha_operativa)
        DO UPDATE SET ultimo_comanda = contador_dia.ultimo_comanda + 1
        RETURNING ultimo_comanda
      `;

      const comandaId = nuevoId();
      // `estado` y `total` no se mandan: los deriva el trigger `comanda_estado`.
      await tx.comanda.create({
        data: {
          id: comandaId,
          restauranteId,
          tipo,
          clienteId: cliente.id,
          salonId,
          mesaId,
          plantillaId,
          reservacionId: cliente.reservacionId,
          numeroDia: contador[0].ultimo_comanda,
          fechaOperativa,
          turno,
          comensales: dto.comensales ?? 1,
          meseroId,
          notas: dto.notas,
        },
      });

      await crearLineas(tx, restauranteId, comandaId, cliente.id, dto.items, 0);

      return tx.comanda.findFirstOrThrow({
        where: { id: comandaId },
        include: {
          items: { orderBy: { orden: 'asc' } },
          cliente: { select: { id: true, nombre: true, mesaId: true, cerradoEn: true } },
        },
      });
    });

    // Aviso por push, DESPUÉS del commit y SIN esperar el abanico completo:
    // un envío HTTP lento dentro de la transacción mantendría bloqueos abiertos.
    // Un fallo de push jamás tumba la comanda, que ya quedó guardada.
    this.notificaciones
      .notificarComandaNueva(restauranteId, comanda)
      .catch((error) => this.logger.error('Fallo notificando comanda nueva por push', error));

    return comanda;
  }

  /**
   * POST /comandas/:id/items — agrega líneas. Con la comanda pendiente van a
   * cocina con ella; con la comanda ya despachada (o cobrada) NO vuelven a
   * cocina: quedan como deuda del cliente de la comanda (si ya cerró, 409:
   * hay que reabrirlo).
   */
  async agregarItems(restauranteId: string, usuarioId: string, comandaId: string, dto: AgregarItemsDto) {
    return this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, usuarioId);
      const comanda = await this.requerirEditable(tx, restauranteId, comandaId);
      await this.clientes.obtenerAbierto(tx, restauranteId, comanda.clienteId);
      const orden = await siguienteOrden(tx, restauranteId, comandaId);
      return crearLineas(tx, restauranteId, comandaId, comanda.clienteId, dto.items, orden);
    });
  }

  /** PATCH /comandas/:id/items/:itemId — cantidad y/o nota de una línea sin factura. */
  async actualizarItem(
    restauranteId: string,
    usuarioId: string,
    comandaId: string,
    itemId: string,
    dto: { cantidad?: number; nota?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, usuarioId);
      await this.requerirEditable(tx, restauranteId, comandaId);
      const item = await this.requerirLineaSinFactura(tx, restauranteId, comandaId, itemId);

      const cantidad = dto.cantidad !== undefined ? new Prisma.Decimal(dto.cantidad) : item.cantidad;
      return tx.comandaItem.update({
        where: { id: itemId },
        data: {
          cantidad,
          totalLinea: redondear4(item.precioUnitarioSnap.mul(cantidad).minus(item.descuentoLinea)),
          nota: dto.nota ?? item.nota,
        },
      });
    });
  }

  /**
   * DELETE /comandas/:id/items/:itemId — anula UNA línea sin factura. No borra:
   * `cancelado_en` deja la traza, y el ticket reimpreso la muestra.
   */
  async cancelarItem(restauranteId: string, usuarioId: string, comandaId: string, itemId: string, motivo: string) {
    return this.prisma.$transaction(async (tx) => {
      await fijarAutor(tx, usuarioId, motivo);
      await this.requerirEditable(tx, restauranteId, comandaId);
      await this.requerirLineaSinFactura(tx, restauranteId, comandaId, itemId);
      await tx.comandaItem.update({
        where: { id: itemId },
        data: { canceladoEn: new Date(), motivoCancelacion: motivo, canceladoPorId: usuarioId },
      });
    });
  }

  /**
   * POST /comandas/:id/despachar — la cocina sacó el pedido: sale de la cola y
   * sus líneas pasan a ser cobrables. NO se borra nada.
   *
   * El `updateMany` con el predicado completo hace segura la doble pulsación de
   * dos pantallas de cocina: la segunda afecta 0 filas y recibe un 409.
   */
  async despachar(restauranteId: string, comandaId: string) {
    const { count } = await this.prisma.comanda.updateMany({
      where: { restauranteId, id: comandaId, despachadaEn: null, anuladaEn: null },
      data: { despachadaEn: new Date() },
    });

    if (count === 0) {
      const comanda = await this.prisma.comanda.findFirst({ where: { restauranteId, id: comandaId } });
      if (!comanda) throw new NotFoundException('Comanda no encontrada');
      throw new ConflictException(comanda.anuladaEn ? 'Esa comanda está anulada' : 'Esa comanda ya se despachó');
    }

    return this.prisma.comanda.findFirstOrThrow({
      where: { id: comandaId },
      include: { items: { orderBy: { orden: 'asc' } } },
    });
  }

  /**
   * POST /comandas/:id/anular — descarta el pedido. Se puede anular una comanda
   * YA DESPACHADA mientras ninguna de sus líneas tenga factura (el plato salió
   * y se devolvió). Con líneas facturadas, primero se corrige la factura:
   * cambiaría el monto de un comprobante emitido (`comanda_anulada_no_cobrada`).
   */
  async anular(restauranteId: string, comandaId: string, motivo: string, anuladaPorId: string) {
    const { count } = await this.prisma.comanda.updateMany({
      where: { restauranteId, id: comandaId, anuladaEn: null, items: { none: { cobroId: { not: null } } } },
      data: { anuladaEn: new Date(), motivoAnulacion: motivo, anuladaPorId },
    });

    if (count === 0) {
      const comanda = await this.prisma.comanda.findFirst({ where: { restauranteId, id: comandaId } });
      if (!comanda) throw new NotFoundException('Comanda no encontrada');
      throw new ConflictException(
        comanda.anuladaEn
          ? 'Esa comanda ya estaba anulada'
          : 'Esa comanda tiene líneas facturadas y no se puede anular: corrige las facturas primero',
      );
    }

    return this.prisma.comanda.findFirstOrThrow({ where: { id: comandaId } });
  }
}
