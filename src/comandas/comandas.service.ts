import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { DiaOperativoService } from '../comun/dia-operativo/dia-operativo.service';
import { nuevoId } from '../comun/id';
import { Prisma } from '../generated/prisma/client';
import { EstadoComandaItem } from '../generated/prisma/enums';
import {
  AgregarItemsDto,
  CobrarDto,
  ItemEntradaDto,
} from './dto/comanda.dto';

const ESTADOS_ABIERTOS = ['abierta', 'por_cobrar'] as const;
const TOLERANCIA_CUADRE = new Prisma.Decimal('0.01');

@Injectable()
export class ComandasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly diaOperativo: DiaOperativoService,
  ) {}

  listarActivas(restauranteId: string) {
    return this.prisma.$queryRaw`
      SELECT * FROM v_comanda_activa
       WHERE restaurante_id = ${restauranteId}::uuid
       ORDER BY abierta_en ASC
    `;
  }

  async obtenerConDetalle(restauranteId: string, id: string) {
    const comanda = await this.prisma.comanda.findFirst({
      where: { restauranteId, id },
      include: {
        items: { orderBy: [{ ronda: 'asc' }, { orden: 'asc' }] },
        pagos: { orderBy: { recibidoEn: 'asc' } },
        mesa: true,
      },
    });
    if (!comanda) throw new NotFoundException('Comanda no encontrada');
    return comanda;
  }

  private async requerirComandaAbierta(restauranteId: string, id: string, tx: Prisma.TransactionClient = this.prisma) {
    const comanda = await tx.comanda.findFirst({ where: { restauranteId, id } });
    if (!comanda) throw new NotFoundException('Comanda no encontrada');
    if (!ESTADOS_ABIERTOS.includes(comanda.estado as any)) {
      throw new ConflictException('La comanda ya está cerrada');
    }
    return comanda;
  }

  /** CONTRACT.md §3.1 — abrir comanda en una mesa (o para llevar), en una transacción. */
  async abrirComanda(
    restauranteId: string,
    meseroId: string | null,
    dto: { tipo: string; mesaId?: string; comensales?: number; reservacionId?: string },
  ) {
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });

    return this.prisma.$transaction(async (tx) => {
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

      // UPSERT atómico del número visible (CONTRACT.md §3.1 paso 2): nunca MAX()+1.
      const contador = await tx.$queryRaw<{ ultimo: number }[]>`
        INSERT INTO contador_comanda (restaurante_id, fecha_operativa, ultimo)
        VALUES (${restauranteId}::uuid, ${fechaOperativa}::date, 1)
        ON CONFLICT (restaurante_id, fecha_operativa)
        DO UPDATE SET ultimo = contador_comanda.ultimo + 1
        RETURNING ultimo
      `;
      const numeroDia = contador[0].ultimo;

      const comanda = await tx.comanda.create({
        data: {
          id: nuevoId(),
          restauranteId,
          tipo: dto.tipo as any,
          salonId,
          mesaId: dto.tipo === 'mesa' ? dto.mesaId : null,
          plantillaId,
          reservacionId: dto.reservacionId,
          numeroDia,
          fechaOperativa,
          turno,
          comensales: dto.comensales ?? 1,
          meseroId,
          estado: 'abierta',
        },
      });

      if (dto.reservacionId) {
        await tx.reservacion.update({
          where: { id: dto.reservacionId },
          data: { estado: 'sentada', sentadaEn: new Date() },
        });
      }

      return comanda;
    });
  }

  private siguienteRonda(items: { ronda: number; estado: string }[]): number {
    const pendientes = items.filter((i) => i.estado === 'pendiente');
    if (pendientes.length > 0) return Math.max(...pendientes.map((i) => i.ronda));
    const maxRonda = items.length > 0 ? Math.max(...items.map((i) => i.ronda)) : 0;
    return maxRonda + 1;
  }

  private async recalcularTotales(tx: Prisma.TransactionClient, restauranteId: string, comandaId: string) {
    const items = await tx.comandaItem.findMany({
      where: { restauranteId, comandaId, estado: { not: 'cancelado' } },
    });
    const subtotal = items.reduce((acc, i) => acc.add(i.totalLinea), new Prisma.Decimal(0));
    const comanda = await tx.comanda.findFirstOrThrow({ where: { id: comandaId } });
    const total = subtotal
      .minus(comanda.descuento)
      .plus(comanda.impuesto)
      .plus(comanda.propina);
    await tx.comanda.update({ where: { id: comandaId }, data: { subtotal, total: total.lt(0) ? 0 : total } });
  }

  async agregarItems(restauranteId: string, comandaId: string, dto: AgregarItemsDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.requerirComandaAbierta(restauranteId, comandaId, tx);

      const productoIds = dto.items.map((i) => i.productoId);
      const productos = await tx.producto.findMany({
        where: { restauranteId, id: { in: productoIds }, activo: true },
      });
      const porId = new Map(productos.map((p) => [p.id, p]));

      const existentes = await tx.comandaItem.findMany({ where: { restauranteId, comandaId } });
      const ronda = this.siguienteRonda(existentes);
      let orden = existentes.length > 0 ? Math.max(...existentes.map((i) => i.orden)) + 1 : 0;

      const creados: Awaited<ReturnType<typeof tx.comandaItem.create>>[] = [];
      for (const entrada of dto.items as ItemEntradaDto[]) {
        const producto = porId.get(entrada.productoId);
        if (!producto) throw new NotFoundException(`Producto ${entrada.productoId} no encontrado`);
        if (!producto.disponible) {
          throw new ConflictException(`"${producto.nombre}" no está disponible hoy`);
        }

        const cantidad = new Prisma.Decimal(entrada.cantidad);
        const totalLinea = producto.precio.mul(cantidad);

        const item = await tx.comandaItem.create({
          data: {
            id: nuevoId(),
            restauranteId,
            comandaId,
            productoId: producto.id,
            ronda,
            orden: orden++,
            nombreSnap: producto.nombre,
            precioUnitarioSnap: producto.precio,
            destinoSnap: producto.destino,
            cantidad,
            totalLinea,
            nota: entrada.nota,
          },
        });
        creados.push(item);
      }

      await this.recalcularTotales(tx, restauranteId, comandaId);
      return creados;
    });
  }

  async actualizarItem(restauranteId: string, comandaId: string, itemId: string, dto: { cantidad?: number; nota?: string }) {
    return this.prisma.$transaction(async (tx) => {
      await this.requerirComandaAbierta(restauranteId, comandaId, tx);
      const item = await tx.comandaItem.findFirst({ where: { restauranteId, comandaId, id: itemId } });
      if (!item) throw new NotFoundException('Ítem no encontrado');
      if (item.estado !== 'pendiente') {
        throw new ConflictException('Ese ítem ya se envió a cocina/barra y no se puede editar');
      }

      const cantidad = dto.cantidad !== undefined ? new Prisma.Decimal(dto.cantidad) : item.cantidad;
      const totalLinea = item.precioUnitarioSnap.mul(cantidad).minus(item.descuentoLinea);

      const actualizado = await tx.comandaItem.update({
        where: { id: itemId },
        data: { cantidad, totalLinea, nota: dto.nota ?? item.nota },
      });

      await this.recalcularTotales(tx, restauranteId, comandaId);
      return actualizado;
    });
  }

  async cancelarItem(
    restauranteId: string,
    comandaId: string,
    itemId: string,
    motivo: string,
    canceladoPorId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.requerirComandaAbierta(restauranteId, comandaId, tx);
      const item = await tx.comandaItem.findFirst({ where: { restauranteId, comandaId, id: itemId } });
      if (!item) throw new NotFoundException('Ítem no encontrado');

      await tx.comandaItem.update({
        where: { id: itemId },
        data: { estado: 'cancelado', motivoCancelacion: motivo, canceladoPorId },
      });

      await this.recalcularTotales(tx, restauranteId, comandaId);
    });
  }

  async cambiarEstadoItem(restauranteId: string, comandaId: string, itemId: string, estado: EstadoComandaItem) {
    const item = await this.prisma.comandaItem.findFirst({ where: { restauranteId, comandaId, id: itemId } });
    if (!item) throw new NotFoundException('Ítem no encontrado');

    const data: Prisma.ComandaItemUpdateInput = { estado };
    if (estado === 'en_preparacion' && !item.enviadoEn) data.enviadoEn = new Date();
    if (estado === 'servido' && !item.servidoEn) data.servidoEn = new Date();

    const actualizado = await this.prisma.comandaItem.update({ where: { id: itemId }, data });
    if (estado === 'cancelado') {
      await this.recalcularTotales(this.prisma, restauranteId, comandaId);
    }
    return actualizado;
  }

  /** CONTRACT.md §3.2 — enviar una ronda a cocina/barra. */
  async enviarRonda(restauranteId: string, comandaId: string, ronda: number) {
    await this.requerirComandaAbierta(restauranteId, comandaId);
    await this.prisma.comandaItem.updateMany({
      where: { restauranteId, comandaId, ronda, estado: 'pendiente' },
      data: { estado: 'en_preparacion', enviadoEn: new Date() },
    });
    return this.prisma.comandaItem.findMany({
      where: { restauranteId, comandaId, ronda },
      orderBy: { orden: 'asc' },
    });
  }

  colaCocina(restauranteId: string, destino: 'cocina' | 'barra') {
    return this.prisma.comandaItem.findMany({
      where: {
        restauranteId,
        destinoSnap: destino,
        estado: { in: ['pendiente', 'en_preparacion'] },
        comanda: { estado: { in: ['abierta', 'por_cobrar'] } },
      },
      include: { comanda: { select: { numeroDia: true, mesaId: true, tipo: true } } },
      orderBy: [{ enviadoEn: 'asc' }, { creadoEn: 'asc' }],
    });
  }

  async moverComanda(restauranteId: string, comandaId: string, mesaIdDestino: string) {
    return this.prisma.$transaction(async (tx) => {
      const comanda = await this.requerirComandaAbierta(restauranteId, comandaId, tx);
      if (comanda.tipo !== 'mesa') throw new BadRequestException('Sólo se pueden mover comandas de mesa');

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

      // Si la mesa destino ya tiene comanda viva, el índice único parcial lo
      // rechaza (23505 → 409, ver PgErrorFilter).
      return tx.comanda.update({
        where: { id: comandaId },
        data: { mesaId: mesaIdDestino, salonId: mesa.salonId, plantillaId: plantillaActiva.id },
      });
    });
  }

  /** POST /comandas/:id/cuenta — pide la cuenta: sigue ocupando la mesa. */
  async pedirCuenta(restauranteId: string, comandaId: string) {
    const comanda = await this.prisma.comanda.findFirst({ where: { restauranteId, id: comandaId } });
    if (!comanda) throw new NotFoundException('Comanda no encontrada');
    if (comanda.estado !== 'abierta') throw new ConflictException('La comanda no está abierta');
    return this.prisma.comanda.update({ where: { id: comandaId }, data: { estado: 'por_cobrar' } });
  }

  /** CONTRACT.md §3.3 — cobrar: recalcula, congela tasa, registra pagos, libera la mesa. */
  async cobrar(restauranteId: string, comandaId: string, dto: CobrarDto, registradoPorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const comanda = await tx.comanda.findFirst({ where: { restauranteId, id: comandaId } });
      if (!comanda) throw new NotFoundException('Comanda no encontrada');
      if (!ESTADOS_ABIERTOS.includes(comanda.estado as any)) {
        throw new ConflictException('La comanda ya está cerrada');
      }

      const items = await tx.comandaItem.findMany({
        where: { restauranteId, comandaId, estado: { not: 'cancelado' } },
      });
      const subtotal = items.reduce((acc, i) => acc.add(i.totalLinea), new Prisma.Decimal(0));
      const descuento = dto.descuento !== undefined ? new Prisma.Decimal(dto.descuento) : comanda.descuento;
      const propina = dto.propina !== undefined ? new Prisma.Decimal(dto.propina) : comanda.propina;
      const total = subtotal.minus(descuento).plus(comanda.impuesto).plus(propina);
      if (total.lt(0)) throw new BadRequestException('El descuento no puede superar el subtotal');

      const tasa = await tx.tasaCambio.findFirst({
        where: { restauranteId },
        orderBy: { fecha: 'desc' },
      });
      if (!tasa) {
        throw new BadRequestException('No hay una tasa de cambio registrada; regístrala antes de cobrar');
      }

      const sumaPagosUsd = dto.pagos.reduce((acc, p) => {
        const monto = new Prisma.Decimal(p.monto);
        const montoUsd = p.moneda === 'USD' ? monto : monto.div(tasa.valor);
        return acc.add(montoUsd);
      }, new Prisma.Decimal(0));

      if (sumaPagosUsd.minus(total).abs().gt(TOLERANCIA_CUADRE)) {
        throw new BadRequestException('Los pagos no cuadran con el total de la comanda');
      }

      for (const p of dto.pagos) {
        if ((p.metodo === 'pago_movil' || p.metodo === 'transferencia') && !p.referencia?.trim()) {
          throw new BadRequestException('Pago móvil y transferencia exigen número de referencia');
        }
        const monto = new Prisma.Decimal(p.monto);
        const montoUsd = p.moneda === 'USD' ? monto : monto.div(tasa.valor);
        await tx.comandaPago.create({
          data: {
            id: nuevoId(),
            restauranteId,
            comandaId,
            metodo: p.metodo,
            moneda: p.moneda,
            monto,
            tasaAplicada: p.moneda === 'BS' ? tasa.valor : null,
            montoUsd,
            referencia: p.referencia,
            registradoPorId,
          },
        });
      }

      const totalBs = total.mul(tasa.valor);
      const actualizada = await tx.comanda.update({
        where: { id: comandaId },
        data: {
          subtotal,
          descuento,
          propina,
          total,
          estado: 'cobrada',
          cerradaEn: new Date(),
          tasaId: tasa.id,
          tasaValor: tasa.valor,
          totalBs,
        },
      });

      if (comanda.reservacionId) {
        await tx.reservacion.update({ where: { id: comanda.reservacionId }, data: { estado: 'completada' } });
      }

      return actualizada;
    });
  }

  async anular(restauranteId: string, comandaId: string, motivo: string, anuladaPorId: string) {
    const comanda = await this.prisma.comanda.findFirst({ where: { restauranteId, id: comandaId } });
    if (!comanda) throw new NotFoundException('Comanda no encontrada');
    if (!ESTADOS_ABIERTOS.includes(comanda.estado as any)) {
      throw new ConflictException('La comanda ya está cerrada');
    }
    return this.prisma.comanda.update({
      where: { id: comandaId },
      data: { estado: 'anulada', cerradaEn: new Date(), motivoAnulacion: motivo, anuladaPorId },
    });
  }
}
