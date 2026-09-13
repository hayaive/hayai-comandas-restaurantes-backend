import { v7 as uuidv7 } from 'uuid';

/**
 * Todo id de negocio se genera en el ORIGEN (aquí), nunca en la base.
 * UUIDv7 es ordenable por tiempo, lo que permite paginar/ordenar por id sin
 * columnas extra y es válido antes del INSERT (útil para el frontend
 * optimista: la mesa se pinta ocupada al toque, antes de la respuesta del
 * servidor). Ver prisma/schema.prisma, cabecera.
 */
export function nuevoId(): string {
  return uuidv7();
}
