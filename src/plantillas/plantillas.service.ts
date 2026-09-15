import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { nuevoId } from '../comun/id';
import { CrearPlantillaDto } from './dto/crear-plantilla.dto';
import { ActualizarPlantillaDto } from './dto/actualizar-plantilla.dto';
import { PlantillaMesaItemDto, ActualizarPlantillaMesaDto } from './dto/plantilla-mesa-item.dto';

@Injectable()
export class PlantillasService {
  constructor(private readonly prisma: PrismaService) {}

  listarPorSalon(restauranteId: string, salonId: string) {
    return this.prisma.plantilla.findMany({
      where: { restauranteId, salonId, eliminadaEn: null },
      orderBy: { creadaEn: 'asc' },
    });
  }

  async obtener(restauranteId: string, id: string) {
    const plantilla = await this.prisma.plantilla.findFirst({ where: { restauranteId, id, eliminadaEn: null } });
    if (!plantilla) throw new NotFoundException('Plantilla no encontrada');
    return plantilla;
  }

  async obtenerConMesas(restauranteId: string, id: string) {
    const plantilla = await this.obtener(restauranteId, id);
    const mesas = await this.prisma.plantillaMesa.findMany({
      where: { restauranteId, plantillaId: id },
      include: { mesa: true },
      orderBy: { creadaEn: 'asc' },
    });
    return { ...plantilla, mesas };
  }

  crear(restauranteId: string, salonId: string, dto: CrearPlantillaDto) {
    return this.prisma.plantilla.create({
      data: {
        id: nuevoId(),
        restauranteId,
        salonId,
        nombre: dto.nombre,
        anchoPlano: dto.anchoPlano,
        altoPlano: dto.altoPlano,
      },
    });
  }

  async actualizar(restauranteId: string, id: string, dto: ActualizarPlantillaDto) {
    await this.obtener(restauranteId, id);
    return this.prisma.plantilla.update({
      where: { id },
      data: {
        nombre: dto.nombre,
        descripcion: dto.descripcion,
        anchoPlano: dto.anchoPlano,
        altoPlano: dto.altoPlano,
      },
    });
  }

  /**
   * DELETE /plantillas/:id — borrado lógico. `plantilla_mesa` NO se toca a
   * propósito: es lo que preserva el layout histórico de la distribución
   * borrada, y las comandas/reservaciones que apuntan a esta plantilla
   * conservan su `plantilla_id` intacto.
   */
  async eliminar(restauranteId: string, id: string) {
    const plantilla = await this.obtener(restauranteId, id);
    if (plantilla.activa) {
      throw new ConflictException('No se puede eliminar la distribución activa del salón: activa otra primero');
    }
    await this.prisma.plantilla.update({ where: { id }, data: { eliminadaEn: new Date() } });
  }

  /** CONTRACT.md §3.4: clonar copia el layout completo, activa=false, con trazabilidad. */
  async clonar(restauranteId: string, origenId: string, nombre: string) {
    const origen = await this.obtener(restauranteId, origenId);
    const nuevaId = nuevoId();

    return this.prisma.$transaction(async (tx) => {
      const nueva = await tx.plantilla.create({
        data: {
          id: nuevaId,
          restauranteId,
          salonId: origen.salonId,
          nombre,
          descripcion: origen.descripcion,
          anchoPlano: origen.anchoPlano,
          altoPlano: origen.altoPlano,
          activa: false,
          clonadaDeId: origen.id,
        },
      });

      const mesasOrigen = await tx.plantillaMesa.findMany({ where: { restauranteId, plantillaId: origenId } });
      if (mesasOrigen.length > 0) {
        await tx.plantillaMesa.createMany({
          data: mesasOrigen.map((m) => ({
            restauranteId,
            plantillaId: nuevaId,
            mesaId: m.mesaId,
            posX: m.posX,
            posY: m.posY,
            ancho: m.ancho,
            alto: m.alto,
            rotacion: m.rotacion,
            forma: m.forma,
            capacidad: m.capacidad,
            bloqueada: m.bloqueada,
          })),
        });
      }

      return nueva;
    });
  }

  /**
   * CONTRACT.md §3.5: desactiva la plantilla vigente del salón y activa la
   * nueva en una transacción (el índice único parcial `plantilla_activa_unica`
   * impide dejar dos). Después consulta `v_reservacion_huerfana` para avisar
   * de reservas que quedaron fuera del nuevo plano (no bloquea el cambio).
   */
  async activar(restauranteId: string, id: string) {
    const plantilla = await this.obtener(restauranteId, id);

    const actualizada = await this.prisma.$transaction(async (tx) => {
      await tx.plantilla.updateMany({
        where: { restauranteId, salonId: plantilla.salonId, activa: true },
        data: { activa: false },
      });
      return tx.plantilla.update({ where: { id }, data: { activa: true } });
    });

    const huerfanas = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM v_reservacion_huerfana
       WHERE restaurante_id = ${restauranteId}::uuid
       ORDER BY inicia_en ASC
    `;

    return { plantilla: actualizada, reservacionesHuerfanas: huerfanas };
  }

  /**
   * PUT /plantillas/:id/mesas — guarda el layout COMPLETO de una vez.
   * Reemplaza el set: inserta las nuevas (creando la `mesa` si hace falta),
   * actualiza las movidas, borra las que ya no vienen. Todo en transacción.
   */
  async guardarLayoutCompleto(restauranteId: string, plantillaId: string, items: PlantillaMesaItemDto[]) {
    const plantilla = await this.obtener(restauranteId, plantillaId);

    return this.prisma.$transaction(async (tx) => {
      const existentes = await tx.plantillaMesa.findMany({ where: { restauranteId, plantillaId } });
      const existentesPorMesa = new Map(existentes.map((e) => [e.mesaId, e]));
      const mesaIdsEntrantes = new Set<string>();

      for (const item of items) {
        let mesaId = item.mesaId;
        if (!mesaId) {
          if (!item.etiqueta) {
            throw new NotFoundException('Cada mesa nueva del plano necesita una etiqueta');
          }
          const mesaNueva = await tx.mesa.create({
            data: {
              id: nuevoId(),
              restauranteId,
              salonId: plantilla.salonId,
              etiqueta: item.etiqueta,
              capacidadDefault: item.capacidad,
              formaDefault: item.forma,
            },
          });
          mesaId = mesaNueva.id;
        }
        mesaIdsEntrantes.add(mesaId);

        const datos = {
          posX: item.posX,
          posY: item.posY,
          ancho: item.ancho ?? 80,
          alto: item.alto ?? 80,
          rotacion: item.rotacion ?? 0,
          forma: item.forma,
          capacidad: item.capacidad,
          bloqueada: item.bloqueada ?? false,
        };

        if (existentesPorMesa.has(mesaId)) {
          await tx.plantillaMesa.update({
            where: { plantillaId_mesaId: { plantillaId, mesaId } },
            data: datos,
          });
        } else {
          await tx.plantillaMesa.create({
            data: { restauranteId, plantillaId, mesaId, ...datos },
          });
        }
      }

      const aQuitar = existentes.filter((e) => !mesaIdsEntrantes.has(e.mesaId)).map((e) => e.mesaId);
      if (aQuitar.length > 0) {
        await tx.plantillaMesa.deleteMany({
          where: { restauranteId, plantillaId, mesaId: { in: aQuitar } },
        });
      }

      return tx.plantillaMesa.findMany({ where: { restauranteId, plantillaId }, include: { mesa: true } });
    });
  }

  /** POST /plantillas/:id/mesas — agrega UNA mesa al plano (crea la mesa si `mesaId` no viene). */
  async agregarMesa(restauranteId: string, plantillaId: string, item: PlantillaMesaItemDto) {
    const plantilla = await this.obtener(restauranteId, plantillaId);

    return this.prisma.$transaction(async (tx) => {
      let mesaId = item.mesaId;
      if (!mesaId) {
        if (!item.etiqueta) throw new NotFoundException('Falta la etiqueta de la mesa nueva');
        const mesaNueva = await tx.mesa.create({
          data: {
            id: nuevoId(),
            restauranteId,
            salonId: plantilla.salonId,
            etiqueta: item.etiqueta,
            capacidadDefault: item.capacidad,
            formaDefault: item.forma,
          },
        });
        mesaId = mesaNueva.id;
      }

      return tx.plantillaMesa.create({
        data: {
          restauranteId,
          plantillaId,
          mesaId,
          posX: item.posX,
          posY: item.posY,
          ancho: item.ancho ?? 80,
          alto: item.alto ?? 80,
          rotacion: item.rotacion ?? 0,
          forma: item.forma,
          capacidad: item.capacidad,
          bloqueada: item.bloqueada ?? false,
        },
        include: { mesa: true },
      });
    });
  }

  async actualizarMesa(restauranteId: string, plantillaId: string, mesaId: string, dto: ActualizarPlantillaMesaDto) {
    await this.obtener(restauranteId, plantillaId);
    const existente = await this.prisma.plantillaMesa.findFirst({ where: { restauranteId, plantillaId, mesaId } });
    if (!existente) throw new NotFoundException('Esa mesa no está en esta plantilla');

    return this.prisma.plantillaMesa.update({
      where: { plantillaId_mesaId: { plantillaId, mesaId } },
      data: {
        posX: dto.posX,
        posY: dto.posY,
        ancho: dto.ancho,
        alto: dto.alto,
        rotacion: dto.rotacion,
        forma: dto.forma,
        capacidad: dto.capacidad,
        bloqueada: dto.bloqueada,
      },
    });
  }

  /** DELETE /plantillas/:id/mesas/:mesaId — la quita del plano, NO borra la mesa. */
  async quitarMesa(restauranteId: string, plantillaId: string, mesaId: string) {
    await this.obtener(restauranteId, plantillaId);
    const existente = await this.prisma.plantillaMesa.findFirst({ where: { restauranteId, plantillaId, mesaId } });
    if (!existente) throw new NotFoundException('Esa mesa no está en esta plantilla');
    await this.prisma.plantillaMesa.delete({ where: { plantillaId_mesaId: { plantillaId, mesaId } } });
  }
}
