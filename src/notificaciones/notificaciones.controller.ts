import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NotificacionesService } from './notificaciones.service';
import { ActualizarSuscripcionDto, EliminarSuscripcionDto, RegistrarSuscripcionDto } from './dto/push.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';

/**
 * Web Push: registrar aparatos y consultar la clave pública VAPID.
 *
 * Contrato acordado con el frontend (se construye en paralelo contra esto):
 * `GET /push/vapid`, `POST|GET /push/suscripciones`,
 * `PATCH|DELETE /push/suscripciones(/:id)`. Ninguna respuesta de este
 * controller devuelve `endpoint`, `p256dh` ni `auth` — ver `sanitizar*` en
 * `notificaciones.service.ts`.
 */
@Controller('push')
export class NotificacionesController {
  constructor(private readonly notificaciones: NotificacionesService) {}

  @Get('vapid')
  vapid() {
    return this.notificaciones.obtenerClavePublica();
  }

  @Post('suscripciones')
  @HttpCode(201)
  registrar(@UsuarioActual() u: UsuarioSesion, @Body() dto: RegistrarSuscripcionDto, @Req() req: Request) {
    return this.notificaciones.registrar(u.restauranteId, u.id, dto, req.headers['user-agent']);
  }

  /** "Tus dispositivos": sólo los del usuario que pregunta, no los de todo el restaurante. */
  @Get('suscripciones')
  listar(@UsuarioActual() u: UsuarioSesion) {
    return this.notificaciones.listar(u.restauranteId, u.id);
  }

  @Patch('suscripciones/:id')
  actualizar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: ActualizarSuscripcionDto) {
    return this.notificaciones.actualizar(u.restauranteId, u.id, id, dto);
  }

  /** Por endpoint en el body, no por :id — ver EliminarSuscripcionDto. */
  @Delete('suscripciones')
  @HttpCode(204)
  async eliminar(@UsuarioActual() u: UsuarioSesion, @Body() dto: EliminarSuscripcionDto) {
    await this.notificaciones.eliminarPorEndpoint(u.restauranteId, dto);
  }
}
