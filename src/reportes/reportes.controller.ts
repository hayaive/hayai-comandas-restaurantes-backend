import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ReportesService } from './reportes.service';
import { TasaService } from './tasa.service';
import { CrearTasaDto } from './dto/tasa.dto';
import { ProductosReporteQueryDto, ReporteDiaQueryDto, ReporteVentasQueryDto } from './dto/reportes.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';
import { Comun, Modulo } from '../comun/decoradores/modulo.decorator';
import { Roles } from '../comun/decoradores/roles.decorator';
import { RolesGuard } from '../comun/guards/roles.guard';

@Controller('reportes')
export class ReportesController {
  constructor(private readonly reportes: ReportesService) {}

  /**
   * El apartado de ventas: lo del día, lo del mes o lo que va del año.
   *
   * Un solo endpoint con `periodo` en vez de tres rutas (`/dia`, `/mes`,
   * `/anio`): la respuesta tiene exactamente la misma forma en los tres casos,
   * así que tres rutas serían tres copias del mismo handler y el frontend
   * tendría que elegir la función según el botón pulsado en vez de pasar el
   * filtro como dato.
   */
  @Get('ventas')
  @Modulo('ventas')
  ventas(@UsuarioActual() u: UsuarioSesion, @Query() q: ReporteVentasQueryDto) {
    return this.reportes.ventas(u.restauranteId, q.periodo ?? 'dia', q.fecha);
  }

  @Get('dia')
  @Modulo('ventas')
  ventasDelDia(@UsuarioActual() u: UsuarioSesion, @Query() q: ReporteDiaQueryDto) {
    return this.reportes.ventasDelDia(u.restauranteId, q.fecha);
  }

  @Get('productos')
  @Modulo('ventas')
  productos(@UsuarioActual() u: UsuarioSesion, @Query() q: ProductosReporteQueryDto) {
    return this.reportes.productosVendidos(u.restauranteId, q);
  }

  @Get('cierre-caja')
  @Modulo('ventas')
  cierreCaja(@UsuarioActual() u: UsuarioSesion, @Query() q: ReporteDiaQueryDto) {
    return this.reportes.cierreCaja(u.restauranteId, q.fecha);
  }
}

@Controller('tasa')
export class TasaController {
  constructor(private readonly tasa: TasaService) {}

  @Get('vigente')
  @Comun()
  vigente(@UsuarioActual() u: UsuarioSesion) {
    return this.tasa.vigente(u.restauranteId);
  }

  /**
   * Registrar/refrescar la tasa: sólo administrador y encargado (decisión del
   * dueño). `@Comun()` y no `@Modulo(...)` porque quien la usa es `TasaBar`,
   * que vive en el shell de TODAS las pantallas (y el modal de cobro): la
   * barrera aquí es el ROL, no la pantalla. Son las únicas escrituras `@Comun`
   * del sistema, y van siempre con `@Roles`.
   */
  @Post()
  @Comun()
  @Roles('administrador', 'encargado')
  @UseGuards(RolesGuard)
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
  @Comun()
  @Roles('administrador', 'encargado')
  @UseGuards(RolesGuard)
  actualizar(@UsuarioActual() u: UsuarioSesion) {
    return this.tasa.actualizarDesdeApiExterna(u.restauranteId);
  }
}
