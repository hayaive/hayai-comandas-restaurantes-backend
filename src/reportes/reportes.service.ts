import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';

/** Filtro del apartado de ventas: el día, el mes o lo que va del año. */
export type PeriodoReporte = 'dia' | 'mes' | 'anio';

/** Granularidad del desglose interno, derivada del período (nunca la pide el cliente). */
export type GranularidadSerie = 'turno' | 'dia' | 'mes';

/**
 * Cifras de venta de un tramo de días operativos.
 *
 * El dinero viaja como **string**, no como number: las columnas son
 * `numeric(14,4)` y pasarlas por un float de JavaScript introduce error de
 * redondeo en el mismo sitio donde el dueño cuadra la caja.
 */
export interface VentaResumen {
  comandas: number;
  comensales: number;
  totalUsd: string;
  /** Total sin propina: la propina es del mesero, no ingreso del restaurante. */
  ventasUsd: string;
  propinasUsd: string;
  descuentosUsd: string;
  impuestosUsd: string;
  /** totalUsd / comandas. "0.0000" cuando el tramo no tuvo ventas. */
  ticketPromedioUsd: string;
}

export interface VentaPunto extends VentaResumen {
  /**
   * Identifica el bucket según `granularidad`:
   *   · turno → 'desayuno' | 'almuerzo' | 'cena' | 'madrugada'
   *   · dia   → 'YYYY-MM-DD' (día operativo)
   *   · mes   → 'YYYY-MM'
   */
  clave: string;
}

export interface ReporteVentas {
  periodo: PeriodoReporte;
  /** Día operativo ancla ya resuelto por el backend, 'YYYY-MM-DD'. */
  fecha: string;
  /** Primer día operativo incluido, 'YYYY-MM-DD'. */
  desde: string;
  /** Último día operativo incluido, 'YYYY-MM-DD'. Recortado al día en curso. */
  hasta: string;
  /** El tramo llega al día operativo de hoy: la cifra todavía se mueve. */
  enCurso: boolean;
  total: VentaResumen;
  granularidad: GranularidadSerie;
  /** Serie densa: los buckets sin ventas vienen en cero, no faltan. */
  serie: VentaPunto[];
  /** Mismo tramo del período anterior, para comparar sin engañar. */
  comparacion: { desde: string; hasta: string; total: VentaResumen };
}

interface RangoResuelto {
  fecha: string;
  desde: string;
  hasta: string;
  enCurso: boolean;
  cmpDesde: string;
  cmpHasta: string;
}

/** Fila cruda de agregación; el dinero llega en texto desde Postgres. */
interface FilaResumen {
  comandas: number | string;
  comensales: number | string;
  total_usd: string;
  ventas_usd: string;
  propinas_usd: string;
  descuentos_usd: string;
  impuestos_usd: string;
  ticket_promedio_usd: string;
}

function aResumen(f: FilaResumen): VentaResumen {
  return {
    comandas: Number(f.comandas),
    comensales: Number(f.comensales),
    totalUsd: String(f.total_usd),
    ventasUsd: String(f.ventas_usd),
    propinasUsd: String(f.propinas_usd),
    descuentosUsd: String(f.descuentos_usd),
    impuestosUsd: String(f.impuestos_usd),
    ticketPromedioUsd: String(f.ticket_promedio_usd),
  };
}

const RESUMEN_VACIO: VentaResumen = {
  comandas: 0,
  comensales: 0,
  totalUsd: '0.0000',
  ventasUsd: '0.0000',
  propinasUsd: '0.0000',
  descuentosUsd: '0.0000',
  impuestosUsd: '0.0000',
  ticketPromedioUsd: '0.0000',
};

/**
 * Las ocho métricas, calculadas SIEMPRE con la misma fórmula sobre
 * `v_venta_dia`. Se escriben una vez y se interpolan en cada consulta para que
 * el total del año y el de un turno no puedan divergir por un copy-paste.
 *
 * `ticket_promedio` es sum/sum y no avg(avg): promediar promedios de días con
 * distinto número de comandas da un número que no es el ticket de nadie.
 */
const METRICAS = `
  coalesce(sum(v."comandas"), 0)::int                                  AS "comandas",
  coalesce(sum(v."comensales"), 0)::int                                AS "comensales",
  round(coalesce(sum(v."total_usd"), 0), 4)::text                      AS "total_usd",
  round(coalesce(sum(v."ventas_usd"), 0), 4)::text                     AS "ventas_usd",
  round(coalesce(sum(v."propinas_usd"), 0), 4)::text                   AS "propinas_usd",
  round(coalesce(sum(v."descuentos_usd"), 0), 4)::text                 AS "descuentos_usd",
  round(coalesce(sum(v."impuestos_usd"), 0), 4)::text                  AS "impuestos_usd",
  round(coalesce(sum(v."total_usd") / nullif(sum(v."comandas"), 0), 0), 4)::text AS "ticket_promedio_usd"
`;

@Injectable()
export class ReportesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /reportes/ventas — el apartado de ventas con filtro día / mes / año.
   *
   * Todo se agrega por `fecha_operativa` (el día contable con hora de corte),
   * nunca por `creado_en::date`: el mes de septiembre incluye la madrugada del
   * 1 de octubre si el restaurante cierra a las 5am, y excluye la del 1 de
   * septiembre. Cambiar de criterio aquí haría que la suma de los días del
   * reporte diario no diera el total del mes.
   */
  async ventas(restauranteId: string, periodo: PeriodoReporte = 'dia', fecha?: string): Promise<ReporteVentas> {
    const rango = await this.resolverRango(restauranteId, periodo, fecha);
    const granularidad: GranularidadSerie = periodo === 'dia' ? 'turno' : periodo === 'mes' ? 'dia' : 'mes';

    const [total, totalComparacion, serie] = await Promise.all([
      this.totalesDelRango(restauranteId, rango.desde, rango.hasta),
      this.totalesDelRango(restauranteId, rango.cmpDesde, rango.cmpHasta),
      this.serieDelRango(restauranteId, granularidad, rango.desde, rango.hasta),
    ]);

    return {
      periodo,
      fecha: rango.fecha,
      desde: rango.desde,
      hasta: rango.hasta,
      enCurso: rango.enCurso,
      total,
      granularidad,
      serie,
      comparacion: { desde: rango.cmpDesde, hasta: rango.cmpHasta, total: totalComparacion },
    };
  }

  /**
   * El calendario lo resuelve Postgres, no TypeScript.
   *
   * Tres razones, todas cobradas en producción alguna vez:
   *   1. El día operativo sale de `hayai_fecha_operativa(now(), zona, corte)`,
   *      la MISMA función que materializa `comanda.fecha_operativa` al abrir
   *      (docs/DECISIONES-DATOS.md §5). Calcularlo aquí sería la segunda
   *      implementación de la regla, y el día que diverjan el cierre de caja
   *      deja de cuadrar por las comandas de madrugada.
   *   2. Fin de mes, bisiestos y "el mes anterior de un 31" los sabe el
   *      calendario de Postgres: `date '2026-03-31' - interval '1 month'` es
   *      el 28 de febrero, sin casos especiales en el código.
   *   3. El proceso Node corre con la zona horaria del servidor, que no tiene
   *      por qué ser la del restaurante.
   *
   * El tramo de comparación es el **período anterior completo** cuando el
   * consultado ya cerró (junio contra mayo entero), y el **mismo número de
   * días transcurridos** cuando todavía está en curso (del 1 al 14 de
   * septiembre contra el 1 al 14 de agosto). Comparar catorce días contra un
   * mes completo es la forma más fácil de que un dashboard mienta, y comparar
   * dos meses cerrados de distinto largo recortando el más corto es la otra.
   *
   * El fin del período anterior es siempre `desde - 1`: `desde` es el propio
   * día, el día 1 del mes o el 1 de enero, así que el día anterior es por
   * construcción el último del período previo. No hace falta un CASE.
   */
  private async resolverRango(restauranteId: string, periodo: PeriodoReporte, fecha?: string): Promise<RangoResuelto> {
    const filas = await this.prisma.$queryRaw<
      { fecha: string; desde: string; hasta: string; en_curso: boolean; cmp_desde: string; cmp_hasta: string }[]
    >`
      WITH "r" AS (
        SELECT "zona_horaria", "hora_corte_dia"
          FROM "restaurante"
         WHERE "id" = ${restauranteId}::uuid
      ),
      "ancla" AS (
        SELECT
          hayai_fecha_operativa(now(), "r"."zona_horaria", "r"."hora_corte_dia")                       AS "hoy",
          coalesce(${fecha ?? null}::date,
                   hayai_fecha_operativa(now(), "r"."zona_horaria", "r"."hora_corte_dia"))             AS "fecha"
        FROM "r"
      ),
      "rango" AS (
        SELECT
          "fecha", "hoy",
          CASE ${periodo}::text
            WHEN 'dia' THEN "fecha"
            WHEN 'mes' THEN date_trunc('month', "fecha")::date
            ELSE            date_trunc('year',  "fecha")::date
          END AS "desde",
          -- Recortado a hoy: un mes en curso llega al día operativo actual,
          -- no al 30. Así el frontend puede rotular el rango sin mentir.
          CASE ${periodo}::text
            WHEN 'dia' THEN "fecha"
            WHEN 'mes' THEN least((date_trunc('month', "fecha") + interval '1 month' - interval '1 day')::date, "hoy")
            ELSE            least((date_trunc('year',  "fecha") + interval '1 year'  - interval '1 day')::date, "hoy")
          END AS "hasta"
        FROM "ancla"
      ),
      "marco" AS (
        SELECT
          "fecha", "hoy", "desde", "hasta",
          ("hasta" = "hoy") AS "en_curso",
          CASE ${periodo}::text
            WHEN 'dia' THEN "desde" - 1
            WHEN 'mes' THEN ("desde" - interval '1 month')::date
            ELSE            ("desde" - interval '1 year')::date
          END AS "cmp_desde"
        FROM "rango"
      )
      SELECT
        to_char("fecha", 'YYYY-MM-DD')     AS "fecha",
        to_char("desde", 'YYYY-MM-DD')     AS "desde",
        to_char("hasta", 'YYYY-MM-DD')     AS "hasta",
        "en_curso",
        to_char("cmp_desde", 'YYYY-MM-DD') AS "cmp_desde",
        to_char(
          CASE WHEN "en_curso"
               THEN least("cmp_desde" + ("hasta" - "desde"), "desde" - 1)
               ELSE "desde" - 1
          END, 'YYYY-MM-DD')               AS "cmp_hasta"
      FROM "marco"
    `;

    const fila = filas[0];
    if (!fila) throw new NotFoundException('Restaurante no encontrado');
    return {
      fecha: fila.fecha,
      desde: fila.desde,
      hasta: fila.hasta,
      enCurso: fila.en_curso,
      cmpDesde: fila.cmp_desde,
      cmpHasta: fila.cmp_hasta,
    };
  }

  /**
   * Suma de un tramo de días operativos, leída de `v_venta_dia`.
   *
   * Se agrega sobre la vista y no sobre `comanda` a propósito: la vista es la
   * definición única de "qué cuenta como venta" (sólo `estado = 'cobrada'`,
   * `ventas_usd` sin propina). Repetir ese WHERE aquí crearía una segunda
   * definición que puede quedarse atrás. El predicado por
   * `(restaurante_id, fecha_operativa)` son columnas de agrupación de la
   * vista, así que Postgres lo empuja al índice
   * `comanda (restaurante_id, fecha_operativa, estado)` en vez de agregar la
   * tabla entera.
   */
  private async totalesDelRango(restauranteId: string, desde: string, hasta: string): Promise<VentaResumen> {
    const filas = await this.prisma.$queryRawUnsafe<FilaResumen[]>(
      `
      SELECT ${METRICAS}
        FROM "v_venta_dia" v
       WHERE v."restaurante_id" = $1::uuid
         AND v."fecha_operativa" BETWEEN $2::date AND $3::date
      `,
      restauranteId,
      desde,
      hasta,
    );
    return filas[0] ? aResumen(filas[0]) : { ...RESUMEN_VACIO };
  }

  /**
   * Desglose interno del período, **denso**: los turnos sin venta, los días
   * cerrados y los meses que aún no llegaron vienen en cero en vez de faltar.
   * Una serie con huecos hace que una gráfica de barras comprima el eje y
   * dibuje un mes sin domingos como si se hubiera vendido todos los días.
   *
   * El calendario se genera en SQL (`generate_series`, `enum_range`) y se le
   * pega la venta con LEFT JOIN. Los datos se agregan ANTES, en el CTE, para
   * que la vista se recorra una sola vez con el rango ya aplicado.
   */
  private async serieDelRango(
    restauranteId: string,
    granularidad: GranularidadSerie,
    desde: string,
    hasta: string,
  ): Promise<VentaPunto[]> {
    const calendario: Record<GranularidadSerie, string> = {
      // enum_range respeta el orden de declaración del enum, que en
      // `turno_servicio` ya es el cronológico del día operativo
      // (desayuno → almuerzo → cena → madrugada).
      turno: `
        SELECT "t"."turno"::text AS "clave", ${METRICAS}
          FROM unnest(enum_range(NULL::"turno_servicio")) AS "t"("turno")
          LEFT JOIN "datos" v ON v."turno" = "t"."turno"
         GROUP BY "t"."turno"
         ORDER BY "t"."turno"
      `,
      dia: `
        SELECT to_char("d"."dia", 'YYYY-MM-DD') AS "clave", ${METRICAS}
          FROM generate_series($2::date, $3::date, interval '1 day') AS "d"("dia")
          LEFT JOIN "datos" v ON v."fecha_operativa" = "d"."dia"::date
         GROUP BY "d"."dia"
         ORDER BY "d"."dia"
      `,
      mes: `
        SELECT to_char("m"."mes", 'YYYY-MM') AS "clave", ${METRICAS}
          FROM generate_series(date_trunc('month', $2::date),
                               date_trunc('month', $3::date),
                               interval '1 month') AS "m"("mes")
          LEFT JOIN "datos" v
            ON v."fecha_operativa" >= "m"."mes"::date
           AND v."fecha_operativa" <  ("m"."mes" + interval '1 month')::date
         GROUP BY "m"."mes"
         ORDER BY "m"."mes"
      `,
    };

    const filas = await this.prisma.$queryRawUnsafe<(FilaResumen & { clave: string })[]>(
      `
      WITH "datos" AS (
        SELECT "fecha_operativa", "turno", "comandas", "comensales",
               "total_usd", "ventas_usd", "propinas_usd", "descuentos_usd", "impuestos_usd"
          FROM "v_venta_dia"
         WHERE "restaurante_id" = $1::uuid
           AND "fecha_operativa" BETWEEN $2::date AND $3::date
      )
      ${calendario[granularidad]}
      `,
      restauranteId,
      desde,
      hasta,
    );

    return filas.map((f) => ({ clave: f.clave, ...aResumen(f) }));
  }

  /**
   * GET /reportes/dia — superado por `GET /reportes/ventas?periodo=dia`, que
   * devuelve lo mismo (y el desglose por turno) en camelCase y resolviendo él
   * la fecha. Se mantiene con la MISMA forma de respuesta porque el frontend
   * desplegado lo consume tal cual, con sus filas crudas de `v_venta_dia`.
   * Lo único que cambia es que `fecha` pasa a ser opcional.
   */
  async ventasDelDia(restauranteId: string, fecha?: string) {
    if (!fecha) fecha = (await this.resolverRango(restauranteId, 'dia')).fecha;
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
   *
   * Acepta el mismo `periodo` que `/reportes/ventas` para que el ranking del
   * mes o del año no dependa de que el frontend adivine el rango de días
   * operativos. `desde`/`hasta` siguen funcionando: son el camino que usa el
   * frontend desplegado.
   */
  async productosVendidos(
    restauranteId: string,
    opciones: {
      periodo?: PeriodoReporte;
      fecha?: string;
      desde?: string;
      hasta?: string;
      orden?: 'cantidad' | 'ingreso';
      limite?: number;
    } = {},
  ) {
    const { periodo, fecha, orden = 'cantidad', limite = 10 } = opciones;

    let desde = opciones.desde;
    let hasta = opciones.hasta;
    if (periodo || !desde || !hasta) {
      // Sin rango explícito el endpoint devolvía [] aunque el día tuviera
      // ventas; el default correcto es el día operativo en curso.
      const rango = await this.resolverRango(restauranteId, periodo ?? 'dia', fecha);
      desde = rango.desde;
      hasta = rango.hasta;
    }

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

  /**
   * GET /reportes/cierre-caja — desglose por método de pago y auditoría de
   * descuadres. Sigue siendo de UN día operativo: el cierre de caja es una
   * operación diaria, no un acumulado (`fecha` ausente = el día en curso).
   */
  async cierreCaja(restauranteId: string, fecha?: string) {
    if (!fecha) fecha = (await this.resolverRango(restauranteId, 'dia')).fecha;
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
