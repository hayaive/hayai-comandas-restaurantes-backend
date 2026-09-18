import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CLAVE_PUBLICA } from '../decoradores/public.decorator';
import { CLAVE_COMUN, CLAVE_MODULOS } from '../decoradores/modulo.decorator';
import { UsuarioSesion } from '../decoradores/usuario-actual.decorator';
import { modulosEfectivos } from '../modulos';
import { ModuloApp } from '../../generated/prisma/enums';

/** Cómo declara una ruta quién puede usarla. `null` = no lo declara (bug). */
export type AccesoDeRuta =
  | { tipo: 'publico' }
  | { tipo: 'comun' }
  | { tipo: 'modulos'; modulos: ModuloApp[] }
  | null;

/**
 * Lee lo que declara una ruta. El HANDLER manda sobre la CLASE: un controller
 * con `@Modulo('mesas')` puede tener un método `@Comun()`, y ése es común.
 *
 * Exportada para el test de cobertura de rutas (`rutas-cubiertas.spec.ts`):
 * guard y test deciden con la MISMA función, así que lo que el test da por
 * cubierto es exactamente lo que el guard deja pasar.
 */
export function accesoDeRuta(reflector: Reflector, handler: object, clase: object): AccesoDeRuta {
  for (const objetivo of [handler, clase]) {
    if (reflector.get<boolean>(CLAVE_PUBLICA, objetivo as never)) return { tipo: 'publico' };
    if (reflector.get<boolean>(CLAVE_COMUN, objetivo as never)) return { tipo: 'comun' };
    const modulos = reflector.get<ModuloApp[]>(CLAVE_MODULOS, objetivo as never);
    if (modulos) return { tipo: 'modulos', modulos };
  }
  return null;
}

/**
 * Autorización por PANTALLA. Global (AppModule) y registrado DESPUÉS de
 * `JwtAuthGuard`, así que `request.user` ya viene de `JwtStrategy.validate`,
 * que relee `modulos` de la base en cada petición: quitarle un módulo a
 * alguien surte efecto en su siguiente clic.
 *
 * FALLA CERRADO. Una ruta sin `@Publico`, `@Comun` ni `@Modulo` se deniega a
 * todo el mundo, administrador incluido: el olvido tiene que verse el primer
 * día (un 403 del dueño probando) y no el día que alguien descubre que un
 * mesero de 4 dígitos podía llamar un endpoint que nadie decoró. La red que
 * impide que eso llegue a producción es `rutas-cubiertas.spec.ts`.
 *
 * Con `@Modulo(...)` el administrador pasa siempre (sus módulos efectivos son
 * todos); cualquier otro necesita al menos UNO de los listados.
 *
 * No sustituye a `RolesGuard`: `@Roles(...)` sigue siendo la barrera de lo que
 * es de administración aunque alguien marque mal los módulos.
 */
@Injectable()
export class ModulosGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const acceso = accesoDeRuta(this.reflector, context.getHandler(), context.getClass());

    if (!acceso) {
      throw new ForbiddenException('Esta ruta no declara qué pantallas pueden usarla');
    }
    if (acceso.tipo === 'publico') return true;

    const usuario = context.switchToHttp().getRequest().user as UsuarioSesion | undefined;
    if (!usuario) {
      // JwtAuthGuard ya cortó antes; no se confía en eso.
      throw new ForbiddenException('No tienes permiso para realizar esta acción');
    }
    if (acceso.tipo === 'comun') return true;

    const propios = modulosEfectivos(usuario);
    if (acceso.modulos.some((m) => propios.includes(m))) return true;

    throw new ForbiddenException('No tienes acceso a esta pantalla');
  }
}
