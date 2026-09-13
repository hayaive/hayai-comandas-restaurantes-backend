import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { FormaMesa } from '../../generated/prisma/enums';

/** Un elemento del plano: mesa existente (mesaId) o mesa nueva (etiqueta). */
export class PlantillaMesaItemDto {
  @IsOptional()
  @IsUUID()
  mesaId?: string;

  /** Requerido cuando `mesaId` no viene: crea la mesa (identidad) de una vez. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  etiqueta?: string;

  @IsNumber()
  @Min(0)
  posX!: number;

  @IsNumber()
  @Min(0)
  posY!: number;

  @IsOptional()
  @IsNumber()
  ancho?: number;

  @IsOptional()
  @IsNumber()
  alto?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(359)
  rotacion?: number;

  @IsEnum(FormaMesa)
  forma!: FormaMesa;

  @IsInt()
  @Min(1)
  @Max(50)
  capacidad!: number;

  @IsOptional()
  @IsBoolean()
  bloqueada?: boolean;
}

export class ActualizarPlantillaMesaDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  posX?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  posY?: number;

  @IsOptional()
  @IsNumber()
  ancho?: number;

  @IsOptional()
  @IsNumber()
  alto?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(359)
  rotacion?: number;

  @IsOptional()
  @IsEnum(FormaMesa)
  forma?: FormaMesa;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  capacidad?: number;

  @IsOptional()
  @IsBoolean()
  bloqueada?: boolean;
}

export class GuardarLayoutDto {
  @ValidateNested({ each: true })
  @Type(() => PlantillaMesaItemDto)
  mesas!: PlantillaMesaItemDto[];
}
