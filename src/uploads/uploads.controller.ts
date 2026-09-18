import { randomUUID } from 'node:crypto';
import { BadRequestException, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import {
  carpetaUploadsProductos,
  carpetaUploadsRestaurante,
  urlPublicaImagenProducto,
  urlPublicaLogoRestaurante,
} from './uploads.service';
import { extensionParaMimeImagen, TAMANO_MAXIMO_IMAGEN_BYTES, TAMANO_MAXIMO_LOGO_BYTES } from './imagen-upload.util';
import { Roles } from '../comun/decoradores/roles.decorator';
import { RolesGuard } from '../comun/guards/roles.guard';

const MENSAJE_TIPO_INVALIDO = 'Solo se permiten imágenes JPG, PNG o WEBP';

@Controller('uploads')
export class UploadsController {
  /**
   * Endpoint genérico de subida de imágenes de producto. El frontend lo llama
   * primero y guarda la `url` que devuelve como `Producto.imagenUrl` en el
   * POST/PATCH de producto ya existente — no está acoplado a la creación del
   * producto (ver CONTRACT.md, sección de uploads).
   */
  @Post('productos')
  @UseInterceptors(
    FileInterceptor('archivo', {
      storage: diskStorage({
        destination: carpetaUploadsProductos(),
        // Nombre generado en el servidor: nunca el `originalname` del cliente
        // (evita path traversal y colisiones). La extensión sale del mimetype
        // ya validado en `fileFilter`, nunca del nombre que mandó el cliente.
        filename: (_req, file, cb) => {
          const extension = extensionParaMimeImagen(file.mimetype) ?? '';
          cb(null, `${randomUUID()}${extension}`);
        },
      }),
      limits: { fileSize: TAMANO_MAXIMO_IMAGEN_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!extensionParaMimeImagen(file.mimetype)) {
          cb(new BadRequestException(MENSAJE_TIPO_INVALIDO), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  subirImagenProducto(@UploadedFile() archivo?: Express.Multer.File): { url: string } {
    if (!archivo) {
      throw new BadRequestException('Debes adjuntar un archivo en el campo "archivo"');
    }
    return { url: urlPublicaImagenProducto(archivo.filename) };
  }

  /**
   * Sube el logo del restaurante. Desacoplado del `PATCH /restaurante`, igual
   * que `/uploads/productos` lo está de `POST/PATCH /productos` (contrato §4
   * del diseño): el frontend sube primero y guarda la `url` que devuelve como
   * `logoUrl` en el PATCH.
   *
   * Sólo `administrador` — mismo mecanismo que `PATCH /restaurante`
   * (`RolesGuard` + `@Roles`). Límite de **1MB**, no los 5MB de las fotos de
   * producto (decisión del dueño, diseño §6).
   */
  @Post('logo')
  @Roles('administrador')
  @UseGuards(RolesGuard)
  @UseInterceptors(
    FileInterceptor('archivo', {
      storage: diskStorage({
        destination: carpetaUploadsRestaurante(),
        // Mismo criterio que /uploads/productos: nombre generado en el
        // servidor, extensión del mimetype ya validado en `fileFilter`.
        filename: (_req, file, cb) => {
          const extension = extensionParaMimeImagen(file.mimetype) ?? '';
          cb(null, `${randomUUID()}${extension}`);
        },
      }),
      limits: { fileSize: TAMANO_MAXIMO_LOGO_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!extensionParaMimeImagen(file.mimetype)) {
          cb(new BadRequestException(MENSAJE_TIPO_INVALIDO), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  subirLogoRestaurante(@UploadedFile() archivo?: Express.Multer.File): { url: string } {
    if (!archivo) {
      throw new BadRequestException('Debes adjuntar un archivo en el campo "archivo"');
    }
    return { url: urlPublicaLogoRestaurante(archivo.filename) };
  }
}
