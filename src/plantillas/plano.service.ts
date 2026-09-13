import { Injectable } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';

@Injectable()
export class PlanoService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /plano?salonId=&plantillaId= — vista v_mesa_estado, ya resuelta en SQL. */
  async obtener(restauranteId: string, salonId?: string, plantillaId?: string) {
    if (plantillaId) {
      return this.prisma.$queryRaw`
        SELECT * FROM v_mesa_estado
         WHERE restaurante_id = ${restauranteId}::uuid AND plantilla_id = ${plantillaId}::uuid
         ORDER BY etiqueta ASC
      `;
    }
    if (salonId) {
      return this.prisma.$queryRaw`
        SELECT * FROM v_mesa_estado
         WHERE restaurante_id = ${restauranteId}::uuid AND salon_id = ${salonId}::uuid AND plantilla_activa
         ORDER BY etiqueta ASC
      `;
    }
    return this.prisma.$queryRaw`
      SELECT * FROM v_mesa_estado
       WHERE restaurante_id = ${restauranteId}::uuid AND plantilla_activa
       ORDER BY etiqueta ASC
    `;
  }
}
