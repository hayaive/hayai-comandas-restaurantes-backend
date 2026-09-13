import { IsEnum, IsNumber, IsPositive } from 'class-validator';
import { FuenteTasa } from '../../generated/prisma/enums';

export class CrearTasaDto {
  @IsNumber()
  @IsPositive()
  valor!: number;

  @IsEnum(FuenteTasa)
  fuente!: FuenteTasa;
}
