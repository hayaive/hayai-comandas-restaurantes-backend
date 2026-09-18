import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ModuloApp } from '../../generated/prisma/enums';

export interface UsuarioSesion {
  id: string;
  restauranteId: string;
  rol: string;
  nombre: string;
  usuario: string;
  /**
   * La columna tal cual (vacía para el administrador). Lo que la persona VE
   * se calcula con `modulosEfectivos()` (src/comun/modulos.ts), nunca leyendo
   * esto a pelo.
   */
  modulos: ModuloApp[];
  /** NULL = personal permanente; fecha = acceso temporal que vence ahí. */
  accesoHasta: Date | null;
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
