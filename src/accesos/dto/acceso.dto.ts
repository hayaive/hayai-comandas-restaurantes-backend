import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ModuloApp } from '../../generated/prisma/enums';
import { MODULOS_ASIGNABLES } from '../../comun/modulos';

/**
 * Los ÚNICOS plazos que existen. Ninguna ruta acepta un `acceso_hasta` libre:
 * el fin lo calcula la base con `hayai_fin_acceso` y cae siempre en la hora de
 * corte del restaurante (docs/DECISIONES-DATOS.md §13.4).
 */
export const DURACIONES = ['hoy', '2_dias', '1_semana', '1_mes'] as const;
export type DuracionAcceso = (typeof DURACIONES)[number];

/** Días OPERATIVOS que se suman al día operativo actual (ver `hayai_fin_acceso`). */
export const INTERVALO_POR_DURACION: Record<DuracionAcceso, string> = {
  hoy: '1 day',
  '2_dias': '2 days',
  '1_semana': '7 days',
  '1_mes': '1 month',
};

const MENSAJE_MODULOS = `modulos sólo admite: ${MODULOS_ASIGNABLES.join(', ')} (Configuración y Meseros son del administrador)`;

function recortar({ value }: { value: unknown }) {
  return typeof value === 'string' ? value.trim() : value;
}

/** `POST /accesos` */
export class CrearAccesoDto {
  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  nombre!: string;

  @IsIn(DURACIONES)
  duracion!: DuracionAcceso;

  /**
   * Al menos una pantalla: un acceso que no ve nada no sirve para nada.
   * `configuracion` y `meseros` se rechazan aquí con 400 (y, si esto se
   * saltara, el CHECK `usuario_modulos_segun_rol` los rechaza con 422).
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(MODULOS_ASIGNABLES, { each: true, message: MENSAJE_MODULOS })
  modulos!: ModuloApp[];
}

/** `PATCH /accesos/:id` — `duracion` extiende (o acorta) DESDE AHORA. */
export class ActualizarAccesoDto {
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  nombre?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(MODULOS_ASIGNABLES, { each: true, message: MENSAJE_MODULOS })
  modulos?: ModuloApp[];

  @IsOptional()
  @IsIn(DURACIONES)
  duracion?: DuracionAcceso;
}

/**
 * `POST /accesos/:id/regenerar`. Sin cuerpo (o sin ninguno de los dos
 * campos) regenera AMBOS. Si viene alguno, se regenera SÓLO lo que venga en
 * `true`: `{ "codigo": true }` cambia el código y el mesero conserva su
 * enlace. Ver CONTRACT.md §5 (Accesos temporales).
 */
export class RegenerarAccesoDto {
  @IsOptional()
  @IsBoolean()
  enlace?: boolean;

  @IsOptional()
  @IsBoolean()
  codigo?: boolean;
}

/**
 * `POST /auth/acceso/consultar`. `token` se valida laxo a propósito: un token
 * con forma rara es un enlace inválido (404), no un 400 — el frontend ramifica
 * por status y para el mesero las dos cosas son "este enlace no sirve".
 */
export class ConsultarAccesoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  restaurante!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  token!: string;
}

/** `POST /auth/acceso` */
export class CanjearAccesoDto extends ConsultarAccesoDto {
  @IsString()
  @Matches(/^\d{4}$/, { message: 'codigo debe tener exactamente 4 dígitos' })
  codigo!: string;
}
