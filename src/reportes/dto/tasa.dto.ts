import { IsEnum, IsNumber, IsOptional, IsPositive } from 'class-validator';
import { Divisa, FuenteTasa } from '../../generated/prisma/enums';

export class CrearTasaDto {
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  valor!: number;

  @IsEnum(FuenteTasa)
  fuente!: FuenteTasa;

  /** Ausente = 'USD' (CONTRACT.md §POST /tasa): el frontend ya desplegado
   *  llama registrarTasa(valor, fuente) sin divisa, y ese camino habla siempre
   *  del dólar. */
  @IsOptional()
  @IsEnum(Divisa)
  divisa?: Divisa;
}
