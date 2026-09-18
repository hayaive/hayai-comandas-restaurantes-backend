import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TemaNotificacion } from '../../generated/prisma/enums';

/**
 * `POST /push/suscripciones` — registra (o RENUEVA, vía upsert por endpoint)
 * un navegador. Validaciones laxas a propósito: los CHECK de
 * `suscripcion_push` en la base son la garantía real (regla dura del diseño:
 * "una fila imposible falla al INSERT y no dentro del bucle de envío"); esto
 * sólo adelanta el 400 más obvio (campo vacío) antes de gastar una consulta.
 */
export class RegistrarSuscripcionDto {
  /** Un endpoint de push es siempre https. El CHECK de la base pone el techo real (2048). */
  @IsString()
  @Matches(/^https:\/\//, { message: 'endpoint debe ser una URL https' })
  @MaxLength(2048)
  endpoint!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  p256dh!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  auth!: string;

  /** `PushSubscription.expirationTime`: ms desde época, o ausente (casi siempre). */
  @IsOptional()
  @IsInt()
  expirationTime?: number;

  /**
   * Qué quiere recibir ESTE aparato. Requerido en el body (puede ser un
   * arreglo vacío: "registrado pero en silencio"), no opcional: un POST sin
   * `temas` sería fácil de confundir con "no tocar los temas existentes",
   * que es el trabajo del PATCH, no de este endpoint.
   */
  @IsArray()
  @IsEnum(TemaNotificacion, { each: true })
  temas!: TemaNotificacion[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  etiqueta?: string;
}

/** `PATCH /push/suscripciones/:id` — sólo lo que el usuario puede cambiar a mano. */
export class ActualizarSuscripcionDto {
  @IsOptional()
  @IsArray()
  @IsEnum(TemaNotificacion, { each: true })
  temas?: TemaNotificacion[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  etiqueta?: string;
}

/**
 * `DELETE /push/suscripciones` — el logout (y "olvidar este aparato" desde la
 * pantalla de dispositivos) borran por ENDPOINT, nunca por id: si entre que el
 * frontend lo leyó y este request llegó el aparato se re-suscribió, la fila ya
 * tiene un endpoint nuevo y borrar por id mataría una suscripción viva
 * (regla dura §3 del diseño).
 */
export class EliminarSuscripcionDto {
  @IsString()
  @IsNotEmpty()
  endpoint!: string;
}
