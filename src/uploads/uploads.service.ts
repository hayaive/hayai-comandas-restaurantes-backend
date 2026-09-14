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

/** Sólo se encarga de que las carpetas existan antes de que llegue el primer upload. */
@Injectable()
export class UploadsService implements OnModuleInit {
  onModuleInit() {
    mkdirSync(carpetaUploadsProductos(), { recursive: true });
  }
}
