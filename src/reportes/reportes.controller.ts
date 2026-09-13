import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ReportesService } from './reportes.service';
import { TasaService } from './tasa.service';
import { CrearTasaDto } from './dto/tasa.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';

@Controller('reportes')
export class ReportesController {
  constructor(private readonly reportes: ReportesService) {}

  @Get('dia')
  ventasDelDia(@UsuarioActual() u: UsuarioSesion, @Query('fecha') fecha: string) {
    return this.reportes.ventasDelDia(u.restauranteId, fecha);
  }

  @Get('productos')
  productos(
    @UsuarioActual() u: UsuarioSesion,
    @Query('desde') desde: string,
    @Query('hasta') hasta: string,
    @Query('orden') orden?: 'cantidad' | 'ingreso',
    @Query('limite') limite?: string,
  ) {
    return this.reportes.productosVendidos(u.restauranteId, desde, hasta, orden ?? 'cantidad', Number(limite ?? 10));
  }

  @Get('cierre-caja')
  cierreCaja(@UsuarioActual() u: UsuarioSesion, @Query('fecha') fecha: string) {
    return this.reportes.cierreCaja(u.restauranteId, fecha);
  }
}

@Controller('tasa')
export class TasaController {
  constructor(private readonly tasa: TasaService) {}

  @Get('vigente')
  vigente(@UsuarioActual() u: UsuarioSesion) {
    return this.tasa.vigente(u.restauranteId);
  }

  @Post()
  crear(@UsuarioActual() u: UsuarioSesion, @Body() dto: CrearTasaDto) {
    return this.tasa.crear(u.restauranteId, u.id, dto);
  }

  /**
   * Refresco manual: repite el mismo fetch a dolarapi.com que corre el cron
   * cada 6 horas, sin esperar al próximo tick. Endpoint separado (en vez de
   * sobrecargar `POST /tasa` sin body) porque `CrearTasaDto` exige `valor` y
   * `fuente` — no hay forma de "no traer body especial" sin relajar esa
   * validación para el resto de usos manuales.
   */
  @Post('actualizar')
  actualizar(@UsuarioActual() u: UsuarioSesion) {
    return this.tasa.actualizarDesdeApiExterna(u.restauranteId);
  }
}
