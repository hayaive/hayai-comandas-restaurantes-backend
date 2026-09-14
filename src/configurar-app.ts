import { INestApplication, ValidationPipe } from '@nestjs/common';
import { PgErrorFilter } from './comun/filtros/pg-error.filter';
import { habilitarSerializacionBigInt } from './comun/json-bigint';

/**
 * Configuración de la app compartida entre `main.ts` (producción) y los
 * smoke tests e2e, para no duplicarla ni dejarla divergir.
 */
export function configurarApp(app: INestApplication): INestApplication {
  habilitarSerializacionBigInt();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new PgErrorFilter());
  return app;
}
