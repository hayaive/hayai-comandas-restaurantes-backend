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

/**
 * Límite del logo del restaurante: 1MB, no los 5MB de las fotos de producto
 * (decisión del dueño — diseño de datos J.O.R.B.I §6). Un logo es un ícono
 * chico que se repite en cada pantalla, ticket y tarjeta de WhatsApp; no hay
 * motivo para tolerar el mismo peso que una foto de plato.
 */
export const TAMANO_MAXIMO_LOGO_BYTES = 1 * 1024 * 1024; // 1MB

/** `undefined` si el mimetype no es una imagen soportada. */
export function extensionParaMimeImagen(mimetype: string): string | undefined {
  return TIPOS_MIME_IMAGEN_PERMITIDOS[mimetype];
}
