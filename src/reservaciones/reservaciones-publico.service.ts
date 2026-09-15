import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { ReservacionesService } from './reservaciones.service';
import { Reservacion } from '../generated/prisma/client';
import { CrearReservacionPublicaDto } from './dto/reservacion-publica.dto';

/**
 * `ReservacionPublica` NO expone ids internos de otras reservas ni datos de
 * otros clientes: sólo la propia reserva y las mesas disponibles de la
 * plantilla activa (CONTRACT.md §5, "Reservaciones (público)").
 */
function aReservacionPublica(r: Reservacion, mesaEtiqueta?: string | null) {
  return {
    codigoPublico: r.codigoPublico,
    codigoCorto: r.codigoCorto,
    clienteNombre: r.clienteNombre,
    personas: r.personas,
    iniciaEn: r.iniciaEn,
    terminaEn: r.terminaEn,
    estado: r.estado,
    salonId: r.salonId,
    plantillaId: r.plantillaId,
    mesaId: r.mesaId,
    mesaEtiqueta: mesaEtiqueta ?? null,
    notas: r.notas,
  };
}

@Injectable()
export class ReservacionesPublicoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservaciones: ReservacionesService,
  ) {}

  private async restaurantePorSlug(slug: string) {
    const restaurante = await this.prisma.restaurante.findFirst({ where: { slug, activo: true } });
    if (!restaurante) throw new NotFoundException('Restaurante no encontrado');
    return restaurante;
  }

  async disponibilidad(slug: string, fechaIso: string, personas: number) {
    const restaurante = await this.restaurantePorSlug(slug);
    const iniciaEn = new Date(fechaIso);
    if (Number.isNaN(iniciaEn.getTime())) throw new BadRequestException('Fecha inválida');
    const terminaEn = new Date(iniciaEn.getTime() + restaurante.duracionReservaMin * 60_000);

    const plantillasActivas = await this.prisma.plantilla.findMany({
      where: { restauranteId: restaurante.id, activa: true },
    });
    if (plantillasActivas.length === 0) return { mesas: [] };

    const plantillaIds = plantillasActivas.map((p) => p.id);
    const mesasEnPlano = await this.prisma.plantillaMesa.findMany({
      where: {
        restauranteId: restaurante.id,
        plantillaId: { in: plantillaIds },
        bloqueada: false,
        capacidad: { gte: personas },
      },
      include: { mesa: true },
    });
    if (mesasEnPlano.length === 0) return { mesas: [] };

    const mesaIds = mesasEnPlano.map((m) => m.mesaId);
    const solapadas = await this.prisma.reservacion.findMany({
      where: {
        restauranteId: restaurante.id,
        mesaId: { in: mesaIds },
        estado: { in: ['pendiente', 'confirmada', 'sentada'] },
        iniciaEn: { lt: terminaEn },
        terminaEn: { gt: iniciaEn },
      },
      select: { mesaId: true },
    });
    const ocupadas = new Set(solapadas.map((r) => r.mesaId));

    const mesas = mesasEnPlano
      .filter((m) => !ocupadas.has(m.mesaId))
      .map((m) => ({
        salonId: m.mesa.salonId,
        plantillaId: m.plantillaId,
        mesaId: m.mesaId,
        etiqueta: m.mesa.etiqueta,
        capacidad: m.capacidad,
        forma: m.forma,
      }));

    return { mesas };
  }

  async crear(slug: string, dto: CrearReservacionPublicaDto) {
    const restaurante = await this.restaurantePorSlug(slug);

    let salonId: string;
    let plantillaId: string;

    if (dto.mesaId) {
      if (!restaurante.permiteAutoseleccion) {
        throw new ForbiddenException('Este restaurante no permite elegir mesa desde el enlace público');
      }
      const mesa = await this.prisma.mesa.findFirst({
        where: { restauranteId: restaurante.id, id: dto.mesaId, eliminadaEn: null },
      });
      if (!mesa) throw new NotFoundException('Mesa no encontrada');
      salonId = mesa.salonId;
      const plantilla = await this.reservaciones.resolverPlantillaActiva(this.prisma, restaurante.id, salonId);
      plantillaId = plantilla.id;
      await this.reservaciones.validarMesaDisponibleEnPlantilla(this.prisma, restaurante.id, plantillaId, dto.mesaId);
    } else {
      // Sin mesa: se asigna al primer salón (por orden) con distribución
      // activa; el anfitrión la reasigna después si hace falta (A6).
      const salon = await this.prisma.salon.findFirst({
        where: { restauranteId: restaurante.id, eliminadoEn: null, plantillas: { some: { activa: true } } },
        orderBy: { orden: 'asc' },
      });
      if (!salon) throw new BadRequestException('El restaurante no tiene salones con una distribución activa');
      salonId = salon.id;
      const plantilla = await this.reservaciones.resolverPlantillaActiva(this.prisma, restaurante.id, salonId);
      plantillaId = plantilla.id;
    }

    const iniciaEn = new Date(dto.iniciaEn);
    const terminaEn = new Date(iniciaEn.getTime() + restaurante.duracionReservaMin * 60_000);

    const reservacion = await this.reservaciones.crearInterna({
      restauranteId: restaurante.id,
      salonId,
      plantillaId,
      mesaId: dto.mesaId,
      clienteNombre: dto.clienteNombre,
      clienteTelefono: dto.clienteTelefono,
      personas: dto.personas,
      iniciaEn,
      terminaEn,
      origen: 'enlace_publico',
    });

    const base = process.env.URL_PUBLICA ?? 'http://localhost:5173';
    return {
      codigoPublico: reservacion.codigoPublico,
      codigoCorto: reservacion.codigoCorto,
      qrUrl: `${base}/r/${restaurante.slug}/reserva/${reservacion.codigoPublico}`,
    };
  }

  private async obtenerPorCodigo(codigoPublico: string) {
    const reservacion = await this.prisma.reservacion.findFirst({ where: { codigoPublico } });
    if (!reservacion) throw new NotFoundException('Reservación no encontrada');
    return reservacion;
  }

  async obtenerPublica(codigoPublico: string) {
    const reservacion = await this.obtenerPorCodigo(codigoPublico);
    const mesa = reservacion.mesaId
      ? await this.prisma.mesa.findFirst({ where: { id: reservacion.mesaId } })
      : null;
    return aReservacionPublica(reservacion, mesa?.etiqueta);
  }

  async seleccionarMesa(codigoPublico: string, mesaId: string) {
    const reservacion = await this.obtenerPorCodigo(codigoPublico);
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: reservacion.restauranteId } });
    if (!restaurante.permiteAutoseleccion) {
      throw new ForbiddenException('Este restaurante no permite elegir mesa desde el enlace público');
    }
    if (reservacion.estado !== 'pendiente' && reservacion.estado !== 'confirmada') {
      throw new ConflictException('Esa reservación ya no admite cambios de mesa');
    }
    await this.reservaciones.validarMesaDisponibleEnPlantilla(
      this.prisma,
      reservacion.restauranteId,
      reservacion.plantillaId,
      mesaId,
    );

    const actualizada = await this.prisma.reservacion.update({
      where: { id: reservacion.id },
      data: { mesaId },
    });
    const mesa = await this.prisma.mesa.findFirst({ where: { id: mesaId } });
    return aReservacionPublica(actualizada, mesa?.etiqueta);
  }

  /**
   * CONTRACT.md §3: check-in por QR — valida la reserva y la deja `sentada`.
   *
   * ⚠️ Ya NO abre comanda (mismo motivo que `ReservacionesService.sentar`): una
   * comanda es un PEDIDO y exige al menos una línea, así que el check-in no
   * puede crearla — y menos desde un endpoint público sin sesión, donde nadie
   * ha tomado nota todavía. La primera comanda la crea el mesero después.
   *
   * ⭐ Aun así la mesa queda OCUPADA desde este mismo instante: `v_mesa_estado`
   * cuenta una reserva `sentada` como ocupación, sin necesidad de comanda. Es
   * exactamente lo que el escaneo del QR tiene que producir en el plano.
   */
  async checkin(codigoPublico: string) {
    const reservacion = await this.obtenerPorCodigo(codigoPublico);
    if (reservacion.estado !== 'pendiente' && reservacion.estado !== 'confirmada') {
      throw new ConflictException('Esa reservación no está lista para el check-in');
    }
    if (!reservacion.mesaId) {
      throw new BadRequestException('Elige una mesa antes de hacer check-in');
    }

    await this.reservaciones.validarMesaDisponibleEnPlantilla(
      this.prisma,
      reservacion.restauranteId,
      reservacion.plantillaId,
      reservacion.mesaId,
    );

    await this.prisma.reservacion.update({
      where: { id: reservacion.id },
      data: { estado: 'sentada', sentadaEn: new Date() },
    });

    const actualizada = await this.obtenerPorCodigo(codigoPublico);
    const mesa = await this.prisma.mesa.findFirst({ where: { id: actualizada.mesaId! } });
    return aReservacionPublica(actualizada, mesa?.etiqueta);
  }
}
