import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface UsuarioSesion {
  id: string;
  restauranteId: string;
  rol: string;
  nombre: string;
  usuario: string;
}

/**
 * Extrae el usuario autenticado (puesto por JwtStrategy) de la request.
 * `restauranteId` sale SIEMPRE de aquí (del token verificado), nunca del
 * body, de un query param o de un header (CONTRACT.md §5, DECISIONES-DATOS §9).
 */
export const UsuarioActual = createParamDecorator((_data: unknown, ctx: ExecutionContext): UsuarioSesion => {
  const request = ctx.switchToHttp().getRequest();
  return request.user as UsuarioSesion;
});
