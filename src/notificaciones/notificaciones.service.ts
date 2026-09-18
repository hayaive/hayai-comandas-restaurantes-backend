import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../comun/prisma/prisma.service';
import { nuevoId } from '../comun/id';
import { SuscripcionPush, TemaNotificacion } from '../generated/prisma/client';
import { VapidConfigService } from './vapid.config';
import { ROLES_POR_TEMA } from './temas';
import { ActualizarSuscripcionDto, EliminarSuscripcionDto, RegistrarSuscripcionDto } from './dto/push.dto';

/**
 * Fila cruda que trae la consulta caliente de envío: sólo lo indispensable
 * para armar la petición HTTP de push. Nunca sale de este archivo.
 */
interface DestinatarioPush {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Lo mínimo de una comanda recién creada que hace falta para decidir a quién avisar. */
export interface ComandaParaNotificar {
  id: string;
  numeroDia: number;
  mesaId: string | null;
  items: { destinoSnap: string }[];
}

/**
 * `endpoint`, `p256dh` y `auth` son un CANAL DE ESCRITURA hacia el teléfono de
 * una persona: se tratan como `clave_hash` (nunca por la API, nunca en un
 * log). Precedente en el repo: `sanitizar()` de `auth.service.ts`.
 */
function sanitizarCompleta(s: SuscripcionPush) {
  return {
    id: s.id,
    temas: s.temas,
    etiqueta: s.etiqueta,
    creadaEn: s.creadaEn,
    renovadaEn: s.renovadaEn,
  };
}

function sanitizarParaLista(s: SuscripcionPush) {
  return {
    id: s.id,
    etiqueta: s.etiqueta,
    agenteUsuario: s.agenteUsuario,
    temas: s.temas,
    creadaEn: s.creadaEn,
    renovadaEn: s.renovadaEn,
  };
}

@Injectable()
export class NotificacionesService {
  private readonly logger = new Logger(NotificacionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vapid: VapidConfigService,
  ) {}

  // ═════════════════════════ Configuración ═════════════════════════

  /** GET /push/vapid. 503 (no 500) si el servidor no tiene VAPID configurado: es un estado esperado, no un bug. */
  obtenerClavePublica() {
    if (!this.vapid.configurado || !this.vapid.clavePublica) {
      throw new ServiceUnavailableException('Web Push no está configurado en este servidor');
    }
    return { clavePublica: this.vapid.clavePublica };
  }

  // ═════════════════════════ Suscripciones (CRUD del aparato) ═════════════════════════

  /**
   * POST /push/suscripciones — upsert atómico por `endpoint` (regla dura §7:
   * nunca SELECT-luego-INSERT, dos pestañas registrando a la vez pierden la
   * carrera contra el único).
   *
   * El único motivo del `findUnique` previo es decidir qué hacer con
   * `etiqueta` en un traspaso (regla dura §8): si el endpoint ya pertenecía a
   * OTRO restaurante, la etiqueta del dueño anterior no debe sobrevivir. Si es
   * el mismo restaurante (alta nueva o el latido de renovación de cada
   * arranque de la app), la etiqueta NO se toca aquí — renombrar el aparato es
   * trabajo del PATCH, no de este POST. Una carrera entre este `findUnique` y
   * el `upsert` sólo podría dejar una `etiqueta` con un valor "de más" en una
   * ventana de milisegundos, nunca duplicar la fila ni perder el aislamiento
   * por tenant: eso lo sigue garantizando el `upsert` atómico sobre el único.
   */
  async registrar(
    restauranteId: string,
    usuarioId: string,
    dto: RegistrarSuscripcionDto,
    agenteUsuarioCrudo: string | undefined,
  ) {
    if (!this.vapid.configurado || !this.vapid.kid) {
      throw new ServiceUnavailableException('Web Push no está configurado en este servidor');
    }

    const agenteUsuario = agenteUsuarioCrudo?.slice(0, 300);
    const expiraEn = dto.expirationTime != null ? new Date(dto.expirationTime) : null;

    const existente = await this.prisma.suscripcionPush.findUnique({ where: { endpoint: dto.endpoint } });
    const mismoRestaurante = existente?.restauranteId === restauranteId;
    const etiqueta = existente ? (mismoRestaurante ? existente.etiqueta : null) : (dto.etiqueta ?? null);

    const suscripcion = await this.prisma.suscripcionPush.upsert({
      where: { endpoint: dto.endpoint },
      create: {
        id: nuevoId(),
        restauranteId,
        usuarioId,
        endpoint: dto.endpoint,
        p256dh: dto.p256dh,
        auth: dto.auth,
        expiraEn,
        temas: dto.temas,
        vapidKid: this.vapid.kid,
        etiqueta,
        agenteUsuario,
      },
      update: {
        // Limpieza del dueño anterior en cada registro/renovación (regla dura
        // §8): estos campos SIEMPRE se pisan con lo que trae la petición.
        restauranteId,
        usuarioId,
        p256dh: dto.p256dh,
        auth: dto.auth,
        expiraEn,
        temas: dto.temas,
        vapidKid: this.vapid.kid,
        etiqueta,
        agenteUsuario,
        renovadaEn: new Date(),
      },
    });

    return sanitizarCompleta(suscripcion);
  }

  /** GET /push/suscripciones — sólo LOS APARATOS DEL USUARIO ACTUAL ("tus dispositivos"), no los del restaurante entero. */
  async listar(restauranteId: string, usuarioId: string) {
    const filas = await this.prisma.suscripcionPush.findMany({
      where: { restauranteId, usuarioId },
      orderBy: { creadaEn: 'desc' },
    });
    return filas.map(sanitizarParaLista);
  }

  /** PATCH /push/suscripciones/:id — sólo temas/etiqueta, y sólo sobre un aparato propio. */
  async actualizar(restauranteId: string, usuarioId: string, id: string, dto: ActualizarSuscripcionDto) {
    const { count } = await this.prisma.suscripcionPush.updateMany({
      where: { restauranteId, usuarioId, id },
      data: {
        ...(dto.temas !== undefined ? { temas: dto.temas } : {}),
        ...(dto.etiqueta !== undefined ? { etiqueta: dto.etiqueta } : {}),
      },
    });
    if (count === 0) throw new NotFoundException('Suscripción no encontrada');

    const actualizada = await this.prisma.suscripcionPush.findFirstOrThrow({
      where: { restauranteId, usuarioId, id },
    });
    return sanitizarCompleta(actualizada);
  }

  /**
   * DELETE /push/suscripciones — logout, y "olvidar este aparato". Por
   * ENDPOINT (regla dura §3/§10), y con `deleteMany` en vez de `delete` para
   * que sea IDEMPOTENTE: un segundo logout del mismo aparato, o un endpoint
   * que ya no es de este restaurante (se traspasó), no debe devolver 404 —
   * eso filtraría si ese endpoint existe en otro tenant. El estado deseado
   * ("este restaurante no tiene esa suscripción") ya se cumple con 0 filas.
   */
  async eliminarPorEndpoint(restauranteId: string, dto: EliminarSuscripcionDto) {
    await this.prisma.suscripcionPush.deleteMany({ where: { restauranteId, endpoint: dto.endpoint } });
  }

  /**
   * Se llama al desactivar un usuario (borrar sus suscripciones, regla dura
   * §10). No hay endpoint de "desactivar usuario" en el alcance de esta
   * entrega — queda listo para engancharse el día que exista.
   */
  async eliminarDeUsuario(restauranteId: string, usuarioId: string) {
    await this.prisma.suscripcionPush.deleteMany({ where: { restauranteId, usuarioId } });
  }

  // ═════════════════════════ Envío ═════════════════════════

  /**
   * Dispara el aviso de "entró una comanda". Se llama DESPUÉS del commit de
   * `crearComanda()`, nunca dentro de su `$transaction` (regla dura §1): un
   * abanico HTTP dentro de la transacción mantendría bloqueos abiertos
   * mientras responde el peor de los `endpoint` de push, y si hubiera
   * rollback ya se habría avisado de un pedido que no existe.
   *
   * Falla cerrado y en silencio si Web Push no está configurado: el pedido ya
   * se guardó, avisar es una mejora, no un requisito (regla dura §2 — el
   * caller de este método ya lo llama sin `await` bloqueante y con `.catch`).
   */
  async notificarComandaNueva(restauranteId: string, comanda: ComandaParaNotificar) {
    if (!this.vapid.configurado || !this.vapid.kid) return;

    const temas = new Set<TemaNotificacion>();
    for (const item of comanda.items) {
      if (item.destinoSnap === 'cocina') temas.add('comanda_cocina');
      if (item.destinoSnap === 'barra') temas.add('comanda_barra');
    }
    // Comanda enteramente de items sin preparación (destino 'ninguno', p.ej.
    // una bebida embotellada) no dispara ningún tema.
    if (temas.size === 0) return;

    const destinatarios = await this.destinatariosParaTemas(restauranteId, [...temas]);
    if (destinatarios.length === 0) return;

    const mesaEtiqueta = comanda.mesaId
      ? (await this.prisma.mesa.findUnique({ where: { id: comanda.mesaId }, select: { etiqueta: true } }))
          ?.etiqueta
      : null;

    // Payload MÍNIMO y SIN PII (reglas duras de privacidad §3/§4): se muestra
    // en la pantalla de bloqueo de un teléfono que puede estar sobre una mesa.
    // Nunca nombre/teléfono/documento del cliente. Sólo ids + lo que ya se
    // canta en voz alta en el restaurante.
    const payload = JSON.stringify({
      tipo: 'comanda_nueva',
      temas: [...temas],
      comandaId: comanda.id,
      numeroDia: comanda.numeroDia,
      mesa: mesaEtiqueta ?? null,
      items: comanda.items.length,
      titulo: 'Nueva comanda',
      cuerpo: `Comanda #${comanda.numeroDia}${mesaEtiqueta ? ` · Mesa ${mesaEtiqueta}` : ''} · ${comanda.items.length} ítem${comanda.items.length === 1 ? '' : 's'}`,
    });

    await Promise.allSettled(destinatarios.map((d) => this.enviarUno(d, payload)));
  }

  /**
   * La consulta caliente del abanico, una vez por tema, deduplicando por
   * `endpoint`: si un mismo aparato califica para `comanda_cocina` Y
   * `comanda_barra` (una comanda con líneas de los dos destinos), recibe UN
   * solo push, no dos (regla dura del disparo en `comandas.service.ts`).
   *
   * Filtra siempre por `vapid_kid` (regla dura §11): una rotación de claves
   * VAPID se vuelve un no-evento en vez de una tormenta de 403 contra
   * suscripciones que nacieron con el par anterior.
   */
  private async destinatariosParaTemas(
    restauranteId: string,
    temas: TemaNotificacion[],
  ): Promise<DestinatarioPush[]> {
    const porEndpoint = new Map<string, DestinatarioPush>();

    for (const tema of temas) {
      const roles = ROLES_POR_TEMA[tema];
      const filas = await this.prisma.$queryRaw<DestinatarioPush[]>`
        SELECT s."id", s."endpoint", s."p256dh", s."auth"
          FROM "suscripcion_push" s
          JOIN "usuario" u
            ON u."restaurante_id" = s."restaurante_id"
           AND u."id"             = s."usuario_id"
         WHERE s."restaurante_id" = ${restauranteId}::uuid
           AND s."vapid_kid"      = ${this.vapid.kid}
           AND s."temas"          @> ARRAY[${tema}]::"tema_notificacion"[]
           AND u."activo"
           AND u."rol" = ANY(${roles}::"rol_usuario"[])
      `;
      for (const fila of filas) porEndpoint.set(fila.endpoint, fila);
    }

    return [...porEndpoint.values()];
  }

  /**
   * Un envío individual. TTL corto y `urgency: high` para temas de comanda,
   * SIN cabecera `Topic` (regla dura §12): colapsar avisos de pedidos
   * distintos bajo el mismo topic perdería pedidos, no sólo los "des-duplica".
   *
   * El manejo de errores es la parte que muerde si se hace a ojo — son las
   * reglas duras §3/§4/§5 del diseño, una por una:
   */
  private async enviarUno(destinatario: DestinatarioPush, payload: string) {
    try {
      await webpush.sendNotification(
        { endpoint: destinatario.endpoint, keys: { p256dh: destinatario.p256dh, auth: destinatario.auth } },
        payload,
        { TTL: 900, urgency: 'high' },
      );
    } catch (error: unknown) {
      const status = (error as { statusCode?: number })?.statusCode;

      if (status === 404 || status === 410) {
        // Aparato muerto: DELETE por endpoint, no por id (§3) — si entre la
        // lectura y este fallo el aparato se re-suscribió, la fila ya tiene un
        // endpoint nuevo y borrar por id mataría una suscripción viva.
        await this.prisma.suscripcionPush
          .deleteMany({ where: { endpoint: destinatario.endpoint } })
          .catch(() => undefined);
        return;
      }

      if (status === 403 || status === 401) {
        // La clave VAPID del servidor no es la que creó esa suscripción:
        // problema de CONFIGURACIÓN nuestra, no del aparato. Borrar aquí
        // vaciaría la tabla entera durante un despliegue con la variable mal
        // puesta (§4). Se loggea a nivel error con el vapid_kid para que se
        // note en un despliegue, nunca el endpoint.
        this.logger.error(`Push rechazado por VAPID (status ${status}), vapidKid=${this.vapid.kid}`);
        return;
      }

      if (status === 429) {
        // Respetar Retry-After queda fuera de esta entrega (no hay cola de
        // reintentos); se descarta el envío individual — la próxima comanda
        // nueva vuelve a intentar con ese aparato.
        this.logger.warn(`Push retrasado por rate limit (429): ${this.redactarEndpoint(destinatario.endpoint)}`);
        return;
      }

      // Resto de 4xx/5xx: no se borra (§5). El endpoint jamás sale en el log.
      this.logger.warn(
        `Push fallido (status ${status ?? 'desconocido'}): ${this.redactarEndpoint(destinatario.endpoint)}`,
      );
    }
  }

  /** host + últimos 8 caracteres, nunca el endpoint completo (regla dura de privacidad §2). */
  private redactarEndpoint(endpoint: string): string {
    try {
      const url = new URL(endpoint);
      return `${url.host}/…${endpoint.slice(-8)}`;
    } catch {
      return '(endpoint ilegible)';
    }
  }
}
