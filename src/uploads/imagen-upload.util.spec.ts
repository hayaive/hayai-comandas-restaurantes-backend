import { extensionParaMimeImagen, TIPOS_MIME_IMAGEN_PERMITIDOS } from './imagen-upload.util';

describe('extensionParaMimeImagen', () => {
  it('devuelve la extensión correcta para cada mimetype soportado', () => {
    expect(extensionParaMimeImagen('image/jpeg')).toBe('.jpg');
    expect(extensionParaMimeImagen('image/png')).toBe('.png');
    expect(extensionParaMimeImagen('image/webp')).toBe('.webp');
  });

  it('rechaza mimetypes no soportados (evita subir cualquier binario como "imagen")', () => {
    expect(extensionParaMimeImagen('application/pdf')).toBeUndefined();
    expect(extensionParaMimeImagen('text/html')).toBeUndefined();
    expect(extensionParaMimeImagen('image/svg+xml')).toBeUndefined();
    expect(extensionParaMimeImagen('')).toBeUndefined();
  });

  it('nunca deriva la extensión del nombre de archivo del cliente', () => {
    // Congela el contrato: la extensión sale del mapa fijo, no de un parseo
    // de `file.originalname` (que es lo que abriría la puerta a path traversal
    // o a escribir con una extensión ejecutable disfrazada de imagen).
    expect(Object.keys(TIPOS_MIME_IMAGEN_PERMITIDOS)).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });
});
