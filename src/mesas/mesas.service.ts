import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { nuevoId } from '../comun/id';
import { CrearMesaDto } from './dto/crear-mesa.dto';
import { ActualizarMesaDto } from './dto/actualizar-mesa.dto';

@Injectable()
export class MesasService {
  constructor(private readonly prisma: PrismaService) {}

  listar(restauranteId: string, salonId?: string) {
    return this.prisma.mesa.findMany({
      where: { restauranteId, eliminadaEn: null, ...(salonId ? { salonId } : {}) },
      orderBy: { etiqueta: 'asc' },
    });
  }

  async obtener(restauranteId: string, id: string) {
    const mesa = await this.prisma.mesa.findFirst({ where: { restauranteId, id, eliminadaEn: null } });
    if (!mesa) throw new NotFoundException('Mesa no encontrada');
    return mesa;
  }

  crear(restauranteId: string, dto: CrearMesaDto) {
    return this.prisma.mesa.create({
      data: {
        id: nuevoId(),
        restauranteId,
        salonId: dto.salonId,
        etiqueta: dto.etiqueta,
        capacidadDefault: dto.capacidadDefault ?? 4,
        formaDefault: dto.formaDefault ?? 'cuadrada',
      },
    });
  }

  async actualizar(restauranteId: string, id: string, dto: ActualizarMesaDto) {
    await this.obtener(restauranteId, id);
    return this.prisma.mesa.update({
      where: { id },
      data: {
        etiqueta: dto.etiqueta,
        capacidadDefault: dto.capacidadDefault,
        formaDefault: dto.formaDefault,
        activa: dto.activa,
      },
    });
  }

  /**
   * "Esta mesa ya no existe" (CONTRACT.md §3.6): borrado lógico de la
   * identidad Y se quita de todas las plantillas donde estuviera dibujada.
   * Nunca DELETE FROM mesa: hay comandas y reservas históricas apuntando ahí.
   */
  async eliminar(restauranteId: string, id: string) {
    await this.obtener(restauranteId, id);
    await this.prisma.$transaction([
      this.prisma.plantillaMesa.deleteMany({ where: { restauranteId, mesaId: id } }),
      this.prisma.mesa.update({
        where: { id },
        data: { eliminadaEn: new Date(), activa: false },
      }),
    ]);
  }
}
