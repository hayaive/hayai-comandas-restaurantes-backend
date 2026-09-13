import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { nuevoId } from '../comun/id';
import { CrearTasaDto } from './dto/tasa.dto';

@Injectable()
export class TasaService {
  constructor(private readonly prisma: PrismaService) {}

  async vigente(restauranteId: string) {
    const tasa = await this.prisma.tasaCambio.findFirst({
      where: { restauranteId },
      orderBy: [{ fecha: 'desc' }, { creadaEn: 'desc' }],
    });
    if (!tasa) throw new BadRequestException('No hay ninguna tasa de cambio registrada todavía');
    return tasa;
  }

  async crear(restauranteId: string, registradaPorId: string, dto: CrearTasaDto) {
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });
    const hoy = new Date(
      new Date().toLocaleString('en-US', { timeZone: restaurante.zonaHoraria }),
    );
    const fecha = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()));

    return this.prisma.tasaCambio.create({
      data: {
        id: nuevoId(),
        restauranteId,
        fecha,
        valor: dto.valor,
        fuente: dto.fuente,
        registradaPorId,
      },
    });
  }
}
