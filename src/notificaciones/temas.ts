import { RolUsuario, TemaNotificacion } from '../generated/prisma/enums';

/**
 * Matriz PERMISO (no PREFERENCIA) por tema de notificación push.
 *
 * `suscripcion_push.temas` es lo que un aparato QUIERE recibir; esta matriz es
 * lo que su usuario PUEDE recibir según su rol, evaluado en cada envío (no al
 * guardar la suscripción). Hacen falta las dos: el rol solo no alcanza porque
 * no existe un rol `barra` (la tablet de barra y la de cocina entran las dos
 * como `cocina`, y lo único que las distingue es a qué se suscribió cada
 * aparato); los temas solos tampoco, porque los roles cambian y una
 * preferencia congelada seguiría avisando a alguien que ya no debería verla.
 *
 * Diseño de datos: J.O.R.B.I (data-engineer). Ver el documento de diseño
 * (docs/DECISIONES-DATOS.md y el `.md` de notificaciones push) para el porqué
 * completo.
 */
export const ROLES_POR_TEMA: Record<TemaNotificacion, RolUsuario[]> = {
  comanda_cocina: ['cocina', 'encargado', 'administrador'],
  comanda_barra: ['cocina', 'encargado', 'administrador'],
  cuenta_por_cobrar: ['caja', 'encargado', 'administrador'],
  reservacion_nueva: ['encargado', 'administrador'],
};
