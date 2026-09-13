import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ReservacionesPublicoService } from './reservaciones-publico.service';
import { CrearReservacionPublicaDto, SeleccionarMesaPublicaDto } from './dto/reservacion-publica.dto';
import { Publico } from '../comun/decoradores/public.decorator';

/**
 * Enlace público de reservas — sin sesión. CONTRACT.md exige rate-limit
 * obligatorio: 20 peticiones/minuto por IP en todo el controlador.
 */
@Publico()
@Throttle({ default: { limit: 20, ttl: 60_000 } })
@Controller('publico')
export class ReservacionesPublicoController {
  constructor(private readonly publico: ReservacionesPublicoService) {}

  @Get('r/:slug/disponibilidad')
  disponibilidad(@Param('slug') slug: string, @Query('fecha') fecha: string, @Query('personas') personas: string) {
    return this.publico.disponibilidad(slug, fecha, Number(personas ?? 1));
  }

  @Post('r/:slug/reservaciones')
  crear(@Param('slug') slug: string, @Body() dto: CrearReservacionPublicaDto) {
    return this.publico.crear(slug, dto);
  }

  @Get('reserva/:codigoPublico')
  obtener(@Param('codigoPublico') codigoPublico: string) {
    return this.publico.obtenerPublica(codigoPublico);
  }

  @Post('reserva/:codigoPublico/mesa')
  seleccionarMesa(@Param('codigoPublico') codigoPublico: string, @Body() dto: SeleccionarMesaPublicaDto) {
    return this.publico.seleccionarMesa(codigoPublico, dto.mesaId);
  }

  @Post('reserva/:codigoPublico/checkin')
  checkin(@Param('codigoPublico') codigoPublico: string) {
    return this.publico.checkin(codigoPublico);
  }
}
