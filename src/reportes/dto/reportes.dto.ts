import { IsIn, IsInt, IsOptional, IsPositive, Max } from 'class-validator';

export class ProductosReporteQueryDto {
  @IsOptional()
  desde?: string;

  @IsOptional()
  hasta?: string;

  @IsOptional()
  @IsIn(['cantidad', 'ingreso'])
  orden?: 'cantidad' | 'ingreso';

  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(100)
  limite?: number;
}
