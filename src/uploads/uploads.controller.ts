import { randomUUID } from 'node:crypto';
import { BadRequestException, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { carpetaUploadsProductos, urlPublicaImagenProducto } from './uploads.service';
import { extensionParaMimeImagen, TAMANO_MAXIMO_IMAGEN_BYTES } from './imagen-upload.util';

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
}
