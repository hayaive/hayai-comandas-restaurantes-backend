import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TurnoServicio } from '../../generated/prisma/enums';

export interface DiaOperativo {
  fechaOperativa: Date;
  turno: TurnoServicio;
}

/**
 * El día contable NO se deriva de `creado_en::date`: se calcula con la hora de
 * corte del restaurante mediante las funciones SQL `hayai_fecha_operativa` y
 * `hayai_turno` (prisma/sql/01_constraints_y_triggers.sql §6). La regla vive
 * UNA sola vez, en la base; este servicio la llama, nunca la reimplementa en
 * TypeScript (ver CONTRACT.md §3.1 y docs/DECISIONES-DATOS.md §5).
 */
@Injectable()
export class DiaOperativoService {
  constructor(private readonly prisma: PrismaService) {}

  async resolver(zonaHoraria: string, horaCorteDia: Date, momento: Date = new Date()): Promise<DiaOperativo> {
    const horaTexto = horaCorteDia.toISOString().substring(11, 19); // "HH:MM:SS", en UTC
    const filas = await this.prisma.$queryRaw<{ fecha_operativa: Date; turno: TurnoServicio }[]>`
      SELECT hayai_fecha_operativa(${momento}::timestamptz, ${zonaHoraria}, ${horaTexto}::time) AS fecha_operativa,
             hayai_turno(${momento}::timestamptz, ${zonaHoraria}) AS turno
    `;
    const fila = filas[0];
    return { fechaOperativa: fila.fecha_operativa, turno: fila.turno };
  }
}
