import { SetMetadata } from '@nestjs/common';

export const CLAVE_PUBLICA = 'esPublico';

/**
 * Marca un endpoint como accesible sin sesión. Usado por el enlace público de
 * reservas (`/publico/...`) y por `/auth/login` y `/auth/pin`.
 */
export const Publico = () => SetMetadata(CLAVE_PUBLICA, true);
