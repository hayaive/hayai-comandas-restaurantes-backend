import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { nuevoId } from '../comun/id';
import { CrearCategoriaDto, ActualizarCategoriaDto } from './dto/categoria.dto';

@Injectable()
export class CategoriasService {
  constructor(private readonly prisma: PrismaService) {}

  listar(restauranteId: string) {
    return this.prisma.categoria.findMany({
      where: { restauranteId, eliminadaEn: null },
      orderBy: { orden: 'asc' },
    });
  }

  async obtener(restauranteId: string, id: string) {
    const categoria = await this.prisma.categoria.findFirst({ where: { restauranteId, id, eliminadaEn: null } });
    if (!categoria) throw new NotFoundException('Categoría no encontrada');
    return categoria;
  }

  crear(restauranteId: string, dto: CrearCategoriaDto) {
    return this.prisma.categoria.create({
      data: { id: nuevoId(), restauranteId, nombre: dto.nombre, orden: dto.orden ?? 0 },
    });
  }

  async actualizar(restauranteId: string, id: string, dto: ActualizarCategoriaDto) {
    await this.obtener(restauranteId, id);
    return this.prisma.categoria.update({
      where: { id },
      data: { nombre: dto.nombre, orden: dto.orden, activa: dto.activa },
    });
  }

  async eliminar(restauranteId: string, id: string) {
    await this.obtener(restauranteId, id);
    await this.prisma.categoria.update({ where: { id }, data: { eliminadaEn: new Date(), activa: false } });
  }
}
