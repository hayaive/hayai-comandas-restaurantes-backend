import {
  BadRequestException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../comun/prisma/prisma.service';
import { UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';
import { base32 } from '../comun/codigos';
import { nuevoId } from '../comun/id';
import { AuthService } from '../auth/auth.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { Prisma } from '../generated/prisma/client';
import {
  ActualizarAccesoDto,
  CanjearAccesoDto,
  ConsultarAccesoDto,
  CrearAccesoDto,
  DuracionAcceso,
  INTERVALO_POR_DURACION,
  RegenerarAccesoDto,
} from './dto/acceso.dto';

/**
 * Fallos seguidos a partir de los cuales se avisa al dueño. Se avisa cuando el
 * contador llega EXACTAMENTE aquí, no "a partir de": con `>=` cada intento
 * siguiente mandaría otro push, y un ataque de 10.000 intentos serían 10.000
 * vibraciones en el teléfono del dueño.
 */
const UMBRAL_AVISO_FALLOS = 10;

/** 32 caracteres base32 Crockford = 160 bits. Cualquier otra forma no es un token nuestro. */
const FORMA_TOKEN = /^[0-9A-HJKMNP-TV-Z]{32}$/;

const MENSAJE_ENLACE_INVALIDO = 'Este enlace de acceso no es válido';
const MENSAJE_ACCESO_VENCIDO = 'Este acceso ya venció. Pide uno nuevo';
const MENSAJE_NO_ENCONTRADO = 'Acceso no encontrado o ya vencido';

/**
 * El token del enlace: 160 bits aleatorios en base32 Crockford (32
 * caracteres). ⚠️ NUNCA en hex: el CHECK `invitacion_acceso_enlace_es_hash`
 * distingue el hash del token precisamente porque el token jamás es hex
 * minúscula de 64 caracteres. Un token hex guardado en claro por error
 * pasaría el CHECK.
 */
function generarTokenEnlace(): string {
  return base32(randomBytes(20));
}

/** SHA-256 en hex minúscula: lo único que se guarda del token (se busca por índice). */
function hashDeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 4 dígitos con `randomInt` (CSPRNG), nunca `Math.random`. */
function generarCodigo(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

function hashDeCodigo(codigo: string): Promise<string> {
  // argon2id explícito: el CHECK `invitacion_acceso_codigo_es_argon2` exige ese prefijo.
  return argon2.hash(codigo, { type: argon2.argon2id });
}

/** `<URL_PUBLICA>/acceso/<slug>#<TOKEN>`. El token va en el FRAGMENTO: el navegador no lo manda a ningún servidor. */
function armarEnlace(slug: string, token: string): string {
  const base = (process.env.URL_PUBLICA ?? 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/acceso/${encodeURIComponent(slug)}#${token}`;
}

/** Filtro de "acceso VIVO": temporal, activo y sin vencer. Permanentes (`NULL`) nunca entran. */
function filtroVivo(restauranteId: string, id?: string): Prisma.UsuarioWhereInput {
  return {
    ...(id ? { id } : {}),
    restauranteId,
    activo: true,
    accesoHasta: { gt: new Date() },
  };
}

/**
 * Accesos temporales: la pantalla "Meseros" del dueño y el canje público del
 * enlace. Diseño de datos: J.O.R.B.I, docs/DECISIONES-DATOS.md §13.
 *
 * La persona es un `usuario` con `acceso_hasta`; la credencial (enlace +
 * código) vive en `invitacion_acceso` y sólo como hash. El enlace y el código
 * EN CLARO existen una sola vez: en la respuesta de `crear` o `regenerar`.
 */
@Injectable()
export class AccesosService {
  private readonly logger = new Logger(AccesosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly notificaciones: NotificacionesService,
  ) {}

  // ═════════════════════════ Vencimientos ═════════════════════════

  /**
   * Cuándo vencería un acceso creado AHORA con cada atajo, para que la UI
   * muestre "Vence: sáb 05:00" antes de confirmar. Lo calcula la base
   * (`hayai_fin_acceso`), igual que al crear: la regla del día operativo tiene
   * una sola definición (docs §5).
   *
   * Ojo: "hoy" pedido a las 04:59 dura un minuto — vence en el corte de las
   * 05:00. Es la regla (hoy = hasta el cierre del día operativo en curso), y
   * por eso se enseña antes de confirmar.
   */
  async vencimientos(restauranteId: string) {
    const filas = await this.prisma.$queryRaw<{ hoy: Date; dos_dias: Date; una_semana: Date; un_mes: Date }[]>`
      SELECT hayai_fin_acceso(now(), r."zona_horaria", r."hora_corte_dia", ${INTERVALO_POR_DURACION.hoy}::interval)        AS "hoy",
             hayai_fin_acceso(now(), r."zona_horaria", r."hora_corte_dia", ${INTERVALO_POR_DURACION['2_dias']}::interval)   AS "dos_dias",
             hayai_fin_acceso(now(), r."zona_horaria", r."hora_corte_dia", ${INTERVALO_POR_DURACION['1_semana']}::interval) AS "una_semana",
             hayai_fin_acceso(now(), r."zona_horaria", r."hora_corte_dia", ${INTERVALO_POR_DURACION['1_mes']}::interval)    AS "un_mes"
        FROM "restaurante" r
       WHERE r."id" = ${restauranteId}::uuid
    `;
    const fila = filas[0];
    if (!fila) throw new NotFoundException('Restaurante no encontrado');
    return {
      hoy: fila.hoy.toISOString(),
      dosDias: fila.dos_dias.toISOString(),
      unaSemana: fila.una_semana.toISOString(),
      unMes: fila.un_mes.toISOString(),
    };
  }

  /** El fin de un acceso con ese atajo, calculado por la base desde AHORA. */
  private async finAcceso(
    cliente: Prisma.TransactionClient | PrismaService,
    restauranteId: string,
    duracion: DuracionAcceso,
  ): Promise<Date> {
    const filas = await cliente.$queryRaw<{ fin: Date | null }[]>`
      SELECT hayai_fin_acceso(now(), r."zona_horaria", r."hora_corte_dia", ${INTERVALO_POR_DURACION[duracion]}::interval) AS "fin"
        FROM "restaurante" r
       WHERE r."id" = ${restauranteId}::uuid
    `;
    const fin = filas[0]?.fin;
    // Nunca se sigue con un NULL: un `acceso_hasta` NULL sería un usuario
    // PERMANENTE (el CHECK `usuario_credenciales_coherentes` lo rechazaría
    // igual, por no tener clave, pero no se llega ahí).
    if (!fin) throw new NotFoundException('Restaurante no encontrado');
    return fin;
  }

  // ═════════════════════════ Gestión (administrador) ═════════════════════════

  /**
   * `POST /accesos`. Usuario (rol `mesero`, sin clave ni PIN) + su invitación,
   * en UNA transacción: un usuario temporal sin invitación sería una persona
   * que no puede entrar de ninguna forma.
   *
   * Los hashes (Argon2 es lento a propósito) se calculan ANTES de abrir la
   * transacción, para no tener bloqueos abiertos mientras tanto.
   */
  async crear(sesion: UsuarioSesion, dto: CrearAccesoDto) {
    const restauranteId = sesion.restauranteId;
    const restaurante = await this.prisma.restaurante.findUniqueOrThrow({
      where: { id: restauranteId },
      select: { slug: true },
    });

    const token = generarTokenEnlace();
    const codigo = generarCodigo();
    const enlaceHash = hashDeToken(token);
    const codigoHash = await hashDeCodigo(codigo);
    const id = nuevoId();

    const usuario = await this.prisma.$transaction(async (tx) => {
      const accesoHasta = await this.finAcceso(tx, restauranteId, dto.duracion);
      const creado = await tx.usuario.create({
        data: {
          id,
          restauranteId,
          nombre: dto.nombre,
          // No sirve para entrar (login() y loginPin() filtran
          // `accesoHasta: null`): existe porque la columna es NOT NULL y
          // clave natural del login. 40 bits bastan para no chocar.
          usuario: `acceso-${base32(randomBytes(5))}`,
          claveHash: null,
          pinHash: null,
          rol: 'mesero',
          modulos: dto.modulos,
          accesoHasta,
        },
      });
      await tx.invitacionAcceso.create({
        data: {
          restauranteId,
          usuarioId: id,
          enlaceHash,
          codigoHash,
          otorgadaPorId: sesion.id,
        },
      });
      return creado;
    });

    return {
      acceso: {
        id: usuario.id,
        nombre: usuario.nombre,
        modulos: usuario.modulos,
        accesoHasta: usuario.accesoHasta,
        creadoEn: usuario.creadoEn,
      },
      // ⚠️ Única vez que salen en claro. Después sólo existen en el WhatsApp
      // del mesero; si se pierden, se regeneran.
      enlace: armarEnlace(restaurante.slug, token),
      codigo,
    };
  }

  /**
   * `GET /accesos` — sólo los VIVOS, el que vence antes primero. Los vencidos
   * no se borran (sus comandas los retienen): desaparecen de aquí por fecha.
   * Nunca sale un hash, el enlace ni el código.
   */
  async listar(restauranteId: string) {
    const filas = await this.prisma.usuario.findMany({
      where: filtroVivo(restauranteId),
      orderBy: { accesoHasta: 'asc' },
      select: {
        id: true,
        nombre: true,
        modulos: true,
        accesoHasta: true,
        ultimoAccesoEn: true,
        invitacion: { select: { fallosConsecutivos: true, ultimoFalloEn: true } },
      },
    });
    return filas.map((f) => ({
      id: f.id,
      nombre: f.nombre,
      modulos: f.modulos,
      accesoHasta: f.accesoHasta,
      ultimoAccesoEn: f.ultimoAccesoEn,
      fallosConsecutivos: f.invitacion?.fallosConsecutivos ?? 0,
      ultimoFalloEn: f.invitacion?.ultimoFalloEn ?? null,
    }));
  }

  private async uno(restauranteId: string, id: string) {
    const f = await this.prisma.usuario.findFirst({
      where: filtroVivo(restauranteId, id),
      select: {
        id: true,
        nombre: true,
        modulos: true,
        accesoHasta: true,
        ultimoAccesoEn: true,
        invitacion: { select: { fallosConsecutivos: true, ultimoFalloEn: true } },
      },
    });
    if (!f) throw new NotFoundException(MENSAJE_NO_ENCONTRADO);
    return {
      id: f.id,
      nombre: f.nombre,
      modulos: f.modulos,
      accesoHasta: f.accesoHasta,
      ultimoAccesoEn: f.ultimoAccesoEn,
      fallosConsecutivos: f.invitacion?.fallosConsecutivos ?? 0,
      ultimoFalloEn: f.invitacion?.ultimoFalloEn ?? null,
    };
  }

  /**
   * `PATCH /accesos/:id`. Sólo sobre un acceso VIVO (si no, 404): uno vencido
   * no se resucita, se crea otro. `duracion` cuenta desde AHORA con la misma
   * regla del corte que al crear.
   *
   * `updateMany` con el filtro de vivo en el WHERE, no leer-y-luego-escribir:
   * si el dueño revoca desde otro aparato en medio, esto no lo revive.
   */
  async actualizar(restauranteId: string, id: string, dto: ActualizarAccesoDto) {
    const data: Prisma.UsuarioUpdateManyMutationInput = {};
    if (dto.nombre !== undefined) data.nombre = dto.nombre;
    if (dto.modulos !== undefined) data.modulos = dto.modulos;
    if (dto.duracion !== undefined) data.accesoHasta = await this.finAcceso(this.prisma, restauranteId, dto.duracion);

    if (Object.keys(data).length > 0) {
      const { count } = await this.prisma.usuario.updateMany({ where: filtroVivo(restauranteId, id), data });
      if (count === 0) throw new NotFoundException(MENSAJE_NO_ENCONTRADO);
    }
    return this.uno(restauranteId, id);
  }

  /**
   * `POST /accesos/:id/regenerar`. Emite enlace y/o código nuevos (el viejo
   * deja de servir en el acto) y pone el contador de fallos a cero: los
   * intentos contra la credencial anterior ya no dicen nada de la nueva.
   *
   * El trigger `invitacion_acceso_solo_temporal` vuelve a comprobar en la base
   * que `:id` es un acceso temporal VIGENTE: aunque este servicio se
   * equivocara, no se puede colgar una credencial de 4 dígitos de un usuario
   * permanente.
   */
  async regenerar(sesion: UsuarioSesion, id: string, dto: RegenerarAccesoDto) {
    const restauranteId = sesion.restauranteId;
    const pidioAlguno = dto.enlace !== undefined || dto.codigo !== undefined;
    const nuevoEnlace = pidioAlguno ? dto.enlace === true : true;
    const nuevoCodigo = pidioAlguno ? dto.codigo === true : true;
    if (!nuevoEnlace && !nuevoCodigo) {
      throw new BadRequestException('No hay nada que regenerar: pide enlace, codigo o ambos');
    }

    const vivo = await this.prisma.usuario.findFirst({
      where: filtroVivo(restauranteId, id),
      select: { id: true, restaurante: { select: { slug: true } } },
    });
    if (!vivo) throw new NotFoundException(MENSAJE_NO_ENCONTRADO);

    const token = nuevoEnlace ? generarTokenEnlace() : undefined;
    const codigo = nuevoCodigo ? generarCodigo() : undefined;

    const { count } = await this.prisma.invitacionAcceso.updateMany({
      where: { restauranteId, usuarioId: id },
      data: {
        ...(token ? { enlaceHash: hashDeToken(token) } : {}),
        ...(codigo ? { codigoHash: await hashDeCodigo(codigo) } : {}),
        fallosConsecutivos: 0,
        ultimoFalloEn: null,
        otorgadaPorId: sesion.id,
        emitidaEn: new Date(),
      },
    });
    if (count === 0) throw new NotFoundException(MENSAJE_NO_ENCONTRADO);

    return {
      ...(token ? { enlace: armarEnlace(vivo.restaurante.slug, token) } : {}),
      ...(codigo ? { codigo } : {}),
    };
  }

  /**
   * `DELETE /accesos/:id` — revocar antes de tiempo. NO borra al usuario (sus
   * comandas y cobros lo retienen, y tienen que seguir a su nombre para
   * cuadrar caja): le pone `acceso_hasta = ahora` y borra su credencial. Desde
   * la siguiente petición `JwtStrategy.validate` lo rechaza.
   *
   * También borra sus suscripciones push (regla dura §10 del diseño de push:
   * desactivar a alguien borra sus aparatos). El envío ya lo filtraría por
   * vigencia; esto es para no guardar un canal de escritura hacia el teléfono
   * de alguien que ya no trabaja aquí.
   */
  async eliminar(restauranteId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.usuario.updateMany({
        where: filtroVivo(restauranteId, id),
        data: { accesoHasta: new Date() },
      });
      if (count === 0) throw new NotFoundException(MENSAJE_NO_ENCONTRADO);
      await tx.invitacionAcceso.deleteMany({ where: { restauranteId, usuarioId: id } });
      await tx.suscripcionPush.deleteMany({ where: { restauranteId, usuarioId: id } });
    });
  }

  // ═════════════════════════ Canje público del enlace ═════════════════════════

  /**
   * Resuelve el enlace. 404 si no es un enlace nuestro (restaurante, forma del
   * token o hash que no existe); 410 si lo fue pero el acceso ya venció.
   *
   * La búsqueda exige `acceso_hasta IS NOT NULL` — ESTRICTO, sin la rama
   * `IS NULL` de la sesión: una invitación colgada de un usuario permanente
   * (el trigger ya lo impide) sería inerte aquí igualmente.
   */
  private async resolverEnlace(dto: ConsultarAccesoDto) {
    const restaurante = await this.prisma.restaurante.findFirst({
      where: { slug: dto.restaurante, activo: true },
      select: { id: true, nombre: true, logoUrl: true },
    });
    if (!restaurante) throw new NotFoundException(MENSAJE_ENLACE_INVALIDO);

    // Crockford es insensible a mayúsculas; el token se emite en mayúscula.
    const token = dto.token.trim().toUpperCase();
    if (!FORMA_TOKEN.test(token)) throw new NotFoundException(MENSAJE_ENLACE_INVALIDO);

    const invitacion = await this.prisma.invitacionAcceso.findFirst({
      where: {
        enlaceHash: hashDeToken(token),
        restauranteId: restaurante.id,
        usuario: { accesoHasta: { not: null } },
      },
      include: { usuario: true },
    });
    if (!invitacion) throw new NotFoundException(MENSAJE_ENLACE_INVALIDO);

    const { usuario } = invitacion;
    if (!usuario.activo || !usuario.accesoHasta || usuario.accesoHasta <= new Date()) {
      throw new GoneException(MENSAJE_ACCESO_VENCIDO);
    }
    return { restaurante, invitacion, usuario };
  }

  /**
   * `POST /auth/acceso/consultar` — lo que la pantalla del enlace necesita
   * para saludar ("Hola, Pedro — Restaurante X") antes de pedir el código.
   * NO toca contadores: abrir el enlace no es un intento.
   */
  async consultar(dto: ConsultarAccesoDto) {
    const { restaurante, usuario } = await this.resolverEnlace(dto);
    return {
      restaurante: { nombre: restaurante.nombre, logoUrl: restaurante.logoUrl },
      nombre: usuario.nombre,
      accesoHasta: usuario.accesoHasta,
    };
  }

  /**
   * `POST /auth/acceso` — el canje. Código bueno: sesión. Código malo: 401 y
   * el contador sube.
   *
   * ⚠️ DECISIÓN DEL DUEÑO: no se bloquea NUNCA ni se frena por intentos. Un
   * bloqueo lo sufriría el mesero de verdad en mitad del servicio. La defensa
   * es que el código no sirve sin el enlace (160 bits), y el aviso push al
   * llegar a `UMBRAL_AVISO_FALLOS`.
   */
  async canjear(dto: CanjearAccesoDto) {
    const { restaurante, invitacion, usuario } = await this.resolverEnlace(dto);

    const valido = await argon2.verify(invitacion.codigoHash, dto.codigo).catch(() => false);
    if (!valido) {
      // Atómico (`+ 1` en la base, no leer-sumar-escribir): dos intentos a la
      // vez cuentan dos. RETURNING da el valor nuevo para decidir el aviso.
      // No pasa por el trigger: `UPDATE OF` no incluye estas columnas.
      const filas = await this.prisma.$queryRaw<{ fallos_consecutivos: number }[]>`
        UPDATE "invitacion_acceso"
           SET "fallos_consecutivos" = "fallos_consecutivos" + 1,
               "ultimo_fallo_en"     = now()
         WHERE "restaurante_id" = ${restaurante.id}::uuid
           AND "usuario_id"     = ${usuario.id}::uuid
        RETURNING "fallos_consecutivos"
      `;
      if (filas[0]?.fallos_consecutivos === UMBRAL_AVISO_FALLOS) {
        // Fuera de cualquier transacción y sin await bloqueante: el 401 no
        // espera al servicio de push.
        this.notificaciones
          .notificarAccesoSospechoso(restaurante.id, usuario.nombre, usuario.id)
          .catch((error: unknown) =>
            this.logger.warn(`No se pudo avisar de intentos sospechosos: ${(error as Error)?.message ?? error}`),
          );
      }
      throw new UnauthorizedException('Código incorrecto');
    }

    if (invitacion.fallosConsecutivos > 0) {
      await this.prisma.invitacionAcceso.updateMany({
        where: { restauranteId: restaurante.id, usuarioId: usuario.id },
        data: { fallosConsecutivos: 0 },
      });
    }

    // Misma emisión que el login: el JWT dura lo que le quede de acceso (tope
    // 12 h) y `usuario` sale sanitizado con los `modulos` efectivos.
    return this.auth.emitirSesion(usuario);
  }
}
