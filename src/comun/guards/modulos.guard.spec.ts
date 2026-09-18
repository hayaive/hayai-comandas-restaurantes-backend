import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModulosGuard } from './modulos.guard';
import { Publico } from '../decoradores/public.decorator';
import { Comun, Modulo } from '../decoradores/modulo.decorator';
import { modulosEfectivos, MODULOS_ASIGNABLES, TODOS_LOS_MODULOS } from '../modulos';
import { ModuloApp } from '../../generated/prisma/enums';

/**
 * `ModulosGuard` es la autorización por pantalla de TODO el backend. Estos
 * casos son los que, si se rompen, abren o cierran la app entera: la ruta sin
 * declarar se deniega (falla cerrado), el administrador pasa siempre, y
 * cualquier otro necesita al menos uno de los módulos listados.
 */
class ControllerDePrueba {
  @Modulo('mesas', 'por_cobrar')
  cobrar() {}

  @Comun()
  yo() {}

  @Publico()
  login() {}

  sinDeclarar() {}
}

@Modulo('productos')
class ControllerConClase {
  heredado() {}

  @Comun()
  sobrescrito() {}
}

function contexto(clase: object, metodo: string, usuario?: { rol: string; modulos: ModuloApp[] }) {
  const request = { user: usuario };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => (clase as { prototype: Record<string, unknown> }).prototype[metodo],
    getClass: () => clase,
  } as unknown as ExecutionContext;
}

const guard = new ModulosGuard(new Reflector());
const mesero = (modulos: ModuloApp[]) => ({ rol: 'mesero', modulos });
const admin = { rol: 'administrador', modulos: [] as ModuloApp[] };

describe('ModulosGuard', () => {
  it('niega una ruta sin @Publico, @Comun ni @Modulo — incluso al administrador (falla cerrado)', () => {
    expect(() => guard.canActivate(contexto(ControllerDePrueba, 'sinDeclarar', admin))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contexto(ControllerDePrueba, 'sinDeclarar', mesero(['mesas'])))).toThrow(
      ForbiddenException,
    );
  });

  it('@Publico pasa sin sesión', () => {
    expect(guard.canActivate(contexto(ControllerDePrueba, 'login'))).toBe(true);
  });

  it('@Comun pasa con cualquier sesión, aunque no tenga ningún módulo', () => {
    expect(guard.canActivate(contexto(ControllerDePrueba, 'yo', mesero([])))).toBe(true);
  });

  it('@Comun sin sesión se niega (no se confía en que JwtAuthGuard cortó antes)', () => {
    expect(() => guard.canActivate(contexto(ControllerDePrueba, 'yo'))).toThrow(ForbiddenException);
  });

  it('@Modulo es "cualquiera de": basta uno de los listados', () => {
    expect(guard.canActivate(contexto(ControllerDePrueba, 'cobrar', mesero(['por_cobrar'])))).toBe(true);
    expect(guard.canActivate(contexto(ControllerDePrueba, 'cobrar', mesero(['mesas', 'ventas'])))).toBe(true);
  });

  it('@Modulo niega a quien no tiene ninguno de los listados', () => {
    expect(() => guard.canActivate(contexto(ControllerDePrueba, 'cobrar', mesero(['mesero', 'ventas'])))).toThrow(
      ForbiddenException,
    );
  });

  it('un usuario sin módulos no pasa ningún @Modulo (vacío = no ve nada)', () => {
    expect(() => guard.canActivate(contexto(ControllerDePrueba, 'cobrar', mesero([])))).toThrow(ForbiddenException);
  });

  it('el administrador pasa todo @Modulo aunque su columna `modulos` esté vacía', () => {
    expect(guard.canActivate(contexto(ControllerDePrueba, 'cobrar', admin))).toBe(true);
  });

  it('@Modulo en la clase aplica a sus métodos, y el método puede sobrescribirlo', () => {
    expect(guard.canActivate(contexto(ControllerConClase, 'heredado', mesero(['productos'])))).toBe(true);
    expect(() => guard.canActivate(contexto(ControllerConClase, 'heredado', mesero(['mesas'])))).toThrow(
      ForbiddenException,
    );
    expect(guard.canActivate(contexto(ControllerConClase, 'sobrescrito', mesero(['mesas'])))).toBe(true);
  });
});

describe('modulosEfectivos', () => {
  it('administrador: todos, ignorando la columna', () => {
    expect(modulosEfectivos({ rol: 'administrador', modulos: [] })).toEqual([...TODOS_LOS_MODULOS]);
  });

  it('cualquier otro rol: exactamente su columna', () => {
    expect(modulosEfectivos({ rol: 'encargado', modulos: ['mesas', 'ventas'] })).toEqual(['mesas', 'ventas']);
  });

  it('columna NULL se trata como vacía (falla cerrado)', () => {
    expect(modulosEfectivos({ rol: 'mesero', modulos: null })).toEqual([]);
  });

  it('los módulos asignables nunca incluyen los de administración', () => {
    expect(MODULOS_ASIGNABLES).not.toContain('configuracion');
    expect(MODULOS_ASIGNABLES).not.toContain('meseros');
    expect(MODULOS_ASIGNABLES).toHaveLength(TODOS_LOS_MODULOS.length - 2);
  });
});
