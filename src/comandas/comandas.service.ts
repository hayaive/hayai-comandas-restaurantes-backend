import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { DiaOperativoService } from '../comun/dia-operativo/dia-operativo.service';
import { nuevoId } from '../comun/id';
import { Prisma } from '../generated/prisma/client';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import {
  AgregarItemsDto,
  CobrarMesaDto,
  CrearComandaDto,
  ItemEntradaDto,
} from './dto/comanda.dto';

const TOLERANCIA_CUADRE = new Prisma.Decimal('0.01');

/**
 * Comandas y cobro.
 *
 * El modelo cambió de raíz en la migración 20260915183000: una comanda dejó de
 * ser "la cuenta de la mesa" y pasó a ser UN pedido, la unidad que la cocina
 * despacha entera. Consecuencias que se notan en todo este archivo:
 *
 *   · Una mesa tiene N comandas vivas. Su cuenta es la suma de todas, y la
 *     resuelve `v_cuenta_mesa`, no una fila de `comanda`.
 *   · `comanda.estado` es DERIVADO por el trigger `comanda_estado`. Aquí nunca
 *     se escribe: se escriben los hechos (`despachadaEn`, `anuladaEn`,
 *     `cobroId`) y la base deriva la palabra.
 *   · El cobro es de la MESA y crea un `Cobro`. Lo que sigue en cocina no se
 *     cobra y arranca la cuenta siguiente de esa mesa.
 *
 * Murieron con el rediseño: `siguienteRonda`, `enviarRonda`,
 * `cambiarEstadoItem`, `pedirCuenta`, `colaCocina` (por ítem) y `cobrar` a
 * nivel de comanda individual.
 */
@Injectable()
export class ComandasService {
  private readonly logger = new Logger(ComandasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly diaOperativo: DiaOperativoService,
    private readonly notificaciones: NotificacionesService,
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

  /** GET /cuentas-por-cobrar — mesas con algo ya despachado esperando pago. */
  cuentasPorCobrar(restauranteId: string) {
    return this.prisma.$queryRaw`
      SELECT * FROM v_cuenta_mesa
       WHERE restaurante_id = ${restauranteId}::uuid
         AND comandas_por_cobrar > 0
       ORDER BY ocupada_desde ASC
    `;
  }

  /**
   * GET /mesas/:mesaId/cuenta — la cuenta viva de una mesa: el resumen de
   * `v_cuenta_mesa` más las comandas que la componen, con sus líneas.
   *
   * Devuelve 200 con `cuenta: null` y `comandas: []` cuando la mesa está libre:
   * "esta mesa no debe nada" es una respuesta, no un 404. El 404 se reserva
   * para una mesa que no existe.
   */
  async cuentaDeMesa(restauranteId: string, mesaId: string) {
    const mesa = await this.prisma.mesa.findFirst({ where: { restauranteId, id: mesaId } });
    if (!mesa) throw new NotFoundException('Mesa no encontrada');

    const [cuenta] = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM v_cuenta_mesa
       WHERE restaurante_id = ${restauranteId}::uuid AND mesa_id = ${mesaId}::uuid
    `;

    const comandas = await this.prisma.comanda.findMany({
      where: { restauranteId, mesaId, cobroId: null, anuladaEn: null },
      include: { items: { orderBy: { orden: 'asc' } } },
      orderBy: { creadaEn: 'asc' },
    });

    return { mesa, cuenta: cuenta ?? null, comandas };
  }

  async obtenerConDetalle(restauranteId: string, id: string) {
    const comanda = await this.prisma.comanda.findFirst({
      where: { restauranteId, id },
      include: {
        items: { orderBy: { orden: 'asc' } },
        mesa: true,
        cobro: { include: { pagos: { orderBy: { recibidoEn: 'asc' } } } },
      },
    });
    if (!comanda) throw new NotFoundException('Comanda no encontrada');
    return comanda;
  }

  /** GET /cobros/:id — la factura completa, para reimprimirla. */
  async obtenerCobro(restauranteId: string, id: string) {
    const cobro = await this.prisma.cobro.findFirst({
      where: { restauranteId, id },
      include: {
        pagos: { orderBy: { recibidoEn: 'asc' } },
        comandas: {
          include: { items: { orderBy: { orden: 'asc' } } },
          orderBy: { creadaEn: 'asc' },
        },
        mesa: true,
      },
    });
    if (!cobro) throw new NotFoundException('Cobro no encontrado');
    return cobro;
  }

  // ═════════════════════════ Escritura de comandas ═════════════════════════

  /**
   * La comanda sólo se puede tocar mientras no la haya sacado la cocina.
   * El trigger `comanda_item_solo_pendiente` es la garantía real; esto existe
   * para dar un 409 con un mensaje del dominio en vez de un 422 genérico.
   */
  private async requerirPendiente(
    restauranteId: string,
    id: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const comanda = await tx.comanda.findFirst({ where: { restauranteId, id } });
    if (!comanda) throw new NotFoundException('Comanda no encontrada');
    if (comanda.estado !== 'pendiente') {
      throw new ConflictException(
        comanda.estado === 'anulada'
          ? 'Esa comanda está anulada'
          : comanda.estado === 'cobrada'
            ? 'Esa comanda ya se cobró: sus líneas no se pueden cambiar'
            : 'Esa comanda ya salió de cocina: sus líneas no se pueden cambiar',
      );
    }
    return comanda;
  }

  /**
   * `comanda.total` es SÓLO la suma de sus líneas vivas. Descuento, impuesto y
   * propina se negocian sobre la cuenta de la mesa y viven en `Cobro`.
   */
  private async recalcularTotal(tx: Prisma.TransactionClient, restauranteId: string, comandaId: string) {
    const items = await tx.comandaItem.findMany({
      where: { restauranteId, comandaId, canceladoEn: null },
    });
    const total = items.reduce((acc, i) => acc.add(i.totalLinea), new Prisma.Decimal(0));
    await tx.comanda.update({ where: { id: comandaId }, data: { total } });
    return total;
  }

  /** Resuelve y valida las líneas contra el menú, con snapshot de nombre y precio. */
  private async construirItems(
    tx: Prisma.TransactionClient,
    restauranteId: string,
    comandaId: string,
    entradas: ItemEntradaDto[],
    ordenInicial: number,
  ) {
    const productos = await tx.producto.findMany({
      where: { restauranteId, id: { in: entradas.map((i) => i.productoId) }, activo: true },
    });
    const porId = new Map(productos.map((p) => [p.id, p]));

    let orden = ordenInicial;
    const creados: Awaited<ReturnType<typeof tx.comandaItem.create>>[] = [];
    for (const entrada of entradas) {
      const producto = porId.get(entrada.productoId);
      if (!producto) throw new NotFoundException(`Producto ${entrada.productoId} no encontrado`);
      if (!producto.disponible) {
        throw new ConflictException(`"${producto.nombre}" no está disponible hoy`);
      }

      const cantidad = new Prisma.Decimal(entrada.cantidad);
      creados.push(
        await tx.comandaItem.create({
          data: {
            id: nuevoId(),
            restauranteId,
            comandaId,
            productoId: producto.id,
            orden: orden++,
            nombreSnap: producto.nombre,
            precioUnitarioSnap: producto.precio,
            destinoSnap: producto.destino,
            cantidad,
            totalLinea: producto.precio.mul(cantidad),
            nota: entrada.nota,
          },
        }),
      );
    }
    return creados;
  }

  /**
   * POST /comandas — el pedido nace YA en la cola de despacho, con sus líneas,
   * en UNA transacción.
   *
   * No hay estado borrador ni `POST /comandas/:id/enviar`: cada envío a cocina
   * es una comanda nueva, así que "crear" y "enviar" son el mismo acto. Una
   * mesa que pide tres veces genera tres comandas, y las tres conviven vivas
   * (ya no existe `comanda_mesa_activa_unica`).
   */
  async crearComanda(restauranteId: string, meseroId: string | null, dto: CrearComandaDto) {
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });

    const comanda = await this.prisma.$transaction(async (tx) => {
      let salonId: string | null = null;
      let plantillaId: string | null = null;

      if (dto.tipo === 'mesa') {
        if (!dto.mesaId) throw new BadRequestException('Una comanda de mesa exige mesaId');
        const mesa = await tx.mesa.findFirst({ where: { restauranteId, id: dto.mesaId, eliminadaEn: null } });
        if (!mesa) throw new NotFoundException('Mesa no encontrada');
        salonId = mesa.salonId;

        const plantillaActiva = await tx.plantilla.findFirst({
          where: { restauranteId, salonId, activa: true },
        });
        if (!plantillaActiva) {
          throw new BadRequestException('El salón de esa mesa no tiene una distribución activa');
        }
        plantillaId = plantillaActiva.id;

        const enPlano = await tx.plantillaMesa.findFirst({
          where: { restauranteId, plantillaId, mesaId: dto.mesaId },
        });
        if (!enPlano) throw new BadRequestException('Esa mesa no está en la distribución activa');
        if (enPlano.bloqueada) throw new ConflictException('Esa mesa está bloqueada');
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
      // `estado` no se manda: lo deriva el trigger `comanda_estado` a partir de
      // los tres timestamps. Recién creada, sin ninguno, queda 'pendiente'.
      await tx.comanda.create({
        data: {
          id: comandaId,
          restauranteId,
          tipo: dto.tipo,
          salonId,
          mesaId: dto.tipo === 'mesa' ? dto.mesaId : null,
          plantillaId,
          reservacionId: dto.reservacionId,
          numeroDia: contador[0].ultimo_comanda,
          fechaOperativa,
          turno,
          comensales: dto.comensales ?? 1,
          meseroId,
          notas: dto.notas,
        },
      });

      await this.construirItems(tx, restauranteId, comandaId, dto.items, 0);
      await this.recalcularTotal(tx, restauranteId, comandaId);

      if (dto.reservacionId) {
        // Idempotente: la segunda comanda de la misma reserva la deja sentada
        // igual. `sentadaEn` sólo se fija la primera vez.
        await tx.reservacion.updateMany({
          where: { restauranteId, id: dto.reservacionId, estado: { in: ['pendiente', 'confirmada'] } },
          data: { estado: 'sentada', sentadaEn: new Date() },
        });
      }

      return tx.comanda.findFirstOrThrow({
        where: { id: comandaId },
        include: { items: { orderBy: { orden: 'asc' } } },
      });
    });

    // Aviso por push, DESPUÉS del commit y SIN esperar el abanico completo:
    // regla dura del diseño de notificaciones — un envío HTTP lento dentro de
    // la transacción mantendría bloqueos abiertos, y esperar aquí demoraría el
    // 201 de cada comanda por el peor `endpoint` de push del momento. Un fallo
    // de push (o que no haya VAPID configurado) jamás tumba la comanda, que ya
    // quedó guardada: por eso el `.catch` en vez de dejar que la excepción
    // se propague o quede como unhandled rejection.
    this.notificaciones
      .notificarComandaNueva(restauranteId, comanda)
      .catch((error) => this.logger.error('Fallo notificando comanda nueva por push', error));

    return comanda;
  }

  /** POST /comandas/:id/items — añadir líneas a un pedido que todavía no salió. */
  async agregarItems(restauranteId: string, comandaId: string, dto: AgregarItemsDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.requerirPendiente(restauranteId, comandaId, tx);

      const existentes = await tx.comandaItem.findMany({ where: { restauranteId, comandaId } });
      const orden = existentes.length > 0 ? Math.max(...existentes.map((i) => i.orden)) + 1 : 0;

      const creados = await this.construirItems(tx, restauranteId, comandaId, dto.items, orden);
      await this.recalcularTotal(tx, restauranteId, comandaId);
      return creados;
    });
  }

  async actualizarItem(
    restauranteId: string,
    comandaId: string,
    itemId: string,
    dto: { cantidad?: number; nota?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.requerirPendiente(restauranteId, comandaId, tx);
      const item = await tx.comandaItem.findFirst({ where: { restauranteId, comandaId, id: itemId } });
      if (!item) throw new NotFoundException('Ítem no encontrado');
      if (item.canceladoEn) throw new ConflictException('Ese ítem ya está anulado');

      const cantidad = dto.cantidad !== undefined ? new Prisma.Decimal(dto.cantidad) : item.cantidad;
      const actualizado = await tx.comandaItem.update({
        where: { id: itemId },
        data: {
          cantidad,
          totalLinea: item.precioUnitarioSnap.mul(cantidad).minus(item.descuentoLinea),
          nota: dto.nota ?? item.nota,
        },
      });

      await this.recalcularTotal(tx, restauranteId, comandaId);
      return actualizado;
    });
  }

  /**
   * DELETE /comandas/:id/items/:itemId — anular UNA línea antes de despachar.
   * No borra: `cancelado_en` deja la traza, y el ticket reimpreso la muestra.
   */
  async cancelarItem(
    restauranteId: string,
    comandaId: string,
    itemId: string,
    motivo: string,
    canceladoPorId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.requerirPendiente(restauranteId, comandaId, tx);
      const item = await tx.comandaItem.findFirst({ where: { restauranteId, comandaId, id: itemId } });
      if (!item) throw new NotFoundException('Ítem no encontrado');

      if (!item.canceladoEn) {
        await tx.comandaItem.update({
          where: { id: itemId },
          data: { canceladoEn: new Date(), motivoCancelacion: motivo, canceladoPorId },
        });
        await this.recalcularTotal(tx, restauranteId, comandaId);
      }
    });
  }

  /**
   * POST /comandas/:id/despachar — la cocina sacó el pedido: sale de la cola y
   * entra en la cuenta cobrable de la mesa. NO se borra nada.
   *
   * El `updateMany` con el predicado completo es lo que hace segura la doble
   * pulsación de dos pantallas de cocina: la segunda afecta 0 filas y recibe un
   * 409, en vez de repisar `despachada_en` y mover el pedido en el histórico.
   */
  async despachar(restauranteId: string, comandaId: string) {
    const { count } = await this.prisma.comanda.updateMany({
      where: { restauranteId, id: comandaId, despachadaEn: null, anuladaEn: null, cobroId: null },
      data: { despachadaEn: new Date() },
    });

    if (count === 0) {
      const comanda = await this.prisma.comanda.findFirst({ where: { restauranteId, id: comandaId } });
      if (!comanda) throw new NotFoundException('Comanda no encontrada');
      throw new ConflictException(
        comanda.anuladaEn ? 'Esa comanda está anulada' : 'Esa comanda ya se despachó',
      );
    }

    return this.prisma.comanda.findFirstOrThrow({
      where: { id: comandaId },
      include: { items: { orderBy: { orden: 'asc' } } },
    });
  }

  /**
   * POST /comandas/:id/anular — descarta el pedido.
   *
   * Se puede anular una comanda YA DESPACHADA mientras no esté cobrada (el
   * plato salió y se devolvió). Lo que no se puede es anular una cobrada: eso
   * cambiaría el monto de una factura emitida, y lo impide además el CHECK
   * `comanda_anulada_no_cobrada`.
   */
  async anular(restauranteId: string, comandaId: string, motivo: string, anuladaPorId: string) {
    const { count } = await this.prisma.comanda.updateMany({
      where: { restauranteId, id: comandaId, anuladaEn: null, cobroId: null },
      data: { anuladaEn: new Date(), motivoAnulacion: motivo, anuladaPorId },
    });

    if (count === 0) {
      const comanda = await this.prisma.comanda.findFirst({ where: { restauranteId, id: comandaId } });
      if (!comanda) throw new NotFoundException('Comanda no encontrada');
      throw new ConflictException(
        comanda.cobroId ? 'Esa comanda ya se cobró y no se puede anular' : 'Esa comanda ya estaba anulada',
      );
    }

    return this.prisma.comanda.findFirstOrThrow({ where: { id: comandaId } });
  }

  /**
   * POST /comandas/:id/mover — pasa UN pedido a otra mesa.
   *
   * ⚠️ Mueve esa comanda, no la cuenta entera: en el modelo nuevo cada comanda
   * pertenece a su mesa por separado. Para mudar a un cliente de mesa con todo
   * lo que lleva consumido hay que mover sus comandas vivas una a una (ver el
   * informe de entrega: queda señalado como endpoint pendiente si la pantalla
   * lo pide como una sola acción).
   */
  async moverComanda(restauranteId: string, comandaId: string, mesaIdDestino: string) {
    return this.prisma.$transaction(async (tx) => {
      const comanda = await tx.comanda.findFirst({ where: { restauranteId, id: comandaId } });
      if (!comanda) throw new NotFoundException('Comanda no encontrada');
      if (comanda.tipo !== 'mesa') throw new BadRequestException('Sólo se pueden mover comandas de mesa');
      if (comanda.cobroId) throw new ConflictException('Esa comanda ya se cobró');
      if (comanda.anuladaEn) throw new ConflictException('Esa comanda está anulada');

      const mesa = await tx.mesa.findFirst({ where: { restauranteId, id: mesaIdDestino, eliminadaEn: null } });
      if (!mesa) throw new NotFoundException('Mesa destino no encontrada');

      const plantillaActiva = await tx.plantilla.findFirst({
        where: { restauranteId, salonId: mesa.salonId, activa: true },
      });
      if (!plantillaActiva) throw new BadRequestException('El salón destino no tiene una distribución activa');

      const enPlano = await tx.plantillaMesa.findFirst({
        where: { restauranteId, plantillaId: plantillaActiva.id, mesaId: mesaIdDestino },
      });
      if (!enPlano) throw new BadRequestException('La mesa destino no está en la distribución activa');
      if (enPlano.bloqueada) throw new ConflictException('La mesa destino está bloqueada');

      return tx.comanda.update({
        where: { id: comandaId },
        data: { mesaId: mesaIdDestino, salonId: mesa.salonId, plantillaId: plantillaActiva.id },
      });
    });
  }

  // ═════════════════════════ Cobro ═════════════════════════

  /**
   * POST /mesas/:mesaId/cobrar — emite la factura de la mesa.
   *
   * ⭐ El `SELECT ... FOR UPDATE` del primer paso NO es opcional y no se puede
   * sustituir por un `findMany` de Prisma. Es lo único que serializa a dos
   * cajeros cobrando la misma mesa a la vez: el segundo se queda esperando el
   * lock, y cuando el primero hace COMMIT re-evalúa el predicado, ve que las
   * comandas ya tienen `cobro_id` y se lleva 0 filas → 409. Sin el lock, los
   * dos leen las mismas comandas, emiten dos facturas parciales y la caja del
   * turno no cuadra.
   *
   * La red de último recurso, por si algún camino futuro no pasara por aquí, es
   * el constraint trigger diferido `cobro_no_vacio`, que revienta en el COMMIT
   * si el cobro no acabó cubriendo ninguna comanda.
   *
   * Lo que sigue en cocina no entra (CHECK `comanda_cobro_tras_despacho`): se
   * queda vivo y arranca la cuenta siguiente de la mesa. Es la regla que
   * confirmó el dueño.
   */
  async cobrarMesa(restauranteId: string, mesaId: string, dto: CobrarMesaDto, cobradoPorId: string) {
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });
    const mesa = await this.prisma.mesa.findFirst({ where: { restauranteId, id: mesaId } });
    if (!mesa) throw new NotFoundException('Mesa no encontrada');

    return this.prisma.$transaction(async (tx) => {
      // ── 1 · Bloquear las comandas cobrables de la mesa ──────────────────
      const filtroIds = dto.comandaIds
        ? Prisma.sql`AND "id" = ANY(${dto.comandaIds}::uuid[])`
        : Prisma.empty;

      const comandas = await tx.$queryRaw<
        { id: string; total: Prisma.Decimal; comensales: number; reservacion_id: string | null }[]
      >(Prisma.sql`
        SELECT "id", "total", "comensales", "reservacion_id"
          FROM "comanda"
         WHERE "restaurante_id" = ${restauranteId}::uuid
           AND "mesa_id"        = ${mesaId}::uuid
           AND "cobro_id"   IS NULL
           AND "anulada_en" IS NULL
           AND "despachada_en" IS NOT NULL
           ${filtroIds}
         ORDER BY "creada_en"
         FOR UPDATE
      `);

      if (comandas.length === 0) {
        throw new ConflictException(
          dto.comandaIds
            ? 'Esas comandas ya se cobraron, no salieron de cocina o no son de esa mesa'
            : 'Esa mesa no tiene nada despachado por cobrar (¿ya la cobró otro cajero?)',
        );
      }
      if (dto.comandaIds && comandas.length !== dto.comandaIds.length) {
        throw new ConflictException(
          'Alguna de las comandas pedidas ya se cobró, sigue en cocina o no es de esa mesa',
        );
      }

      // ── 2 · Totales, calculados en el servidor ──────────────────────────
      const subtotal = comandas.reduce(
        (acc, c) => acc.add(new Prisma.Decimal(c.total)),
        new Prisma.Decimal(0),
      );
      const descuento = new Prisma.Decimal(dto.descuento ?? 0);
      const propina = new Prisma.Decimal(dto.propina ?? 0);
      const impuesto = new Prisma.Decimal(0); // DECISIONES-DATOS §9 A1: el precio ya lo incluye.
      const total = subtotal.minus(descuento).plus(impuesto).plus(propina);
      if (total.lt(0)) throw new BadRequestException('El descuento no puede superar el subtotal');

      // ── 3 · Tasa del DÓLAR, congelada ───────────────────────────────────
      // ⚠️ `divisa: 'USD'` no es opcional: sin él la consulta puede devolver la
      // cotización del EURO y convertir cada bolívar con un 8-15 % de error
      // (DECISIONES-DATOS §10.4). El desempate `creadaEn: 'desc'` es obligatorio
      // cuando conviven varias `fuente` (BCV y Binance) el mismo día (§10.6).
      const tasa = await tx.tasaCambio.findFirst({
        where: { restauranteId, divisa: 'USD' },
        orderBy: [{ fecha: 'desc' }, { creadaEn: 'desc' }],
      });
      if (!tasa) {
        throw new BadRequestException('No hay una tasa de cambio registrada; regístrala antes de cobrar');
      }

      // ── 4 · Los pagos tienen que cuadrar con el total ───────────────────
      const enUsd = (p: { moneda: string; monto: number }) => {
        const monto = new Prisma.Decimal(p.monto);
        return p.moneda === 'USD' ? monto : monto.div(tasa.valor);
      };
      const sumaPagosUsd = dto.pagos.reduce((acc, p) => acc.add(enUsd(p)), new Prisma.Decimal(0));
      if (sumaPagosUsd.minus(total).abs().gt(TOLERANCIA_CUADRE)) {
        throw new BadRequestException('Los pagos no cuadran con el total de la cuenta');
      }
      for (const p of dto.pagos) {
        if ((p.metodo === 'pago_movil' || p.metodo === 'transferencia') && !p.referencia?.trim()) {
          throw new BadRequestException('Pago móvil y transferencia exigen número de referencia');
        }
      }

      // ── 5 · Día operativo y turno DEL COBRO ─────────────────────────────
      // Los del cobro, no los de las comandas: la venta se cuenta cuando entra
      // el dinero, que es lo que tiene que cuadrar con la caja al cerrar turno.
      // Se resuelven con las funciones SQL, nunca en TypeScript.
      const { fechaOperativa, turno } = await this.diaOperativo.resolver(
        restaurante.zonaHoraria,
        restaurante.horaCorteDia,
      );

      // ── 6 · Número de factura del día, atómico ──────────────────────────
      const contador = await tx.$queryRaw<{ ultimo_cobro: number }[]>`
        INSERT INTO contador_dia (restaurante_id, fecha_operativa, ultimo_comanda, ultimo_cobro)
        VALUES (${restauranteId}::uuid, ${fechaOperativa}::date, 0, 1)
        ON CONFLICT (restaurante_id, fecha_operativa)
        DO UPDATE SET ultimo_cobro = contador_dia.ultimo_cobro + 1
        RETURNING ultimo_cobro
      `;

      // ── 7 · La factura ──────────────────────────────────────────────────
      const cobroId = nuevoId();
      await tx.cobro.create({
        data: {
          id: cobroId,
          restauranteId,
          mesaId,
          salonId: mesa.salonId,
          numeroDia: contador[0].ultimo_cobro,
          fechaOperativa,
          turno,
          // La mesa tiene UN número de comensales: si creció durante la noche,
          // manda el mayor de las comandas que se están cobrando.
          comensales: Math.max(...comandas.map((c) => c.comensales)),
          subtotal,
          descuento,
          impuesto,
          propina,
          total,
          tasaId: tasa.id,
          tasaValor: tasa.valor,
          totalBs: total.mul(tasa.valor),
          cobradoPorId,
        },
      });

      // ── 8 · Liquidar las comandas bloqueadas ────────────────────────────
      const ids = comandas.map((c) => c.id);
      const liquidadas = await tx.comanda.updateMany({
        where: { restauranteId, id: { in: ids }, cobroId: null },
        data: { cobroId },
      });
      if (liquidadas.count !== ids.length) {
        // Inalcanzable con el FOR UPDATE de §1; si pasara, abortar antes de
        // dejar una factura cobrando menos de lo que dice.
        throw new ConflictException('La cuenta cambió mientras se cobraba; vuelve a intentarlo');
      }

      // ── 9 · Los pagos ───────────────────────────────────────────────────
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

      // ── 10 · Cerrar las reservaciones que quedaron servidas ─────────────
      // Candidatas: las que originaron las comandas cobradas, MÁS cualquiera que
      // siga `sentada` en esta mesa. Las segundas importan porque desde que el
      // check-in dejó de abrir comanda, una reserva sentada ocupa la mesa por sí
      // sola (`v_mesa_estado`): si el mesero tomó la nota sin pasar
      // `reservacionId`, nada la ataría al cobro y la mesa se quedaría ocupada
      // para siempre en el plano aunque el cliente ya pagó y se fue.
      const candidatas = new Set(comandas.map((c) => c.reservacion_id).filter(Boolean) as string[]);
      for (const r of await tx.reservacion.findMany({
        where: { restauranteId, mesaId, estado: 'sentada' },
        select: { id: true },
      })) {
        candidatas.add(r.id);
      }

      if (candidatas.size > 0) {
        // Sólo se cierran si a la MESA no le queda ninguna comanda viva: si
        // sigue habiendo algo en cocina, la gente sigue sentada y su cuenta
        // nueva ya arrancó.
        const vivas = await tx.comanda.count({
          where: { restauranteId, mesaId, cobroId: null, anuladaEn: null },
        });
        if (vivas === 0) {
          await tx.reservacion.updateMany({
            where: { restauranteId, id: { in: [...candidatas] }, estado: 'sentada' },
            data: { estado: 'completada' },
          });
        }
      }

      return tx.cobro.findFirstOrThrow({
        where: { id: cobroId },
        include: {
          pagos: { orderBy: { recibidoEn: 'asc' } },
          comandas: { include: { items: { orderBy: { orden: 'asc' } } }, orderBy: { creadaEn: 'asc' } },
        },
      });
    });
  }

  /**
   * POST /cobros/:id/anular — anula una factura ya emitida.
   *
   * Sale de los reportes (todas las vistas filtran `anulado_en IS NULL`) pero
   * las comandas SIGUEN cubiertas por ella: el pedido salió y se sirvió, lo que
   * se está deshaciendo es el cobro, no el consumo. Por eso la mesa no vuelve a
   * aparecer ocupada ni la cuenta se reabre; si hay que volver a cobrar, se
   * emite una factura nueva sobre comandas nuevas.
   */
  async anularCobro(restauranteId: string, cobroId: string, motivo: string, anuladoPorId: string) {
    const { count } = await this.prisma.cobro.updateMany({
      where: { restauranteId, id: cobroId, anuladoEn: null },
      data: { anuladoEn: new Date(), motivoAnulacion: motivo, anuladoPorId },
    });

    if (count === 0) {
      const cobro = await this.prisma.cobro.findFirst({ where: { restauranteId, id: cobroId } });
      if (!cobro) throw new NotFoundException('Cobro no encontrado');
      throw new ConflictException('Ese cobro ya estaba anulado');
    }

    return this.obtenerCobro(restauranteId, cobroId);
  }
}
