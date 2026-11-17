import { Prisma } from '../../generated/prisma/client';

/**
 * Fija el autor (y, opcional, el motivo) de lo que esta transacción escriba:
 * `SET LOCAL app.usuario_id` / `app.motivo` (docs/DECISIONES-DATOS.md §15.5, regla 1).
 *
 * Tiene que ser la PRIMERA sentencia de todo `$transaction` que escriba: los
 * triggers de bitácora (`hayai_bitacora`) leen esa variable y, sin autor,
 * revientan con `bitacora_sin_autor`. `set_config(..., true)` es local a la
 * transacción: muere con el COMMIT/ROLLBACK, no se filtra a otra petición.
 */
export async function fijarAutor(tx: Prisma.TransactionClient, usuarioId: string, motivo?: string): Promise<void> {
  await tx.$queryRaw`
    SELECT set_config('app.usuario_id', ${usuarioId}, true),
           set_config('app.motivo', ${motivo ?? ''}, true)
  `;
}
