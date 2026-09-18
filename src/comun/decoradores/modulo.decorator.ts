import { SetMetadata } from '@nestjs/common';
import { ModuloApp } from '../../generated/prisma/enums';

export const CLAVE_MODULOS = 'modulos';
export const CLAVE_COMUN = 'esComun';

/**
 * Qué PANTALLAS del frontend usan este endpoint. Semántica "cualquiera de":
 * basta con que la persona tenga UNO de los módulos listados. Hace falta
 * porque hay endpoints que comparten varias pantallas (`GET /productos` lo usa
 * Productos y también Mesero para buscar qué pedir).
 *
 * Regla para elegirlos: un endpoint se abre a TODAS las pantallas que lo
 * llaman. Cerrarlo a una rompe esa pantalla con 403 para quien sólo tenga ese
 * módulo.
 *
 * Lo lee `ModulosGuard` (global). El administrador pasa siempre. No sustituye a
 * `@Roles(...)`: un endpoint puede exigir las dos cosas (p. ej. `/accesos`).
 */
export const Modulo = (...modulos: ModuloApp[]) => SetMetadata(CLAVE_MODULOS, modulos);

/**
 * Lo que usa el SHELL de la app en TODAS las pantallas (sesión, restaurante,
 * tasa, push y el arranque del plano). Cualquier sesión válida pasa, tenga los
 * módulos que tenga.
 *
 * ⚠️ Es una lista CERRADA acordada con el frontend (ver CONTRACT.md §5.1).
 * Añadir aquí un endpoint es abrírselo a cualquier mesero temporal: no se usa
 * para "que no moleste el guard".
 */
export const Comun = () => SetMetadata(CLAVE_COMUN, true);
