/**
 * Reglas de validación de imágenes subidas por el usuario (fotos de producto,
 * de momento). Centralizadas aquí para poder testearlas sin levantar Nest ni
 * multer.
 */

/** mimetype -> extensión con la que se escribe a disco. Nunca la del cliente. */
export const TIPOS_MIME_IMAGEN_PERMITIDOS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export const TAMANO_MAXIMO_IMAGEN_BYTES = 5 * 1024 * 1024; // 5MB

/** `undefined` si el mimetype no es una imagen soportada. */
export function extensionParaMimeImagen(mimetype: string): string | undefined {
  return TIPOS_MIME_IMAGEN_PERMITIDOS[mimetype];
}
