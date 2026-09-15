import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';

interface TraduccionError {
  http: number;
  mensaje: string;
}

/**
 * Traducción de errores de Postgres → HTTP, según CONTRACT.md §4.
 *
 * La mayoría de estos invariantes viven en `prisma/sql/` (índices parciales,
 * EXCLUDE, CHECK, triggers) y Prisma NO los conoce: el nombre del constraint
 * es lo único estable para identificarlos, así que la traducción se hace por
 * nombre de constraint, no por código de Prisma (que para un objeto que
 * Prisma no modela cae en genérico).
 */
const MAPA_CONSTRAINTS: Record<string, TraduccionError> = {
  // 23P01 — EXCLUDE
  reservacion_sin_solape: { http: 409, mensaje: 'Esa mesa ya está reservada en ese horario' },

  // 23505 — únicos (parciales o normales)
  // ⚠️ `comanda_mesa_activa_unica` y `comanda_reservacion_unica` ya NO están
  // aquí: murieron con el rediseño de comandas múltiples. Una mesa puede tener
  // varias comandas vivas y una reserva puede generar varias. Si alguien los
  // recrea en la base, `99_verificar_objetos.sql` lo grita (lista `difuntos`).
  plantilla_activa_unica: { http: 409, mensaje: 'Ese salón ya tiene una plantilla activa' },
  mesa_etiqueta_unica: { http: 409, mensaje: 'Ya existe una mesa con ese número' },
  salon_nombre_unico: { http: 409, mensaje: 'Ya existe un salón con ese nombre' },
  categoria_nombre_unica: { http: 409, mensaje: 'Ya existe una categoría con ese nombre' },
  producto_nombre_unico: { http: 409, mensaje: 'Ya existe un producto activo con ese nombre' },
  producto_codigo_unico: { http: 409, mensaje: 'Ya existe un producto activo con ese código' },
  comanda_numero_dia_unico: {
    http: 500,
    mensaje: 'Error interno: el número de comanda se generó sin pasar por el contador',
  },
  cobro_numero_dia_unico: {
    http: 500,
    mensaje: 'Error interno: el número de factura se generó sin pasar por el contador del día',
  },
  usuario_unico_por_restaurante: { http: 409, mensaje: 'Ya existe un usuario con ese nombre de usuario' },
  reservacion_codigo_publico_key: { http: 500, mensaje: 'Error interno generando el código de la reserva' },
  restaurante_slug_key: { http: 409, mensaje: 'Ya existe un restaurante con ese slug' },
  tasa_cambio_dia_unica: {
    http: 409,
    mensaje: 'Ya existe una tasa registrada para esa divisa, fecha y fuente',
  },

  // 23503 — FK
  plantilla_mesa_restaurante_id_mesa_id_fkey: {
    http: 422,
    mensaje: 'La mesa no existe o no pertenece a este restaurante',
  },
  // `DELETE /plantillas/:id` es un borrado lógico (UPDATE) desde
  // `PlantillasService.eliminar`, así que ya NO dispara estas dos FK RESTRICT
  // (comanda/reservacion → plantilla). Se dejan como red de seguridad: si
  // algún otro camino intentara un DELETE físico, esto sigue explicando el
  // 422 en vez de caer en el genérico de MAPA_SQLSTATE ('El registro
  // referenciado no existe'), que no dice qué hacer.
  comanda_restaurante_id_plantilla_id_fkey: {
    http: 422,
    mensaje: 'No se puede eliminar: esta plantilla tiene comandas asociadas',
  },
  reservacion_restaurante_id_plantilla_id_fkey: {
    http: 422,
    mensaje: 'No se puede eliminar: esta plantilla tiene reservaciones asociadas',
  },

  // 23514 — CHECK / trigger de validación
  // Borrado lógico de plantilla: una plantilla borrada no puede reactivarse
  // ni quedar como la activa del salón (ver PlantillasService.eliminar/activar).
  plantilla_eliminada_no_activa: { http: 422, mensaje: 'No se puede activar una distribución eliminada' },
  plantilla_mesa_mismo_salon: { http: 422, mensaje: 'Esa mesa pertenece a otro salón' },
  plantilla_mesa_capacidad_valida: { http: 422, mensaje: 'La capacidad debe estar entre 1 y 50' },
  plantilla_mesa_rotacion_valida: { http: 422, mensaje: 'La rotación debe estar entre 0 y 359 grados' },
  plantilla_mesa_tamano_valido: { http: 422, mensaje: 'El ancho y el alto deben ser mayores que 0' },
  plantilla_mesa_posicion_valida: { http: 422, mensaje: 'La posición no puede ser negativa' },
  mesa_capacidad_valida: { http: 422, mensaje: 'La capacidad por defecto debe estar entre 1 y 50' },
  mesa_etiqueta_no_vacia: { http: 422, mensaje: 'La etiqueta de la mesa no puede estar vacía' },
  plantilla_plano_valido: { http: 422, mensaje: 'El ancho y el alto del plano deben ser mayores que 0' },
  reservacion_rango_valido: { http: 422, mensaje: 'La reserva debe terminar después de que empieza' },
  reservacion_personas_valida: { http: 422, mensaje: 'El número de personas debe estar entre 1 y 200' },
  producto_precio_valido: { http: 422, mensaje: 'El precio no puede ser negativo' },
  producto_costo_valido: { http: 422, mensaje: 'El costo no puede ser negativo' },
  comanda_item_cantidad_valida: { http: 422, mensaje: 'La cantidad debe ser mayor que 0' },
  comanda_item_precio_valido: { http: 422, mensaje: 'El precio del ítem no puede ser negativo' },
  comanda_item_descuento_valido: { http: 422, mensaje: 'El descuento de línea no puede ser negativo' },
  comanda_tipo_coherente: {
    http: 422,
    mensaje: 'Una comanda de mesa exige mesa, salón y plantilla; una para llevar no lleva mesa',
  },
  comanda_total_valido: { http: 422, mensaje: 'El total de la comanda no puede ser negativo' },
  comanda_anulada_no_cobrada: {
    http: 409,
    mensaje: 'Una comanda cobrada no se puede anular, ni una anulada cobrar',
  },
  comanda_anulacion_coherente: {
    http: 422,
    mensaje: 'El motivo de anulación sólo se guarda al anular la comanda',
  },
  // Regla de negocio confirmada por el dueño: se cobra sólo lo que ya salió de
  // cocina; lo pendiente se queda y arranca la cuenta siguiente de la mesa.
  comanda_cobro_tras_despacho: {
    http: 409,
    mensaje: 'No se puede cobrar una comanda que la cocina todavía no despachó',
  },
  // El guardián de las líneas. Es 409 y no 422 porque no son datos malos: es
  // que el pedido ya salió y llega tarde.
  comanda_item_solo_pendiente: {
    http: 409,
    mensaje: 'Esa comanda ya salió de cocina o se cobró: sus líneas no se pueden cambiar',
  },
  comanda_item_cancelacion_coherente: {
    http: 422,
    mensaje: 'El motivo de cancelación sólo se guarda al anular la línea',
  },
  cobro_totales_validos: { http: 422, mensaje: 'Los totales del cobro no pueden ser negativos' },
  cobro_tipo_coherente: { http: 422, mensaje: 'Un cobro con mesa exige también su salón' },
  cobro_anulacion_coherente: {
    http: 422,
    mensaje: 'El motivo de anulación sólo se guarda al anular el cobro',
  },
  // ⭐ La factura fantasma: dos cajeros cobraron la misma mesa y el segundo se
  // quedó sin comandas que cubrir. Es 409 porque el cajero tiene que saber que
  // no cobre otra vez — la mesa ya está paga.
  cobro_no_vacio: {
    http: 409,
    mensaje: 'Esa cuenta ya la cobró otro cajero: la factura no cubriría ninguna comanda',
  },
  cobro_pago_monto_valido: { http: 422, mensaje: 'El monto del pago debe ser mayor que 0' },
  cobro_pago_referencia_obligatoria: {
    http: 422,
    mensaje: 'Pago móvil y transferencia exigen un número de referencia',
  },
  cobro_pago_tasa_coherente: {
    http: 422,
    mensaje: 'Un pago en Bs exige la tasa aplicada; uno en USD no debe llevarla',
  },
  tasa_valor_valido: { http: 422, mensaje: 'La tasa debe ser mayor que 0' },
  // Estos dos son la red que impide cobrar en bolívares usando la cotización
  // del euro. Si alguna vez aparecen en producción, NO es un error del
  // usuario: es que una consulta de tasa perdió su filtro `divisa: 'USD'`.
  // `comanda_tasa_base` se llama `cobro_tasa_base` desde que la tasa se congela
  // en la factura y no en la comanda.
  cobro_tasa_base: {
    http: 500,
    mensaje: 'Error interno: se intentó cobrar con una tasa que no es la del dólar',
  },
  tasa_divisa_inmutable: {
    http: 422,
    mensaje: 'No se puede cambiar la divisa de una tasa ya registrada; registra otra',
  },
};

const MAPA_SQLSTATE: Record<string, TraduccionError> = {
  '23P01': { http: 409, mensaje: 'Ese recurso ya está reservado / ocupado en ese rango' },
  '23505': { http: 409, mensaje: 'Ya existe un registro con esos datos' },
  '23503': { http: 422, mensaje: 'El registro referenciado no existe' },
  '23514': { http: 422, mensaje: 'Los datos no cumplen una regla de negocio' },
  '22007': { http: 422, mensaje: 'Fecha u hora con formato inválido' },
  // 31 de febrero: el formato es correcto pero la fecha no existe. Sin esta
  // línea un `?fecha=2026-02-31` cae en el 500 genérico.
  '22008': { http: 422, mensaje: 'Esa fecha no existe en el calendario' },
  '22P02': { http: 422, mensaje: 'Valor con formato inválido' },
};

function extraerNombreConstraint(mensaje: string | undefined): string | undefined {
  if (!mensaje) return undefined;
  const patrones = [
    /constraint "([a-zA-Z0-9_]+)"/,
    /constraint `([a-zA-Z0-9_]+)`/,
    /índice "([a-zA-Z0-9_]+)"/,
    /index "([a-zA-Z0-9_]+)"/,
  ];
  for (const patron of patrones) {
    const m = mensaje.match(patron);
    if (m) return m[1];
  }
  return undefined;
}

function extraerSqlstate(mensaje: string | undefined): string | undefined {
  if (!mensaje) return undefined;
  const m = mensaje.match(/\b(2[0-9A-Z]{4})\b/);
  return m ? m[1] : undefined;
}

@Catch()
export class PgErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(PgErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    // Las excepciones HTTP normales (NotFoundException, BadRequestException de
    // class-validator, las nuestras propias, etc.) pasan intactas.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }

    const traduccion = this.traducir(exception);
    if (traduccion) {
      res.status(traduccion.http).json({ statusCode: traduccion.http, message: traduccion.mensaje });
      return;
    }

    this.logger.error('Error no controlado', exception instanceof Error ? exception.stack : exception);
    res.status(500).json({ statusCode: 500, message: 'Error interno del servidor' });
  }

  private traducir(exception: unknown): TraduccionError | undefined {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (process.env.DEBUG_PG_ERRORS === '1') {
        this.logger.warn(`DEBUG code=${exception.code} meta=${JSON.stringify(exception.meta)} msg=${exception.message}`);
      }
      // Prisma 7 + @prisma/adapter-pg: el error real del driver `pg` viaja en
      // meta.driverAdapterError.cause, con el SQLSTATE y el nombre del
      // constraint/índice ya separados — la fuente más confiable.
      const driverCause = (exception.meta as any)?.driverAdapterError?.cause;
      if (driverCause) {
        const nombreDriver =
          driverCause.constraint?.index ??
          driverCause.constraint?.name ??
          (typeof driverCause.constraint === 'string' ? driverCause.constraint : undefined) ??
          extraerNombreConstraint(driverCause.originalMessage);
        if (nombreDriver && MAPA_CONSTRAINTS[nombreDriver]) return MAPA_CONSTRAINTS[nombreDriver];

        const sqlstateDriver = driverCause.originalCode;
        if (sqlstateDriver && MAPA_SQLSTATE[sqlstateDriver]) return MAPA_SQLSTATE[sqlstateDriver];
      }

      const metaMensaje =
        (typeof exception.meta?.message === 'string' && exception.meta.message) ||
        (typeof (exception.meta as any)?.cause === 'string' && (exception.meta as any).cause) ||
        undefined;
      const nombre = extraerNombreConstraint(metaMensaje ?? exception.message);
      if (nombre && MAPA_CONSTRAINTS[nombre]) return MAPA_CONSTRAINTS[nombre];

      const sqlstate =
        (typeof exception.meta?.code === 'string' ? exception.meta.code : undefined) ??
        extraerSqlstate(metaMensaje ?? exception.message);
      if (sqlstate && MAPA_SQLSTATE[sqlstate]) return MAPA_SQLSTATE[sqlstate];

      switch (exception.code) {
        case 'P2002':
          return { http: 409, mensaje: 'Ya existe un registro con esos datos' };
        case 'P2003':
          return { http: 422, mensaje: 'El registro referenciado no existe' };
        case 'P2025':
          return { http: 404, mensaje: 'Registro no encontrado' };
        case 'P2004':
          return { http: 422, mensaje: 'Los datos no cumplen una regla de negocio' };
        default:
          return undefined;
      }
    }

    if (
      exception instanceof Prisma.PrismaClientUnknownRequestError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      const nombre = extraerNombreConstraint(exception.message);
      if (nombre && MAPA_CONSTRAINTS[nombre]) return MAPA_CONSTRAINTS[nombre];
      const sqlstate = extraerSqlstate(exception.message);
      if (sqlstate && MAPA_SQLSTATE[sqlstate]) return MAPA_SQLSTATE[sqlstate];
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return { http: 422, mensaje: 'Datos inválidos para la operación solicitada' };
    }

    return undefined;
  }
}
