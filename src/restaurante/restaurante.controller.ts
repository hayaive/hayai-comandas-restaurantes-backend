import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { RestauranteService } from './restaurante.service';
import { ActualizarRestauranteDto } from './dto/actualizar-restaurante.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';
import { Roles } from '../comun/decoradores/roles.decorator';
import { RolesGuard } from '../comun/guards/roles.guard';
import { Comun, Modulo } from '../comun/decoradores/modulo.decorator';

/**
 * Configuración del restaurante (nombre, logo, en qué moneda se muestran los
 * precios). `slug`, `monedaBase`, `horaCorteDia` y `zonaHoraria` se leen en el
 * GET pero NO se editan aquí — ver `ActualizarRestauranteDto` y el diseño de
 * datos (J.O.R.B.I) para el porqué de cada uno.
 */
@Controller('restaurante')
export class RestauranteController {
  constructor(private readonly restaurante: RestauranteService) {}

  @Get()
  @Comun()
  obtener(@UsuarioActual() u: UsuarioSesion) {
    return this.restaurante.obtener(u.restauranteId);
  }

  /** Sólo `administrador` — `JwtAuthGuard` (global) ya exige sesión; `RolesGuard` exige además el rol. */
  @Patch()
  @Roles('administrador')
  @UseGuards(RolesGuard)
  @Modulo('configuracion')
  actualizar(@UsuarioActual() u: UsuarioSesion, @Body() dto: ActualizarRestauranteDto) {
    return this.restaurante.actualizar(u.restauranteId, dto);
  }
}
