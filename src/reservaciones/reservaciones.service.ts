import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { PrismaService } from '../comun/prisma/prisma.service';
import { ComandasService } from '../comandas/comandas.service';
import { nuevoId } from '../comun/id';
import { generarCodigoCorto, generarCodigoPublico } from '../comun/codigos';
import { Prisma } from '../generated/prisma/client';
import { EstadoReservacion, OrigenReservacion } from '../generated/prisma/enums';
import { CrearReservacionDto, ActualizarReservacionDto } from './dto/reservacion.dto';

const ESTADOS_VIVOS: EstadoReservacion[] = ['pendiente', 'confirmada', 'sentada'];

interface DatosReservacionInterna {
  restauranteId: string;
  salonId: string;
  plantillaId: string;
  mesaId?: string | null;
  clienteNombre: string;
  clienteTelefono?: string;
  clienteDocumento?: string;
  personas: number;
  iniciaEn: Date;
  terminaEn: Date;
  origen: OrigenReservacion;
  creadaPorId?: string | null;
  notas?: string;
}

@Injectable()
export class ReservacionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comandas: ComandasService,
  ) {}

  async resolverPlantillaActiva(
    tx: Prisma.TransactionClient | PrismaService,
    restauranteId: string,
    salonId: string,
  ) {
    const plantilla = await tx.plantilla.findFirst({ where: { restauranteId, salonId, activa: true } });
    if (!plantilla) throw new BadRequestException('Ese salón no tiene una distribución activa');
    return plantilla;
  }

  async validarMesaDisponibleEnPlantilla(
    tx: Prisma.TransactionClient | PrismaService,
    restauranteId: string,
    plantillaId: string,
    mesaId: string,
  ) {
    const enPlano = await tx.plantillaMesa.findFirst({ where: { restauranteId, plantillaId, mesaId } });
    if (!enPlano) throw new BadRequestException('Esa mesa no está en la distribución activa');
    if (enPlano.bloqueada) throw new ConflictException('Esa mesa está bloqueada');
    return enPlano;
  }

  /** Inserta la reservación. El solape lo impide Postgres (EXCLUDE); ver PgErrorFilter para el 409. */
  async crearInterna(datos: DatosReservacionInterna) {
    return this.prisma.reservacion.create({
      data: {
        id: nuevoId(),
        restauranteId: datos.restauranteId,
        salonId: datos.salonId,
        plantillaId: datos.plantillaId,
        mesaId: datos.mesaId,
        clienteNombre: datos.clienteNombre,
        clienteTelefono: datos.clienteTelefono,
        clienteDocumento: datos.clienteDocumento,
        personas: datos.personas,
        iniciaEn: datos.iniciaEn,
        terminaEn: datos.terminaEn,
        estado: 'pendiente',
        origen: datos.origen,
        codigoPublico: generarCodigoPublico(),
        codigoCorto: generarCodigoCorto(),
        notas: datos.notas,
        creadaPorId: datos.creadaPorId,
      },
    });
  }

  listar(restauranteId: string, filtros: { desde?: string; hasta?: string; estado?: EstadoReservacion; mesaId?: string }) {
    return this.prisma.reservacion.findMany({
      where: {
        restauranteId,
        ...(filtros.estado ? { estado: filtros.estado } : {}),
        ...(filtros.mesaId ? { mesaId: filtros.mesaId } : {}),
        ...(filtros.desde || filtros.hasta
          ? {
              iniciaEn: {
                ...(filtros.desde ? { gte: new Date(filtros.desde) } : {}),
                ...(filtros.hasta ? { lte: new Date(filtros.hasta) } : {}),
              },
            }
          : {}),
      },
      orderBy: { iniciaEn: 'asc' },
    });
  }

  async obtener(restauranteId: string, id: string) {
    const reservacion = await this.prisma.reservacion.findFirst({ where: { restauranteId, id } });
    if (!reservacion) throw new NotFoundException('Reservación no encontrada');
    return reservacion;
  }

  async crear(restauranteId: string, creadaPorId: string, dto: CrearReservacionDto) {
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });
    const plantilla = await this.resolverPlantillaActiva(this.prisma, restauranteId, dto.salonId);
    if (dto.mesaId) {
      await this.validarMesaDisponibleEnPlantilla(this.prisma, restauranteId, plantilla.id, dto.mesaId);
    }

    const iniciaEn = new Date(dto.iniciaEn);
    const duracionMin = dto.duracionMin ?? restaurante.duracionReservaMin;
    const terminaEn = new Date(iniciaEn.getTime() + duracionMin * 60_000);

    return this.crearInterna({
      restauranteId,
      salonId: dto.salonId,
      plantillaId: plantilla.id,
      mesaId: dto.mesaId,
      clienteNombre: dto.clienteNombre,
      clienteTelefono: dto.clienteTelefono,
      clienteDocumento: dto.clienteDocumento,
      personas: dto.personas,
      iniciaEn,
      terminaEn,
      origen: 'personal',
      creadaPorId,
      notas: dto.notas,
    });
  }

  async actualizar(restauranteId: string, id: string, dto: ActualizarReservacionDto) {
    const reservacion = await this.obtener(restauranteId, id);
    if (!ESTADOS_VIVOS.includes(reservacion.estado)) {
      throw new ConflictException('Esa reservación ya no se puede editar');
    }

    const mesaId = dto.mesaId !== undefined ? dto.mesaId : reservacion.mesaId;
    if (dto.mesaId) {
      await this.validarMesaDisponibleEnPlantilla(this.prisma, restauranteId, reservacion.plantillaId, dto.mesaId);
    }

    let iniciaEn = reservacion.iniciaEn;
    let terminaEn = reservacion.terminaEn;
    if (dto.iniciaEn || dto.duracionMin) {
      iniciaEn = dto.iniciaEn ? new Date(dto.iniciaEn) : reservacion.iniciaEn;
      const duracionMin = dto.duracionMin ?? (reservacion.terminaEn.getTime() - reservacion.iniciaEn.getTime()) / 60_000;
      terminaEn = new Date(iniciaEn.getTime() + duracionMin * 60_000);
    }

    return this.prisma.reservacion.update({
      where: { id },
      data: {
        mesaId,
        clienteNombre: dto.clienteNombre,
        clienteTelefono: dto.clienteTelefono,
        clienteDocumento: dto.clienteDocumento,
        personas: dto.personas,
        iniciaEn,
        terminaEn,
        notas: dto.notas,
      },
    });
  }

  async confirmar(restauranteId: string, id: string) {
    const reservacion = await this.obtener(restauranteId, id);
    if (reservacion.estado !== 'pendiente') throw new ConflictException('Sólo una reserva pendiente se puede confirmar');
    return this.prisma.reservacion.update({
      where: { id },
      data: { estado: 'confirmada', confirmadaEn: new Date() },
    });
  }

  async cancelar(restauranteId: string, id: string, motivo: string) {
    const reservacion = await this.obtener(restauranteId, id);
    if (!ESTADOS_VIVOS.includes(reservacion.estado)) {
      throw new ConflictException('Esa reservación ya no está viva');
    }
    return this.prisma.reservacion.update({
      where: { id },
      data: { estado: 'cancelada', canceladaEn: new Date(), motivoCancelacion: motivo },
    });
  }

  async noShow(restauranteId: string, id: string) {
    const reservacion = await this.obtener(restauranteId, id);
    if (!ESTADOS_VIVOS.includes(reservacion.estado)) {
      throw new ConflictException('Esa reservación ya no está viva');
    }
    return this.prisma.reservacion.update({ where: { id }, data: { estado: 'no_show' } });
  }

  /** El cliente llegó: se sienta (mesa asignada si faltaba) y se abre comanda. */
  async sentar(restauranteId: string, id: string, meseroId: string, dto: { mesaId?: string; comensales?: number }) {
    const reservacion = await this.obtener(restauranteId, id);
    if (reservacion.estado !== 'pendiente' && reservacion.estado !== 'confirmada') {
      throw new ConflictException('Esa reservación no está lista para sentarse');
    }

    const mesaId = dto.mesaId ?? reservacion.mesaId;
    if (!mesaId) throw new BadRequestException('Falta asignar una mesa antes de sentar');
    await this.validarMesaDisponibleEnPlantilla(this.prisma, restauranteId, reservacion.plantillaId, mesaId);

    if (dto.mesaId && dto.mesaId !== reservacion.mesaId) {
      await this.prisma.reservacion.update({ where: { id }, data: { mesaId: dto.mesaId } });
    }

    const comanda = await this.comandas.abrirComanda(restauranteId, meseroId, {
      tipo: 'mesa',
      mesaId,
      comensales: dto.comensales ?? reservacion.personas,
      reservacionId: id,
    });

    const actualizada = await this.obtener(restauranteId, id);
    return { reservacion: actualizada, comanda };
  }

  async huerfanas(restauranteId: string) {
    return this.prisma.$queryRaw`
      SELECT * FROM v_reservacion_huerfana
       WHERE restaurante_id = ${restauranteId}::uuid
       ORDER BY inicia_en ASC
    `;
  }

  async generarQr(restauranteId: string, id: string): Promise<Buffer> {
    const reservacion = await this.obtener(restauranteId, id);
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });
    const base = process.env.URL_PUBLICA ?? 'http://localhost:5173';
    const url = `${base}/r/${restaurante.slug}/reserva/${reservacion.codigoPublico}`;
    return QRCode.toBuffer(url, { type: 'png', margin: 1, width: 320 });
  }
}
