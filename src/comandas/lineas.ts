import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { nuevoId } from '../comun/id';
import { Prisma } from '../generated/prisma/client';

/**
 * Operaciones sobre LÍNEAS que comparten el cobro por cliente y la
 * reasignación de deuda (docs/DECISIONES-DATOS.md §15.4): bloquear las líneas
 * elegidas y partir una línea cuando se toma sólo una parte de su cantidad.
 */

export const redondear4 = (d: Prisma.Decimal) => d.toDecimalPlaces(4);

/** Una línea bloqueada con `FOR UPDATE`, ya con los Decimal reales. */
export interface LineaBloqueada {
  id: string;
  comandaId: string;
  productoId: string;
  clienteId: string;
  orden: number;
  nombreSnap: string;
  precioUnitarioSnap: Prisma.Decimal;
  destinoSnap: 'cocina' | 'barra';
  cantidad: Prisma.Decimal;
  descuentoLinea: Prisma.Decimal;
  totalLinea: Prisma.Decimal;
  nota: string | null;
  comensales: number;
}

export interface SeleccionLinea {
  lineaId: string;
  cantidad?: number;
}

export interface Particion {
  cantidad: Prisma.Decimal;
  descuentoLinea: Prisma.Decimal;
  totalLinea: Prisma.Decimal;
  restante: { cantidad: Prisma.Decimal; descuentoLinea: Prisma.Decimal; totalLinea: Prisma.Decimal };
}

export interface LineaElegida {
  linea: LineaBloqueada;
  /** true = hay que partir la línea: lo no tomado se queda como está. */
  parcial: boolean;
  /** Lo que vale la porción tomada (la línea entera, o la parte) y lo que sobra. */
  particion: Particion;
}

/**
 * ⭐ El `SELECT ... FOR UPDATE OF ci` NO es opcional ni se sustituye por un
 * `findMany` de Prisma: es lo que serializa a dos cajeros (o a un cobro y una
 * reasignación) sobre las mismas líneas. El segundo espera el lock, y al
 * reevaluar el predicado tras el COMMIT del primero ya no ve la línea.
 *
 * Deuda viva del cliente = sin factura, sin cancelar, de una comanda no
 * anulada. `soloDespachadas`: el cobro sólo toma lo que ya salió de cocina; la
 * reasignación toma también lo que sigue en cocina.
 */
export async function bloquearLineas(
  tx: Prisma.TransactionClient,
  restauranteId: string,
  clienteId: string,
  ids: string[] | undefined,
  soloDespachadas: boolean,
): Promise<LineaBloqueada[]> {
  const filtroIds = ids ? Prisma.sql`AND ci."id" = ANY(${ids}::uuid[])` : Prisma.empty;
  const filtroDespacho = soloDespachadas ? Prisma.sql`AND c."despachada_en" IS NOT NULL` : Prisma.empty;

  const filas = await tx.$queryRaw<any[]>(Prisma.sql`
    SELECT ci."id", ci."comanda_id", ci."producto_id", ci."cliente_id", ci."orden", ci."nombre_snap",
           ci."precio_unitario_snap", ci."destino_snap", ci."cantidad", ci."descuento_linea",
           ci."total_linea", ci."nota", c."comensales"
      FROM "comanda_item" ci
      JOIN "comanda" c ON c."restaurante_id" = ci."restaurante_id" AND c."id" = ci."comanda_id"
     WHERE ci."restaurante_id" = ${restauranteId}::uuid
       AND ci."cliente_id"     = ${clienteId}::uuid
       AND ci."cobro_id"     IS NULL
       AND ci."cancelado_en" IS NULL
       AND c."anulada_en"    IS NULL
       ${filtroDespacho}
       ${filtroIds}
     ORDER BY c."creada_en", ci."orden", ci."creado_en"
       FOR UPDATE OF ci
  `);

  return filas.map((f) => ({
    id: f.id,
    comandaId: f.comanda_id,
    productoId: f.producto_id,
    clienteId: f.cliente_id,
    orden: f.orden,
    nombreSnap: f.nombre_snap,
    precioUnitarioSnap: new Prisma.Decimal(f.precio_unitario_snap),
    destinoSnap: f.destino_snap,
    cantidad: new Prisma.Decimal(f.cantidad),
    descuentoLinea: new Prisma.Decimal(f.descuento_linea),
    totalLinea: new Prisma.Decimal(f.total_linea),
    nota: f.nota,
    comensales: f.comensales,
  }));
}

/** Los ids de una selección, validados (sin repetidos), o `undefined` = "todo". */
export function idsDeSeleccion(seleccion?: SeleccionLinea[]): string[] | undefined {
  if (!seleccion) return undefined;
  const ids = seleccion.map((s) => s.lineaId);
  if (new Set(ids).size !== ids.length) throw new BadRequestException('Hay líneas repetidas en la selección');
  return ids;
}

/** Cuánto vale tomar `cantidad` de una línea, y cuánto queda. El descuento de línea se reparte proporcional. */
export function calcularParticion(linea: LineaBloqueada, cantidad: Prisma.Decimal): Particion {
  if (cantidad.eq(linea.cantidad)) {
    const cero = new Prisma.Decimal(0);
    return {
      cantidad,
      descuentoLinea: linea.descuentoLinea,
      totalLinea: linea.totalLinea,
      restante: { cantidad: cero, descuentoLinea: cero, totalLinea: cero },
    };
  }
  const cantidadRestante = linea.cantidad.minus(cantidad);
  const descTomado = redondear4(linea.descuentoLinea.mul(cantidad).div(linea.cantidad));
  const descRestante = linea.descuentoLinea.minus(descTomado);
  return {
    cantidad,
    descuentoLinea: descTomado,
    totalLinea: redondear4(linea.precioUnitarioSnap.mul(cantidad).minus(descTomado)),
    restante: {
      cantidad: cantidadRestante,
      descuentoLinea: descRestante,
      totalLinea: redondear4(linea.precioUnitarioSnap.mul(cantidadRestante).minus(descRestante)),
    },
  };
}

/**
 * Cruza lo bloqueado con lo pedido. Sin selección = todas las bloqueadas,
 * enteras. Una línea pedida que no está bloqueada ya se facturó, está
 * cancelada, no salió de cocina o no es de ese cliente: 409 (otro cajero llegó
 * antes).
 */
export function elegirLineas(bloqueadas: LineaBloqueada[], seleccion?: SeleccionLinea[]): LineaElegida[] {
  if (!seleccion) {
    return bloqueadas.map((l) => ({ linea: l, parcial: false, particion: calcularParticion(l, l.cantidad) }));
  }
  const porId = new Map(bloqueadas.map((l) => [l.id, l]));
  return seleccion.map((s) => {
    const linea = porId.get(s.lineaId);
    if (!linea) {
      throw new ConflictException(
        'Alguna línea pedida ya se facturó, está cancelada, no ha salido de cocina o no es de ese cliente',
      );
    }
    const cantidad = s.cantidad === undefined ? linea.cantidad : new Prisma.Decimal(s.cantidad);
    if (cantidad.lte(0) || cantidad.gt(linea.cantidad)) {
      throw new BadRequestException(
        `La cantidad de "${linea.nombreSnap}" debe ser mayor que 0 y no pasar de ${linea.cantidad.toString()}`,
      );
    }
    return { linea, parcial: cantidad.lt(linea.cantidad), particion: calcularParticion(linea, cantidad) };
  });
}

/**
 * Parte una línea: la original conserva lo no tomado (sigue como deuda del
 * mismo cliente, sin factura) y una línea NUEVA —mismos snapshots, misma
 * comanda— lleva la porción tomada, ya con su destino (factura o deudor nuevo).
 * La suma de unidades se conserva. Devuelve la línea nueva.
 */
export async function partirLinea(
  tx: Prisma.TransactionClient,
  restauranteId: string,
  elegida: LineaElegida,
  destino: { clienteId?: string; cobroId?: string },
) {
  const { linea, particion } = elegida;
  await tx.comandaItem.update({
    where: { id: linea.id },
    data: {
      cantidad: particion.restante.cantidad,
      descuentoLinea: particion.restante.descuentoLinea,
      totalLinea: particion.restante.totalLinea,
    },
  });
  return tx.comandaItem.create({
    data: {
      id: nuevoId(),
      restauranteId,
      comandaId: linea.comandaId,
      productoId: linea.productoId,
      clienteId: destino.clienteId ?? linea.clienteId,
      cobroId: destino.cobroId ?? null,
      orden: linea.orden,
      nombreSnap: linea.nombreSnap,
      precioUnitarioSnap: linea.precioUnitarioSnap,
      destinoSnap: linea.destinoSnap,
      cantidad: particion.cantidad,
      descuentoLinea: particion.descuentoLinea,
      totalLinea: particion.totalLinea,
      nota: linea.nota,
    },
  });
}

export interface EntradaLinea {
  productoId: string;
  cantidad: number;
  nota?: string;
}

/**
 * Líneas nuevas desde el menú, con snapshot de nombre, precio y destino. El
 * total de la línea se redondea a 4 decimales igual que el CHECK
 * `comanda_item_total_coherente`. `cobroId` = entran ya facturadas (corrección
 * de una factura).
 */
export async function crearLineas(
  tx: Prisma.TransactionClient,
  restauranteId: string,
  comandaId: string,
  clienteId: string,
  entradas: EntradaLinea[],
  ordenInicial: number,
  cobroId?: string,
) {
  const productos = await tx.producto.findMany({
    where: { restauranteId, id: { in: entradas.map((i) => i.productoId) }, activo: true },
  });
  const porId = new Map(productos.map((p) => [p.id, p]));

  let orden = ordenInicial;
  const creados: Prisma.ComandaItemGetPayload<object>[] = [];
  for (const entrada of entradas) {
    const producto = porId.get(entrada.productoId);
    if (!producto) throw new NotFoundException(`Producto ${entrada.productoId} no encontrado`);
    if (!producto.disponible) throw new ConflictException(`"${producto.nombre}" no está disponible hoy`);

    const cantidad = new Prisma.Decimal(entrada.cantidad);
    creados.push(
      await tx.comandaItem.create({
        data: {
          id: nuevoId(),
          restauranteId,
          comandaId,
          productoId: producto.id,
          clienteId,
          cobroId: cobroId ?? null,
          orden: orden++,
          nombreSnap: producto.nombre,
          precioUnitarioSnap: producto.precio,
          destinoSnap: producto.destino,
          cantidad,
          totalLinea: redondear4(producto.precio.mul(cantidad)),
          nota: entrada.nota,
        },
      }),
    );
  }
  return creados;
}

/** Siguiente `orden` libre de una comanda. */
export async function siguienteOrden(tx: Prisma.TransactionClient, restauranteId: string, comandaId: string) {
  const { _max } = await tx.comandaItem.aggregate({ where: { restauranteId, comandaId }, _max: { orden: true } });
  return (_max.orden ?? -1) + 1;
}
