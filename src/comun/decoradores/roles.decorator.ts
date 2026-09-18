import { SetMetadata } from '@nestjs/common';
import { RolUsuario } from '../../generated/prisma/enums';

export const CLAVE_ROLES = 'roles';

/**
 * Marca un endpoint como restringido a uno o varios roles. Se combina con
 * `@UseGuards(RolesGuard)` en el mismo handler (ver `roles.guard.ts`) — el
 * decorador sólo deja la metadata, quien la lee y decide es el guard.
 *
 * No se registra como guard global (a diferencia de `JwtAuthGuard`): así
 * ningún endpoint existente cambia de comportamiento por accidente. Se aplica
 * explícitamente, endpoint por endpoint, donde el dueño del producto pidió
 * restringir por rol.
 */
export const Roles = (...roles: RolUsuario[]) => SetMetadata(CLAVE_ROLES, roles);
