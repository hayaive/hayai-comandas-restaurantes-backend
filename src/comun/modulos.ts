import { ModuloApp, RolUsuario } from '../generated/prisma/enums';

/**
 * Todas las pantallas de la app, en el orden del menú del frontend
 * (`navItems.ts`). Es lo que "ve" un administrador.
 */
export const TODOS_LOS_MODULOS: readonly ModuloApp[] = Object.values(ModuloApp);

/**
 * Las pantallas de ADMINISTRACIÓN. Sólo las ve el administrador, y el CHECK
 * `usuario_modulos_segun_rol` impide dárselas a cualquier otro. `meseros` es
 * la pantalla que crea accesos temporales: si un acceso temporal pudiera
 * verla, se renovaría a sí mismo y la caducidad no existiría.
 */
export const MODULOS_DE_ADMINISTRACION: readonly ModuloApp[] = ['configuracion', 'meseros'];

/** Lo que se le puede dar a alguien que no es administrador (el dueño marca de aquí). */
export const MODULOS_ASIGNABLES: readonly ModuloApp[] = TODOS_LOS_MODULOS.filter(
  (m) => !MODULOS_DE_ADMINISTRACION.includes(m),
);

/**
 * Qué pantallas ve de VERDAD una persona. Es la ÚNICA definición del sistema
 * y la usan los cuatro sitios que tienen que coincidir: la respuesta del
 * login, la del canje del enlace, `GET /auth/yo` y `ModulosGuard`. Si el menú
 * del frontend y el guard calcularan esto cada uno a su manera, tarde o
 * temprano el menú enseñaría una pantalla que responde 403 (o al revés).
 *
 * El administrador ve TODO por rol: su columna `modulos` va vacía a propósito
 * (CHECK `usuario_modulos_segun_rol`), así que aquí se ignora. Para cualquier
 * otro rol, la columna es la única autoridad y falla cerrado: vacía = nada.
 */
export function modulosEfectivos(u: { rol: RolUsuario | string; modulos: readonly ModuloApp[] | null | undefined }): ModuloApp[] {
  if (u.rol === 'administrador') return [...TODOS_LOS_MODULOS];
  return [...(u.modulos ?? [])];
}
