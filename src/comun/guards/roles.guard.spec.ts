import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

/**
 * `RolesGuard` es infraestructura de seguridad nueva (no existía control de
 * roles en este backend antes de esta entrega): cubre los tres casos que
 * importan — sin `@Roles()` no bloquea nada (compatibilidad con endpoints
 * existentes), con `@Roles()` deja pasar el rol correcto, y rechaza
 * cualquier otro con 403, incluida la ausencia de `request.user`.
 */
function mockContext(rolesMetadata: string[] | undefined, usuario: { rol: string } | undefined) {
  const request = { user: usuario };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
    __rolesMetadata: rolesMetadata,
  } as unknown as ExecutionContext;
}

function guardConMetadata(rolesMetadata: string[] | undefined) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(rolesMetadata) } as unknown as Reflector;
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  it('sin @Roles() en el handler deja pasar cualquier sesión válida (compatibilidad con endpoints existentes)', () => {
    const guard = guardConMetadata(undefined);
    const context = mockContext(undefined, { rol: 'mesero' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('con @Roles() vacío también deja pasar (mismo criterio que "sin metadata")', () => {
    const guard = guardConMetadata([]);
    const context = mockContext([], { rol: 'mesero' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('deja pasar cuando el rol de la sesión está en la lista permitida', () => {
    const guard = guardConMetadata(['administrador']);
    const context = mockContext(['administrador'], { rol: 'administrador' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rechaza con 403 cuando el rol de la sesión no está en la lista permitida', () => {
    const guard = guardConMetadata(['administrador']);
    const context = mockContext(['administrador'], { rol: 'mesero' });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rechaza con 403 si no hay usuario en la request (JwtAuthGuard debería haber cortado antes, pero no se confía en eso)', () => {
    const guard = guardConMetadata(['administrador']);
    const context = mockContext(['administrador'], undefined);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
