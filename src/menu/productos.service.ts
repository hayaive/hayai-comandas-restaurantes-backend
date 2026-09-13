import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { nuevoId } from '../comun/id';
import { CrearProductoDto, ActualizarProductoDto } from './dto/producto.dto';

@Injectable()
export class ProductosService {
  constructor(private readonly prisma: PrismaService) {}

  listar(restauranteId: string, categoriaId?: string, soloDisponibles?: boolean) {
    return this.prisma.producto.findMany({
      where: {
        restauranteId,
        activo: true,
        ...(categoriaId ? { categoriaId } : {}),
        ...(soloDisponibles ? { disponible: true } : {}),
      },
      orderBy: [{ categoriaId: 'asc' }, { orden: 'asc' }],
    });
  }

  async obtener(restauranteId: string, id: string) {
    const producto = await this.prisma.producto.findFirst({ where: { restauranteId, id, activo: true } });
    if (!producto) throw new NotFoundException('Producto no encontrado');
    return producto;
  }

  crear(restauranteId: string, dto: CrearProductoDto) {
    return this.prisma.producto.create({
      data: {
        id: nuevoId(),
        restauranteId,
        categoriaId: dto.categoriaId,
        codigo: dto.codigo,
        nombre: dto.nombre,
        descripcion: dto.descripcion,
        precio: dto.precio,
        costo: dto.costo,
        destino: dto.destino ?? 'cocina',
        orden: dto.orden ?? 0,
        imagenUrl: dto.imagenUrl,
        tiempoPrepMin: dto.tiempoPrepMin,
      },
    });
  }

  async actualizar(restauranteId: string, id: string, dto: ActualizarProductoDto) {
    await this.obtener(restauranteId, id);
    return this.prisma.producto.update({
      where: { id },
      data: {
        categoriaId: dto.categoriaId,
        codigo: dto.codigo,
        nombre: dto.nombre,
        descripcion: dto.descripcion,
        precio: dto.precio,
        costo: dto.costo,
        destino: dto.destino,
        disponible: dto.disponible,
        activo: dto.activo,
        orden: dto.orden,
        imagenUrl: dto.imagenUrl,
        tiempoPrepMin: dto.tiempoPrepMin,
      },
    });
  }

  async actualizarDisponibilidad(restauranteId: string, id: string, disponible: boolean) {
    await this.obtener(restauranteId, id);
    return this.prisma.producto.update({ where: { id }, data: { disponible } });
  }

  async eliminar(restauranteId: string, id: string) {
    await this.obtener(restauranteId, id);
    await this.prisma.producto.update({ where: { id }, data: { activo: false } });
  }
}
