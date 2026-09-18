import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AccesosService } from './accesos.service';
import { ActualizarAccesoDto, CanjearAccesoDto, ConsultarAccesoDto, CrearAccesoDto, RegenerarAccesoDto } from './dto/acceso.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';
import { Roles } from '../comun/decoradores/roles.decorator';
import { Modulo } from '../comun/decoradores/modulo.decorator';
import { Publico } from '../comun/decoradores/public.decorator';
import { RolesGuard } from '../comun/guards/roles.guard';

/**
 * Pantalla "Meseros": el dueño crea, lista, edita, regenera y revoca accesos
 * temporales.
 *
 * Doble barrera, a propósito:
 *   · `@Modulo('meseros')` — ningún no-administrador puede tener ese módulo
 *     (CHECK `usuario_modulos_segun_rol`);
 *   · `@Roles('administrador')` — aunque alguien marcara mal los módulos, un
 *     acceso temporal es siempre `mesero` (CHECK
 *     `usuario_acceso_temporal_es_mesero`) y aquí no entra. Sin esto un acceso
 *     de 4 dígitos podría renovarse a sí mismo.
 */
@Controller('accesos')
@Modulo('meseros')
@Roles('administrador')
@UseGuards(RolesGuard)
export class AccesosController {
  constructor(private readonly accesos: AccesosService) {}

  /** Cuándo vencería cada atajo si se creara ahora (para enseñarlo antes de confirmar). */
  @Get('vencimientos')
  vencimientos(@UsuarioActual() u: UsuarioSesion) {
    return this.accesos.vencimientos(u.restauranteId);
  }

  @Get()
  listar(@UsuarioActual() u: UsuarioSesion) {
    return this.accesos.listar(u.restauranteId);
  }

  /** 201. `enlace` y `codigo` salen UNA sola vez. */
  @Post()
  crear(@UsuarioActual() u: UsuarioSesion, @Body() dto: CrearAccesoDto) {
    return this.accesos.crear(u, dto);
  }

  @Patch(':id')
  actualizar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: ActualizarAccesoDto) {
    return this.accesos.actualizar(u.restauranteId, id, dto);
  }

  @Post(':id/regenerar')
  @HttpCode(200)
  regenerar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: RegenerarAccesoDto) {
    return this.accesos.regenerar(u, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async eliminar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    await this.accesos.eliminar(u.restauranteId, id);
  }
}

/**
 * Canje PÚBLICO del enlace de un acceso temporal. Sin sesión: es lo que la
 * crea.
 *
 * El frontend ramifica por CÓDIGO HTTP, nunca por texto:
 *   404 enlace inválido · 410 acceso vencido · 401 código incorrecto.
 *
 * ⚠️ SIN `@Throttle` propio, A PROPÓSITO. Queda sólo el límite global de
 * AppModule. El backend no tiene `trust proxy` configurado, así que detrás
 * del proxy de Railway TODAS las peticiones llegan con la misma IP: un límite
 * más estricto aquí no frenaría a un atacante, le daría un botón para
 * bloquearles el canje a TODOS los meseros a la vez. La defensa contra fuerza
 * bruta es que el código no sirve sin el enlace (160 bits) y el aviso push al
 * dueño (`acceso_sospechoso`). Revisar esto el día que se configure
 * `trust proxy` (decisión del dueño, aplazada).
 */
@Controller('auth/acceso')
@Publico()
export class AccesoCanjeController {
  constructor(private readonly accesos: AccesosService) {}

  /** Saludo previo al código. No cuenta como intento. */
  @Post('consultar')
  @HttpCode(200)
  consultar(@Body() dto: ConsultarAccesoDto) {
    return this.accesos.consultar(dto);
  }

  @Post()
  @HttpCode(200)
  canjear(@Body() dto: CanjearAccesoDto) {
    return this.accesos.canjear(dto);
  }
}
