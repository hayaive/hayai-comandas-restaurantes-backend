import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
} from 'class-validator';
import { DestinoPreparacion } from '../../generated/prisma/enums';

export class CrearProductoDto {
  @IsUUID()
  categoriaId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  codigo?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nombre!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;

  @IsNumber()
  @Min(0)
  precio!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  costo?: number;

  @IsOptional()
  @IsEnum(DestinoPreparacion)
  destino?: DestinoPreparacion;

  @IsOptional()
  @IsInt()
  @Min(0)
  orden?: number;

  @IsOptional()
  @IsString()
  imagenUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  tiempoPrepMin?: number;
}

export class ActualizarProductoDto {
  @IsOptional()
  @IsUUID()
  categoriaId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  codigo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  precio?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  costo?: number;

  @IsOptional()
  @IsEnum(DestinoPreparacion)
  destino?: DestinoPreparacion;

  @IsOptional()
  @IsBoolean()
  disponible?: boolean;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  orden?: number;

  @IsOptional()
  @IsString()
  imagenUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  tiempoPrepMin?: number;
}

export class DisponibilidadProductoDto {
  @IsBoolean()
  disponible!: boolean;
}
