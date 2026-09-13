import { Injectable } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';

@Injectable()
export class ReportesService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /reportes/dia — v_venta_dia, agrupado por turno y el total del día. */
  async ventasDelDia(restauranteId: string, fecha: string) {
    const porTurno = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM v_venta_dia
       WHERE restaurante_id = ${restauranteId}::uuid AND fecha_operativa = ${fecha}::date
       ORDER BY turno
    `;
    const [total] = await this.prisma.$queryRaw<any[]>`
      SELECT
        ${restauranteId}::uuid AS restaurante_id,
        ${fecha}::date AS fecha_operativa,
        coalesce(sum(comandas), 0)::int AS comandas,
        coalesce(sum(comensales), 0)::int AS comensales,
        coalesce(sum(total_usd), 0) AS total_usd,
        coalesce(sum(ventas_usd), 0) AS ventas_usd,
        coalesce(sum(propinas_usd), 0) AS propinas_usd,
        coalesce(sum(descuentos_usd), 0) AS descuentos_usd,
        coalesce(sum(impuestos_usd), 0) AS impuestos_usd
      FROM v_venta_dia
      WHERE restaurante_id = ${restauranteId}::uuid AND fecha_operativa = ${fecha}::date
    `;
    return { porTurno, total };
  }

  /**
   * GET /reportes/productos — "producto más vendido" tiene dos respuestas
   * (cantidad vs ingreso); la UI dice cuál está mostrando (CONTRACT.md §6).
   */
  async productosVendidos(
    restauranteId: string,
    desde: string,
    hasta: string,
    orden: 'cantidad' | 'ingreso' = 'cantidad',
    limite = 10,
  ) {
    const columnaOrden = orden === 'ingreso' ? 'ingreso_usd' : 'cantidad';
    return this.prisma.$queryRawUnsafe(
      `
      SELECT producto_id, producto_nombre,
             sum(cantidad)::numeric AS cantidad,
             sum(ingreso_usd)::numeric AS ingreso_usd,
             sum(comandas)::int AS comandas
        FROM v_producto_vendido_dia
       WHERE restaurante_id = $1::uuid
         AND fecha_operativa BETWEEN $2::date AND $3::date
       GROUP BY producto_id, producto_nombre
       ORDER BY ${columnaOrden} DESC
       LIMIT $4
      `,
      restauranteId,
      desde,
      hasta,
      limite,
    );
  }

  /** GET /reportes/cierre-caja — desglose por método de pago y auditoría de descuadres. */
  async cierreCaja(restauranteId: string, fecha: string) {
    const porMetodo = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM v_venta_dia_metodo
       WHERE restaurante_id = ${restauranteId}::uuid AND fecha_operativa = ${fecha}::date
       ORDER BY metodo, moneda
    `;
    const descuadres = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM v_comanda_descuadre
       WHERE restaurante_id = ${restauranteId}::uuid AND fecha_operativa = ${fecha}::date
    `;
    return { porMetodo, descuadres };
  }
}
