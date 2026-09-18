import { Injectable, OnModuleInit } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Raíz de subida, en la raíz del proyecto backend (no dentro de `src/`, que se
 * borra y se regenera en cada build). Ver CONTRACT.md, sección de uploads: en
 * producción (Docker/Railway) esta carpeta necesita un volumen persistente o
 * las imágenes desaparecen en el siguiente deploy.
 */
export const CARPETA_UPLOADS_RAIZ = join(process.cwd(), 'uploads');
const SUBCARPETA_PRODUCTOS = 'productos';
// Subcarpeta APARTE de productos (no reutiliza `SUBCARPETA_PRODUCTOS`): el
// logo tiene una retención distinta (uno por restaurante, casi nunca cambia)
// y así un futuro barrido de huérfanos puede razonar cada carpeta por
// separado (diseño §6).
const SUBCARPETA_RESTAURANTE = 'restaurante';

/**
 * Funciones libres (no métodos) a propósito: `multer.diskStorage` las necesita
 * en la configuración del `@UseInterceptors`, que Nest evalúa al definir la
 * clase del controller — antes de que exista ninguna inyección de dependencias.
 */
export function carpetaUploadsProductos(): string {
  return join(CARPETA_UPLOADS_RAIZ, SUBCARPETA_PRODUCTOS);
}

export function urlPublicaImagenProducto(nombreArchivo: string): string {
  return `/uploads/${SUBCARPETA_PRODUCTOS}/${nombreArchivo}`;
}

export function carpetaUploadsRestaurante(): string {
  return join(CARPETA_UPLOADS_RAIZ, SUBCARPETA_RESTAURANTE);
}

export function urlPublicaLogoRestaurante(nombreArchivo: string): string {
  return `/uploads/${SUBCARPETA_RESTAURANTE}/${nombreArchivo}`;
}

/**
 * Convierte una URL relativa de `/uploads/...` (lo que guarda
 * `Restaurante.logoUrl`) en una ABSOLUTA. Hace falta para el payload de push
 * (`NotificacionesService.notificarComandaNueva`): el service worker no tiene
 * sesión ni puede llamar a la API, así que la URL del ícono tiene que llegar
 * completa desde el servidor (diseño §7.3).
 *
 * `URL_BACKEND` es la URL pública de ESTE backend — NO confundir con
 * `URL_PUBLICA`, que es la del FRONTEND y sólo sirve para armar el link de
 * reservas (`reservaciones*.service.ts`). Sin configurar, cae a localhost
 * para desarrollo, igual que el resto de estos flags de entorno opcionales.
 */
export function urlAbsolutaBackend(rutaRelativa: string): string {
  const base = (process.env.URL_BACKEND ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');
  return `${base}${rutaRelativa}`;
}

/** Sólo se encarga de que las carpetas existan antes de que llegue el primer upload. */
@Injectable()
export class UploadsService implements OnModuleInit {
  onModuleInit() {
    mkdirSync(carpetaUploadsProductos(), { recursive: true });
    mkdirSync(carpetaUploadsRestaurante(), { recursive: true });
  }
}
