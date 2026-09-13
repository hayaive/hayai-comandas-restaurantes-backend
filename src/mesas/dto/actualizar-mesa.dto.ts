import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { FormaMesa } from '../../generated/prisma/enums';

export class ActualizarMesaDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  etiqueta?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  capacidadDefault?: number;

  @IsOptional()
  @IsEnum(FormaMesa)
  formaDefault?: FormaMesa;

  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}
