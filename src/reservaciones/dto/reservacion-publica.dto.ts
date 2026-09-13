import { IsDateString, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class CrearReservacionPublicaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  clienteNombre!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  clienteTelefono!: string;

  @IsInt()
  @Min(1)
  @Max(200)
  personas!: number;

  @IsDateString()
  iniciaEn!: string;

  @IsOptional()
  @IsUUID()
  mesaId?: string;
}

export class SeleccionarMesaPublicaDto {
  @IsUUID()
  mesaId!: string;
}
