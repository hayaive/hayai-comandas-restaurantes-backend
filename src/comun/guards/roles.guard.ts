import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CLAVE_ROLES } from '../decoradores/roles.decorator';
import { UsuarioSesion } from '../decoradores/usuario-actual.decorator';

/**
 * Guard de AUTORIZACIÓN por rol, complementario a `JwtAuthGuard`
 * (autenticación). `JwtAuthGuard` es global y corre primero: exige sesión
 * válida y deja `request.user` poblado (`JwtStrategy.validate`). Este guard
 * se aplica sólo donde se pide con `@UseGuards(RolesGuard)` + `@Roles(...)`,
 * y siempre corre DESPUÉS del global, así que `request.user` ya existe.
 *
 * Sin `@Roles()` en el handler deja pasar cualquier sesión válida — el mismo
 * comportamiento de hoy. Esto es a propósito: aplicarlo como guard global
 * habría exigido decorar cada endpoint existente con algo para no romperlos,
 * y el encargo es explícito en que ningún endpoint actual cambia de
 * comportamiento.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const rolesPermitidos = this.reflector.getAllAndOverride<string[]>(CLAVE_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rolesPermitidos || rolesPermitidos.length === 0) return true;

    const usuario = context.switchToHttp().getRequest().user as UsuarioSesion | undefined;
    if (!usuario || !rolesPermitidos.includes(usuario.rol)) {
      throw new ForbiddenException('No tienes permiso para realizar esta acción');
    }
    return true;
  }
}
