import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { FormaMesa } from '../../generated/prisma/enums';

export class CrearMesaDto {
  @IsUUID()
  salonId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  etiqueta!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  capacidadDefault?: number;

  @IsOptional()
  @IsEnum(FormaMesa)
  formaDefault?: FormaMesa;
}
