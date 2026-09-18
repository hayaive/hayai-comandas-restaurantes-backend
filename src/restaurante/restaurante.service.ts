import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { ActualizarRestauranteDto } from './dto/actualizar-restaurante.dto';

/**
 * Forma exacta que expone la API (contrato §4 del diseño). Deliberadamente
 * NO todo el modelo: `creadoEn`/`actualizadoEn` no están en el contrato
 * acordado, y aunque `slug`/`monedaBase`/`horaCorteDia`/`zonaHoraria` sí se
 * LEEN aquí, no se editan desde este módulo (ver `ActualizarRestauranteDto`).
 */
const SELECT_RESTAURANTE = {
  id: true,
  slug: true,
  nombre: true,
  rif: true,
  logoUrl: true,
  monedaBase: true,
  mostrarPreciosEn: true,
  zonaHoraria: true,
  horaCorteDia: true,
  duracionReservaMin: true,
  permiteAutoseleccion: true,
  activo: true,
} as const;

@Injectable()
export class RestauranteService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /restaurante — cualquier sesión válida (sin restricción de rol). */
  async obtener(restauranteId: string) {
    const restaurante = await this.prisma.restaurante.findUnique({
      where: { id: restauranteId },
      select: SELECT_RESTAURANTE,
    });
    // No debería pasar nunca (restauranteId sale de un JWT ya validado por
    // JwtStrategy contra un usuario activo), pero un 404 explícito es mejor
    // que dejar que Prisma explote más abajo si algún día deja de serlo.
    if (!restaurante) throw new NotFoundException('Restaurante no encontrado');
    return restaurante;
  }

  /**
   * PATCH /restaurante — sólo `administrador` (impuesto por `RolesGuard` en
   * el controller, no aquí). Campos `undefined` del DTO no tocan la fila
   * (Prisma los ignora en `update`), igual que `SalonesService.actualizar`.
   *
   * NO borra el `logoUrl` viejo del disco al reemplazarlo (decisión del
   * diseño §6): borrar dentro de una operación que puede fallar deja una fila
   * apuntando a un archivo que ya no existe, y el upload/PATCH están
   * desacoplados — este service no sabe si la URL vieja sigue referenciada
   * desde otro lado. Los archivos huérfanos ya son un problema hoy (nada en
   * `src/` llama a `unlink`); queda fuera de esta entrega. TODO: barrido de
   * archivos huérfanos en `uploads/`.
   */
  async actualizar(restauranteId: string, dto: ActualizarRestauranteDto) {
    await this.obtener(restauranteId);

    return this.prisma.restaurante.update({
      where: { id: restauranteId },
      data: {
        nombre: dto.nombre,
        logoUrl: dto.logoUrl,
        mostrarPreciosEn: dto.mostrarPreciosEn,
      },
      select: SELECT_RESTAURANTE,
    });
  }
}
