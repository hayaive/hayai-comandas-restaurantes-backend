import { IsIn, IsInt, IsOptional, IsPositive, Matches, Max } from 'class-validator';

/** Períodos del apartado de ventas. `anio` sin eñe: viaja en la URL. */
export const PERIODOS_REPORTE = ['dia', 'mes', 'anio'] as const;
export type PeriodoReporteDto = (typeof PERIODOS_REPORTE)[number];

/**
 * `YYYY-MM-DD` con mes y día en rango. No comprueba el calendario
 * (`2026-02-31` pasa el regex): eso lo rechaza Postgres con `22008`, que el
 * PgErrorFilter traduce a 422. Lo que el regex sí garantiza es que nunca
 * llegue texto libre a un `::date`.
 */
const FECHA_ISO = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class ReporteVentasQueryDto {
  /**
   * Validar esto NO es cosmético: `periodo` entra en un `CASE` de SQL cuya
   * rama ELSE es el año. Sin `@IsIn`, un `?periodo=semana` devolvería las
   * cifras del año sin avisar de nada.
   */
  @IsOptional()
  @IsIn(PERIODOS_REPORTE)
  periodo?: PeriodoReporteDto;

  /**
   * Día operativo ancla. Ausente = el día operativo en curso, resuelto por el
   * backend con la zona horaria y la hora de corte del restaurante — el
   * frontend no tiene esos datos y hoy los adivina.
   */
  @IsOptional()
  @Matches(FECHA_ISO, { message: 'fecha debe tener formato YYYY-MM-DD' })
  fecha?: string;
}

export class ProductosReporteQueryDto {
  /** Igual que en `/reportes/ventas`. Si viene, manda sobre `desde`/`hasta`. */
  @IsOptional()
  @IsIn(PERIODOS_REPORTE)
  periodo?: PeriodoReporteDto;

  @IsOptional()
  @Matches(FECHA_ISO, { message: 'fecha debe tener formato YYYY-MM-DD' })
  fecha?: string;

  @IsOptional()
  @Matches(FECHA_ISO, { message: 'desde debe tener formato YYYY-MM-DD' })
  desde?: string;

  @IsOptional()
  @Matches(FECHA_ISO, { message: 'hasta debe tener formato YYYY-MM-DD' })
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

export class ReporteDiaQueryDto {
  @IsOptional()
  @Matches(FECHA_ISO, { message: 'fecha debe tener formato YYYY-MM-DD' })
  fecha?: string;
}
