import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../comun/prisma/prisma.service';
import { TasaService } from './tasa.service';
import { hoyEnZona } from './tasa-fecha.util';

/**
 * Orquesta CUÁNDO se refresca la tasa BCV automáticamente. No sabe nada de
 * dolarapi.com ni de upserts — eso vive en `TasaService.actualizarDesdeApiExterna`,
 * que también usa `POST /tasa/actualizar` (el refresco manual). Este servicio
 * sólo decide el momento:
 *
 *   1. Cada 6 horas (el BCV publica ~1 vez por día hábil; no hace falta más).
 *   2. Al arrancar el servidor: si HOY no hay ninguna tasa registrada para un
 *      restaurante, dispara un fetch inmediato — así no queda el sistema sin
 *      tasa esperando hasta 6 horas la primera vez (p.ej. tras un deploy).
 *
 * Si dolarapi.com no responde, `TasaService` ya loguea y devuelve null sin
 * lanzar: un ciclo de cron o el fetch de arranque simplemente no actualizan
 * nada ese turno, y la tasa manual (`POST /tasa`) sigue disponible como
 * respaldo — igual que en karelys-pedidos, el patrón replicado aquí.
 */
@Injectable()
export class TasaSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TasaSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasa: TasaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.actualizarRestaurantesSinTasaHoy();
    } catch (err) {
      // Nunca debe tumbar el arranque del servidor.
      this.logger.error('Fallo el fetch inicial de tasas al arrancar', err instanceof Error ? err.stack : err);
    }
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async actualizarProgramado(): Promise<void> {
    const restaurantes = await this.prisma.restaurante.findMany({
      where: { activo: true },
      select: { id: true },
    });
    await Promise.all(restaurantes.map((r) => this.actualizarUno(r.id, 'programado')));
  }

  private async actualizarRestaurantesSinTasaHoy(): Promise<void> {
    const restaurantes = await this.prisma.restaurante.findMany({ where: { activo: true } });
    for (const restaurante of restaurantes) {
      const { fecha } = hoyEnZona(restaurante.zonaHoraria);
      const hayTasaHoy = await this.prisma.tasaCambio.count({
        where: { restauranteId: restaurante.id, fecha },
      });
      if (hayTasaHoy === 0) {
        await this.actualizarUno(restaurante.id, 'arranque (sin tasa hoy)');
      }
    }
  }

  private async actualizarUno(restauranteId: string, motivo: string): Promise<void> {
    try {
      await this.tasa.actualizarDesdeApiExterna(restauranteId);
    } catch (err) {
      // Un restaurante fallando no debe frenar a los demás ni el cron.
      this.logger.error(
        `Fallo el refresco de tasa (${motivo}) para restaurante ${restauranteId}`,
        err instanceof Error ? err.stack : err,
      );
    }
  }
}
