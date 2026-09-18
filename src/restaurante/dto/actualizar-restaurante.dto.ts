import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { VistaPrecios } from '../../generated/prisma/enums';

/**
 * `PATCH /restaurante` — EXACTAMENTE estos tres campos (contrato §4 del
 * diseño de J.O.R.B.I). `slug`, `monedaBase`, `horaCorteDia` y `zonaHoraria`
 * NO están aquí a propósito: el `ValidationPipe` global corre con
 * `whitelist: true`, así que cualquier otro campo que mande el cliente se
 * descarta en silencio antes de llegar al service.
 */
export class ActualizarRestauranteDto {
  /**
   * `.trim()` vía `@Transform`, ANTES de validar: así "   " se rechaza con un
   * 400 claro por `@MinLength(1)` en vez de llegar a la base y reventar el
   * CHECK `restaurante_nombre_acotado` con un 422 genérico.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  nombre?: string;

  /**
   * Validación laxa a propósito (mismo criterio que `RegistrarSuscripcionDto`
   * en notificaciones): el CHECK `restaurante_logo_url_valida` es la garantía
   * real de la forma exacta (`/uploads/restaurante/<uuid>.<ext>`). Esto sólo
   * adelanta el 400 más obvio.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  logoUrl?: string;

  @IsOptional()
  @IsEnum(VistaPrecios)
  mostrarPreciosEn?: VistaPrecios;
}
