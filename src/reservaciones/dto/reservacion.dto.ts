import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CrearReservacionDto {
  @IsUUID()
  salonId!: string;

  @IsOptional()
  @IsUUID()
  mesaId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  clienteNombre!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  clienteTelefono?: string;

  @IsOptional()
  @IsString()
  @MaxLength(15)
  clienteDocumento?: string;

  @IsInt()
  @Min(1)
  @Max(200)
  personas!: number;

  @IsDateString()
  iniciaEn!: string;

  @IsOptional()
  @IsInt()
  @Min(15)
  duracionMin?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notas?: string;
}

export class ActualizarReservacionDto {
  @IsOptional()
  @IsUUID()
  mesaId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  clienteNombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  clienteTelefono?: string;

  @IsOptional()
  @IsString()
  @MaxLength(15)
  clienteDocumento?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  personas?: number;

  @IsOptional()
  @IsDateString()
  iniciaEn?: string;

  @IsOptional()
  @IsInt()
  @Min(15)
  duracionMin?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notas?: string;
}

export class CancelarReservacionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  motivo!: string;
}

export class SentarReservacionDto {
  @IsOptional()
  @IsUUID()
  mesaId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  comensales?: number;
}
