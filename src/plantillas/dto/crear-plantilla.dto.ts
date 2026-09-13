import { IsNumber, IsOptional, IsPositive, IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class CrearPlantillaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  nombre!: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  anchoPlano?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  altoPlano?: number;
}
