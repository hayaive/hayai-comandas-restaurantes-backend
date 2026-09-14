import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { configurarApp } from './configurar-app';

// El parche de serialización de BigInt vive en `configurar-app.ts`, que es lo
// que comparten producción y los tests e2e (ver comun/json-bigint.ts).

function origenesPermitidos(): string[] {
  const desdeEnv = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const publica = process.env.URL_PUBLICA?.trim();
  const defaults = ['http://localhost:5173'];
  return Array.from(new Set([...desdeEnv, ...(publica ? [publica] : []), ...defaults]));
}

async function bootstrap() {
  // `cors: true` (el default de Nest) manda `Access-Control-Allow-Origin: *`,
  // que el navegador RECHAZA cuando el cliente manda `credentials: "include"`
  // (wildcard + credentials no es válido). Por eso el login fallaba con CORS
  // error desde el dominio real aunque respondía bien por curl (curl no
  // aplica política de CORS). Hay que declarar el/los orígenes explícitos.
  const app = await NestFactory.create(AppModule, {
    cors: { origin: origenesPermitidos(), credentials: true },
  });
  configurarApp(app);

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  Logger.log(`HAYAI Comandas escuchando en :${port}/api/v1`, 'Bootstrap');
}

bootstrap();
