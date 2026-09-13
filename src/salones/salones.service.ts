import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { nuevoId } from '../comun/id';
import { CrearSalonDto } from './dto/crear-salon.dto';
import { ActualizarSalonDto } from './dto/actualizar-salon.dto';

@Injectable()
export class SalonesService {
  constructor(private readonly prisma: PrismaService) {}

  listar(restauranteId: string) {
    return this.prisma.salon.findMany({
      where: { restauranteId, eliminadoEn: null },
      orderBy: { orden: 'asc' },
    });
  }

  async obtener(restauranteId: string, id: string) {
    const salon = await this.prisma.salon.findFirst({ where: { restauranteId, id, eliminadoEn: null } });
    if (!salon) throw new NotFoundException('Salón no encontrado');
    return salon;
  }

  crear(restauranteId: string, dto: CrearSalonDto) {
    return this.prisma.salon.create({
      data: {
        id: nuevoId(),
        restauranteId,
        nombre: dto.nombre,
        orden: dto.orden ?? 0,
      },
    });
  }

  async actualizar(restauranteId: string, id: string, dto: ActualizarSalonDto) {
    await this.obtener(restauranteId, id);
    return this.prisma.salon.update({
      where: { id },
      data: {
        nombre: dto.nombre,
        orden: dto.orden,
        activo: dto.activo,
      },
    });
  }

  async eliminar(restauranteId: string, id: string) {
    await this.obtener(restauranteId, id);
    await this.prisma.salon.update({
      where: { id },
      data: { eliminadoEn: new Date(), activo: false },
    });
  }
}
