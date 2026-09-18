import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';

/**
 * Configuración VAPID (Voluntary Application Server Identification), leída de
 * `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`.
 *
 * ⚠️ Si faltan, el módulo NO tumba el arranque del servidor: Web Push es una
 * mejora, no un requisito para tomar comandas. Simplemente queda
 * `configurado = false`, `GET /push/vapid` responde 503 y
 * `NotificacionesService.notificarComandaNueva` no hace nada (ver ese
 * archivo). Se loggea una advertencia una sola vez, al construir el servicio.
 */
@Injectable()
export class VapidConfigService {
  private readonly logger = new Logger(VapidConfigService.name);

  readonly configurado: boolean;
  readonly clavePublica?: string;
  readonly subject?: string;
  /**
   * Identificador del par de claves: los 12 primeros caracteres de la clave
   * pública. Determinista, sin configuración extra propia, y cambia si y sólo
   * si cambia el par VAPID — es lo que permite filtrar el envío por
   * `vapid_kid` y convertir una rotación de claves en un no-evento en vez de
   * una tormenta de 403 (regla dura §11/§13 del diseño de notificaciones).
   */
  readonly kid?: string;

  constructor() {
    const clavePublica = process.env.VAPID_PUBLIC_KEY?.trim();
    const clavePrivada = process.env.VAPID_PRIVATE_KEY?.trim();
    const subject = process.env.VAPID_SUBJECT?.trim();

    if (clavePublica && clavePrivada && subject) {
      this.configurado = true;
      this.clavePublica = clavePublica;
      this.subject = subject;
      this.kid = clavePublica.slice(0, 12);
      webpush.setVapidDetails(subject, clavePublica, clavePrivada);
    } else {
      this.configurado = false;
      this.logger.warn(
        'Faltan variables VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT: ' +
          'Web Push queda DESHABILITADO (el servidor arranca igual). ' +
          'Genera un par con `npx web-push generate-vapid-keys` y complétalas en .env.',
      );
    }
  }
}
