import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configurarApp } from './configurar-app';
import { CARPETA_UPLOADS_RAIZ } from './uploads/uploads.service';

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
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: { origin: origenesPermitidos(), credentials: true },
  });
  configurarApp(app);

  // Sirve `uploads/` como estáticos, FUERA del prefijo `/api/v1` (a propósito:
  // así la URL que guarda `Producto.imagenUrl` es la misma que consume el
  // <img> del frontend, sin que este tenga que conocer el prefijo de la API).
  // ⚠️ Ver CARPETA_UPLOADS_RAIZ / CONTRACT.md: en Docker/Railway esta carpeta
  // necesita un volumen persistente o las imágenes se pierden en cada deploy.
  //
  // `setHeaders` manda `Access-Control-Allow-Origin` en CADA estático: a
  // diferencia del resto de la API, `useStaticAssets` NO pasa por el
  // `cors: {...}` de `NestFactory.create` (eso sólo cubre las rutas que Nest
  // enruta; los estáticos los sirve Express directo). El logo del restaurante
  // ahora vive en este origen y `src/lib/shareCard.ts` (frontend) lo pinta en
  // un `<canvas>` para exportarlo con `toBlob()` en la tarjeta de WhatsApp: sin
  // esta cabecera, pintar una imagen de otro origen "contamina" el canvas y
  // `toBlob()` lanza `SecurityError`. Hace falta ESTA cabecera Y
  // `crossOrigin="anonymous"` en el `Image()`/`<img>` del frontend — una sin
  // la otra no alcanza. `*` (no la allowlist de `CORS_ORIGIN`) porque estos
  // archivos ya son públicos sin sesión hoy (los estáticos no pasan por
  // `JwtAuthGuard`, que sólo protege rutas enrutadas por Nest).
  app.useStaticAssets(CARPETA_UPLOADS_RAIZ, {
    prefix: '/uploads',
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
    },
  });

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  Logger.log(`HAYAI Comandas escuchando en :${port}/api/v1`, 'Bootstrap');
}

bootstrap();
