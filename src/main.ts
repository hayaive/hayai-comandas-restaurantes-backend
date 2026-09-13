import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { configurarApp } from './configurar-app';

// Postgres devuelve BIGINT (los count(*) de las vistas de reporte) como
// BigInt en JS vía el driver adapter; JSON.stringify no sabe serializarlo.
// Los conteos de este dominio (comandas, ítems) nunca acercan
// Number.MAX_SAFE_INTEGER, así que convertir a Number es seguro.
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  configurarApp(app);

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  Logger.log(`HAYAI Comandas escuchando en :${port}/api/v1`, 'Bootstrap');
}

bootstrap();
