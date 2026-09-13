import { IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class ActualizarPlantillaDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  nombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  descripcion?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  anchoPlano?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  altoPlano?: number;
}
