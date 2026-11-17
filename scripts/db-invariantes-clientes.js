#!/usr/bin/env node
/**
 * Aserciones de la migración 20261105120100 (cliente + facturación por líneas +
 * correcciones auditadas, docs/DECISIONES-DATOS.md §15) contra un Postgres
 * REAL con el esquema aplicado.
 *
 * No deja rastro: todo ocurre dentro de UNA transacción que termina en
 * ROLLBACK, con su propio restaurante de prueba. Los triggers diferidos se
 * fuerzan con `SET CONSTRAINTS ALL IMMEDIATE` dentro de cada SAVEPOINT, que es
 * exactamente lo que haría el COMMIT.
 *
 * Uso:  DATABASE_URL=postgresql://... node scripts/db-invariantes-clientes.js
 * Por prudencia sólo corre contra localhost salvo ALLOW_REMOTE_VERIFY=yes.
 */
require('dotenv/config');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL');
  process.exit(1);
}
const host = new URL(url).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host) && process.env.ALLOW_REMOTE_VERIFY !== 'yes') {
  console.error(`DATABASE_URL apunta a ${host}; usa ALLOW_REMOTE_VERIFY=yes si de verdad quieres correrlo ahí`);
  process.exit(1);
}

// El día operativo en curso del restaurante de prueba (zona y corte por defecto).
const HOY = "hayai_fecha_operativa(now(), 'America/Caracas', '05:00'::time)";

const db = new Client({ connectionString: url });
let fallos = 0;
let total = 0;
const q = (sql, params) => db.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];

/** Debe pasar, también en el COMMIT simulado. El estado queda para lo siguiente. */
async function ok(nombre, fn) {
  total++;
  await q('SAVEPOINT t');
  try {
    await fn();
    await q('SET CONSTRAINTS ALL IMMEDIATE');
    await q('SET CONSTRAINTS ALL DEFERRED');
    await q('RELEASE SAVEPOINT t');
    console.log(`  ok    ${nombre}`);
  } catch (e) {
    await q('ROLLBACK TO SAVEPOINT t');
    await q('SET CONSTRAINTS ALL DEFERRED');
    fallos++;
    console.log(`  FALLA ${nombre}: ${e.message}`);
  }
}

/** Debe fallar con ESE constraint (inmediato o al COMMIT). Se deshace siempre. */
async function falla(nombre, constraint, fn) {
  total++;
  await q('SAVEPOINT t');
  try {
    await fn();
    await q('SET CONSTRAINTS ALL IMMEDIATE');
    await q('ROLLBACK TO SAVEPOINT t');
    await q('SET CONSTRAINTS ALL DEFERRED');
    fallos++;
    console.log(`  FALLA ${nombre}: se esperaba ${constraint} y pasó`);
  } catch (e) {
    await q('ROLLBACK TO SAVEPOINT t');
    await q('SET CONSTRAINTS ALL DEFERRED');
    if (e.constraint === constraint) {
      console.log(`  ok    ${nombre} → ${constraint}`);
    } else {
      fallos++;
      console.log(`  FALLA ${nombre}: se esperaba ${constraint}, llegó ${e.code} ${e.constraint ?? ''} ${e.message}`);
    }
  }
}

function esperar(cond, mensaje) {
  if (!cond) throw new Error(mensaje);
}

// Ids legibles; el prefijo f0f0 no choca con nada real.
const id = (n) => `f0f00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const R = id(1), ADMIN = id(2), SALON = id(3), MESA5 = id(4), PLANT = id(5), CAT = id(6);
const CAFE = id(7), TORTA = id(8), TASA = id(9), RSV = id(10);
const JUAN = id(20), MARIA = id(21), BARRA = id(22);
const C1 = id(30), C2 = id(31), C3 = id(32);
const L1 = id(40), L2 = id(41), L3 = id(42), L1B = id(43), L4 = id(44);
const F1 = id(50), F2 = id(51), FAYER = id(52);

async function linea(idLinea, comanda, cliente, producto, cantidad, cobro = null) {
  const precio = producto === CAFE ? 2 : 5;
  await q(
    `INSERT INTO comanda_item (id, restaurante_id, comanda_id, producto_id, cliente_id, cobro_id, orden,
                               nombre_snap, precio_unitario_snap, destino_snap, cantidad, total_linea, actualizado_en)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, 'cocina', $9, $10, now())`,
    [idLinea, R, comanda, producto, cliente, cobro, producto === CAFE ? 'Café' : 'Torta', precio, cantidad, precio * cantidad],
  );
}

async function comanda(idComanda, cliente, numero, mesa = null) {
  await q(
    `INSERT INTO comanda (id, restaurante_id, cliente_id, tipo, salon_id, mesa_id, plantilla_id, numero_dia,
                          fecha_operativa, turno, mesero_id, actualizada_en)
     VALUES ($1, $2, $3, 'mesa', $4, $5, $6, $7, ${HOY}, 'cena', $8, now())`,
    [idComanda, R, cliente, mesa ? SALON : null, mesa, mesa ? PLANT : null, numero, ADMIN],
  );
}

/** Factura con totales coherentes. `diasAtras` > 0 = de un día ya cerrado (fixture). */
async function factura(idCobro, cliente, numero, subtotal, { descuento = 0, diasAtras = 0 } = {}) {
  const totalF = subtotal - descuento;
  await q(
    `INSERT INTO cobro (id, restaurante_id, cliente_id, numero_dia, fecha_operativa, turno, subtotal, descuento,
                        total, tasa_id, tasa_valor, total_bs, cobrado_por_id, actualizado_en)
     VALUES ($1, $2, $3, $4, ${HOY} - $5::int, 'cena', $6, $7, $8::numeric, $9, 100, $8::numeric * 100, $10, now())`,
    [idCobro, R, cliente, numero, diasAtras, subtotal, descuento, totalF, TASA, ADMIN],
  );
}

/** Pago en USD; negativo = devolución. `diasAtras` fecha el movimiento en el pasado (fixture). */
async function pago(cobro, montoUsd, { metodo = 'efectivo_usd', diasAtras = 0 } = {}) {
  await q(
    `INSERT INTO cobro_pago (id, restaurante_id, cobro_id, metodo, moneda, monto, monto_usd, recibido_en, registrado_por_id)
     VALUES (gen_random_uuid(), $1, $2, $3, 'USD', $4, $4, now() - make_interval(days => $5::int), $6)`,
    [R, cobro, metodo, montoUsd, diasAtras, ADMIN],
  );
}

const estado = (c) => uno('SELECT estado, total FROM comanda WHERE id = $1', [c]);
const cuenta = (k) => uno('SELECT * FROM v_cuenta_cliente WHERE cliente_id = $1', [k]);

async function main() {
  await db.connect();
  await q('BEGIN');
  try {
    // ── Fixture ────────────────────────────────────────────────────────────
    await q(`INSERT INTO restaurante (id, slug, nombre, actualizado_en) VALUES ($1, 'verif-clientes-jorbi', 'Verif', now())`, [R]);
    await q(`INSERT INTO usuario (id, restaurante_id, nombre, usuario, clave_hash, rol, actualizado_en)
             VALUES ($1, $2, 'Admin', 'admin', '$argon2id$x', 'administrador', now())`, [ADMIN, R]);
    await q(`INSERT INTO salon (id, restaurante_id, nombre, actualizado_en) VALUES ($1, $2, 'Salón', now())`, [SALON, R]);
    await q(`INSERT INTO mesa (id, restaurante_id, salon_id, etiqueta, actualizada_en) VALUES ($1, $2, $3, '5', now())`, [MESA5, R, SALON]);
    await q(`INSERT INTO plantilla (id, restaurante_id, salon_id, nombre, activa, actualizada_en) VALUES ($1, $2, $3, 'Normal', true, now())`, [PLANT, R, SALON]);
    await q(`INSERT INTO plantilla_mesa (restaurante_id, plantilla_id, mesa_id, pos_x, pos_y, forma, capacidad, actualizada_en)
             VALUES ($1, $2, $3, 0, 0, 'cuadrada', 4, now())`, [R, PLANT, MESA5]);
    await q(`INSERT INTO categoria (id, restaurante_id, nombre, actualizada_en) VALUES ($1, $2, 'Todo', now())`, [CAT, R]);
    await q(`INSERT INTO producto (id, restaurante_id, categoria_id, nombre, precio, actualizado_en) VALUES
             ($1, $3, $4, 'Café', 2, now()), ($2, $3, $4, 'Torta', 5, now())`, [CAFE, TORTA, R, CAT]);
    await q(`INSERT INTO tasa_cambio (id, restaurante_id, fecha, valor) VALUES ($1, $2, current_date, 100)`, [TASA, R]);
    await q(`INSERT INTO reservacion (id, restaurante_id, salon_id, plantilla_id, mesa_id, cliente_nombre, personas, inicia_en,
                                      termina_en, estado, codigo_publico, codigo_corto, actualizada_en)
             VALUES ($1, $2, $3, $4, $5, 'Juan', 2, now(), now() + interval '1 hour', 'sentada', 'QR-VERIF-JORBI', 'R-V', now())`,
      [RSV, R, SALON, PLANT, MESA5]);
    // Lo que hará el servicio al abrir cada transacción que corrige algo.
    await q(`SELECT set_config('app.usuario_id', $1, true)`, [ADMIN]);

    console.log('B · Cliente como unidad de cobro');
    await ok('Juan se sienta en la mesa 5 con su reserva; María y "Barra" sin mesa', async () => {
      await q(`INSERT INTO cliente (id, restaurante_id, nombre, mesa_id, reservacion_id, fecha_operativa, creado_por_id, actualizado_en)
               VALUES ($1, $4, 'Juan', $5, $6, ${HOY}, $7, now()),
                      ($2, $4, 'María', NULL, NULL, ${HOY}, $7, now()),
                      ($3, $4, 'Barra', NULL, NULL, ${HOY}, $7, now())`,
        [JUAN, MARIA, BARRA, R, MESA5, RSV, ADMIN]);
      const m = await uno('SELECT estado, clientes, sentada_cliente FROM v_mesa_estado WHERE mesa_id = $1', [MESA5]);
      esperar(m.estado === 'ocupada' && m.clientes === 1 && m.sentada_cliente === 'Juan', `plano: ${JSON.stringify(m)}`);
    });
    await falla('un segundo cliente abierto para la misma reserva', 'cliente_reservacion_abierta_unica', () =>
      q(`INSERT INTO cliente (id, restaurante_id, nombre, reservacion_id, fecha_operativa, actualizado_en)
         VALUES (gen_random_uuid(), $1, 'Juan bis', $2, current_date, now())`, [R, RSV]));
    await falla('nombre de cliente con espacios de borde', 'cliente_nombre_normalizado', () =>
      q(`INSERT INTO cliente (id, restaurante_id, nombre, fecha_operativa, actualizado_en)
         VALUES (gen_random_uuid(), $1, ' Ana', current_date, now())`, [R]));
    await ok('un cliente SIN mesa pide (comanda tipo mesa sin mesa) y la cocina ve su nombre', async () => {
      await comanda(C3, MARIA, 3);
      await linea(L4, C3, MARIA, TORTA, 1);
      const k = await uno('SELECT cliente_nombre, mesa_id FROM v_cola_despacho WHERE comanda_id = $1', [C3]);
      esperar(k.cliente_nombre === 'María' && k.mesa_id === null, JSON.stringify(k));
    });
    await falla('para llevar con mesa', 'comanda_tipo_coherente', () =>
      q(`INSERT INTO comanda (id, restaurante_id, cliente_id, tipo, salon_id, mesa_id, plantilla_id, numero_dia,
                              fecha_operativa, turno, actualizada_en)
         VALUES (gen_random_uuid(), $1, $2, 'para_llevar', $3, $4, $5, 99, current_date, 'cena', now())`,
        [R, JUAN, SALON, MESA5, PLANT]));

    console.log('Comanda: total y estado derivados de las líneas');
    await ok('3 cafés + 1 torta → pendiente, total 11 (en cocina)', async () => {
      await comanda(C1, JUAN, 1, MESA5);
      await linea(L1, C1, JUAN, CAFE, 3);
      await linea(L2, C1, JUAN, TORTA, 1);
      const e = await estado(C1);
      esperar(e.estado === 'pendiente' && Number(e.total) === 11, JSON.stringify(e));
      const k = await cuenta(JUAN);
      esperar(Number(k.total_en_cocina) === 11 && Number(k.total_por_cobrar) === 0, JSON.stringify(k));
    });
    await falla('total_linea que miente', 'comanda_item_total_coherente', () =>
      q(`UPDATE comanda_item SET total_linea = 1 WHERE id = $1`, [L1]));
    await falla('facturar una línea que sigue en cocina', 'comanda_cobro_tras_despacho', async () => {
      await factura(F1, JUAN, 1, 6);
      await q(`UPDATE comanda_item SET cobro_id = $1 WHERE id = $2`, [F1, L1]);
    });
    await ok('despachar → despachada', async () => {
      await q(`UPDATE comanda SET despachada_en = now() WHERE id IN ($1, $2)`, [C1, C3]);
      esperar((await estado(C1)).estado === 'despachada', 'no quedó despachada');
    });

    console.log('C · Factura por líneas, con cantidades parciales');
    await ok('cobrar 2 de los 3 cafés: partir la línea (1 queda + 2 se facturan)', async () => {
      await factura(F1, JUAN, 1, 4);
      await q(`UPDATE comanda_item SET cantidad = 1, total_linea = 2 WHERE id = $1`, [L1]);
      await linea(L1B, C1, JUAN, CAFE, 2, F1);
      await pago(F1, 4);
      const e = await estado(C1);
      esperar(e.estado === 'cobrada_parcial' && Number(e.total) === 11, JSON.stringify(e));
      const k = await cuenta(JUAN);
      esperar(Number(k.total_por_cobrar) === 7 && Number(k.total_cobrado) === 4 && k.facturas === 1, JSON.stringify(k));
    });
    await falla('factura vacía (la carrera de dos cajeros)', 'cobro_no_vacio', async () => {
      await factura(F2, JUAN, 2, 5);
      await pago(F2, 5);
    });
    await falla('subtotal que no sale de las líneas', 'cobro_subtotal_coherente', async () => {
      await factura(F2, JUAN, 2, 9);
      await q(`UPDATE comanda_item SET cobro_id = $1 WHERE id = $2`, [F2, L2]);
      await pago(F2, 9);
    });
    await falla('total que no sale del subtotal', 'cobro_total_coherente', async () => {
      await factura(F2, JUAN, 2, 5);
      await q(`UPDATE comanda_item SET cobro_id = $1 WHERE id = $2`, [F2, L2]);
      await q(`UPDATE cobro SET total = 6, total_bs = 600 WHERE id = $1`, [F2]);
      await pago(F2, 6);
    });
    await falla('pagos que no cuadran', 'cobro_pagos_cuadran', async () => {
      await factura(F2, JUAN, 2, 5);
      await q(`UPDATE comanda_item SET cobro_id = $1 WHERE id = $2`, [F2, L2]);
      await pago(F2, 4);
    });
    await falla('facturar la línea de María en la factura de Juan', 'comanda_item_restaurante_id_cobro_id_cliente_id_fkey', () =>
      q(`UPDATE comanda_item SET cobro_id = $1 WHERE id = $2`, [F1, L4]));
    await falla('reasignar a María una línea YA facturada', 'comanda_item_restaurante_id_cobro_id_cliente_id_fkey', () =>
      q(`UPDATE comanda_item SET cliente_id = $1 WHERE id = $2`, [MARIA, L1B]));
    await falla('facturar una línea cancelada', 'comanda_item_factura_linea_viva', async () => {
      await q(`UPDATE comanda_item SET cancelado_en = now() WHERE id = $1`, [L2]);
      await q(`UPDATE comanda_item SET cobro_id = $1 WHERE id = $2`, [F1, L2]);
    });
    await falla('anular una comanda con líneas facturadas', 'comanda_anulada_no_cobrada', () =>
      q(`UPDATE comanda SET anulada_en = now(), anulada_por_id = $2, motivo_anulacion = 'x' WHERE id = $1`, [C1, ADMIN]));
    await falla('mover una línea a otra comanda', 'comanda_item_comanda_fija', () =>
      q(`UPDATE comanda_item SET comanda_id = $1 WHERE id = $2`, [C3, L2]));
    await ok('reasignar la torta pendiente de Juan a María (la deuda pasa a María, queda en bitácora)', async () => {
      await q(`UPDATE comanda_item SET cliente_id = $1 WHERE id = $2`, [MARIA, L2]);
      const [j, m] = [await cuenta(JUAN), await cuenta(MARIA)];
      esperar(Number(j.total_por_cobrar) === 2 && Number(m.total_por_cobrar) === 10, `${JSON.stringify(j)} ${JSON.stringify(m)}`);
      const b = await uno(`SELECT cambios FROM bitacora WHERE entidad_id = $1 ORDER BY creado_en DESC LIMIT 1`, [L2]);
      esperar(b && b.cambios.includes('cliente_id'), 'la reasignación no quedó en la bitácora');
    });
    await ok('anular la comanda de María: su torta deja de ser deuda', async () => {
      await q(`UPDATE comanda SET anulada_en = now(), anulada_por_id = $2, motivo_anulacion = 'error' WHERE id = $1`, [C3, ADMIN]);
      esperar(Number((await cuenta(MARIA)).total_por_cobrar) === 5, 'la deuda de María debería ser sólo la torta reasignada');
    });
    await falla('tocar una línea de una comanda anulada', 'comanda_item_comanda_anulada', () =>
      q(`UPDATE comanda_item SET nota = 'x' WHERE id = $1`, [L4]));
    await falla('cerrar a Juan debiendo un café', 'cliente_cierre_sin_deuda', () =>
      q(`UPDATE cliente SET cerrado_en = now(), cerrado_por_id = $2 WHERE id = $1`, [JUAN, ADMIN]));
    await ok('Juan paga el café que faltaba y se va: la mesa queda libre', async () => {
      await factura(F2, JUAN, 2, 2);
      await q(`UPDATE comanda_item SET cobro_id = $1 WHERE id = $2`, [F2, L1]);
      await pago(F2, 2);
      await q(`UPDATE cliente SET cerrado_en = now(), cerrado_por_id = $2 WHERE id = $1`, [JUAN, ADMIN]);
      esperar((await estado(C1)).estado === 'cobrada_parcial', 'C1 debería seguir parcial (la torta es de María)');
      const m = await uno('SELECT estado FROM v_mesa_estado WHERE mesa_id = $1', [MESA5]);
      esperar(m.estado === 'libre', `mesa ${m.estado}`);
    });
    await falla('anotarle consumo a Juan ya cerrado', 'cliente_cerrado', () => linea(randomUUID(), C1, JUAN, CAFE, 1));
    await falla('devolverle deuda a Juan cerrado (desfacturar)', 'cliente_cerrado', () =>
      q(`UPDATE comanda_item SET cobro_id = NULL WHERE id = $1`, [L1]));

    console.log('A · Corregir una factura emitida (hoy)');
    await falla('bajar un café facturado SIN devolver el dinero', 'cobro_pagos_cuadran', async () => {
      await q(`UPDATE comanda_item SET cantidad = 1, total_linea = 2 WHERE id = $1`, [L1B]);
      await q(`UPDATE cobro SET subtotal = 2, total = 2, total_bs = 200 WHERE id = $1`, [F1]);
    });
    await falla('…ni sin recalcular la factura', 'cobro_subtotal_coherente', () =>
      q(`UPDATE comanda_item SET cantidad = 1, total_linea = 2 WHERE id = $1`, [L1B]));
    await ok('bajar de 2 a 1 café facturado: factura recalculada + devolución de 2 USD, en bitácora', async () => {
      await q(`SELECT set_config('app.motivo', 'el cliente devolvió un café', true)`);
      await q(`UPDATE comanda_item SET cantidad = 1, total_linea = 2 WHERE id = $1`, [L1B]);
      await q(`UPDATE cobro SET subtotal = 2, total = 2, total_bs = 200 WHERE id = $1`, [F1]);
      await pago(F1, -2);
      const b = await uno(`SELECT count(*)::int n FROM bitacora WHERE entidad_id IN ($1, $2) AND motivo = 'el cliente devolvió un café'`, [L1B, F1]);
      esperar(b.n === 2, `bitácora: ${b.n} filas`);
      const d = await uno(`SELECT count(*)::int n FROM v_cobro_descuadre WHERE restaurante_id = $1`, [R]);
      esperar(d.n === 0, 'descuadre');
      const caja = await uno(`SELECT sum(monto_usd) usd, sum(devoluciones)::int dev FROM v_venta_dia_metodo
                               WHERE restaurante_id = $1 AND fecha_operativa = ${HOY}`, [R]);
      esperar(Number(caja.usd) === 4 && caja.dev === 1, `caja: ${JSON.stringify(caja)}`);
    });
    await falla('corrección sin autor', 'bitacora_sin_autor', async () => {
      await q(`SELECT set_config('app.usuario_id', '', true)`);
      await q(`UPDATE comanda_item SET nota = 'sin hielo' WHERE id = $1`, [L1B]);
    });
    await q(`SELECT set_config('app.usuario_id', $1, true)`, [ADMIN]);
    await falla('editar un pago registrado', 'cobro_pago_inmutable', () =>
      q(`UPDATE cobro_pago SET monto = 1, monto_usd = 1 WHERE cobro_id = $1 AND monto > 0`, [F1]));
    await falla('un pago de 0', 'cobro_pago_monto_valido', () => pago(F1, 0));
    await falla('reescribir la bitácora', 'bitacora_inmutable', () =>
      q(`UPDATE bitacora SET motivo = 'nada' WHERE restaurante_id = $1`, [R]));
    await ok('anular una factura', () =>
      q(`UPDATE cobro SET anulado_en = now(), anulado_por_id = $2, motivo_anulacion = 'prueba' WHERE id = $1`, [F2, ADMIN]));
    await falla('pagos sobre una factura anulada', 'cobro_anulado_inmutable', () => pago(F2, 1));
    await falla('reactivar una factura anulada', 'cobro_anulado_inmutable', () =>
      q(`UPDATE cobro SET anulado_en = NULL, anulado_por_id = NULL, motivo_anulacion = NULL WHERE id = $1`, [F2]));
    await falla('sacar una línea de una factura anulada', 'cobro_anulado_inmutable', async () => {
      await q(`UPDATE cliente SET cerrado_en = NULL, cerrado_por_id = NULL WHERE id = $1`, [JUAN]);
      await q(`UPDATE comanda_item SET cobro_id = NULL WHERE id = $1`, [L1]);
    });

    console.log('Corregir una factura de OTRO día: la venta cambia en su día, el dinero en la caja de hoy');
    const ventaDe = async (diasAtras) => Number((await uno(
      `SELECT coalesce(sum(total_usd), 0) v FROM v_venta_dia WHERE restaurante_id = $1 AND fecha_operativa = ${HOY} - $2::int`,
      [R, diasAtras])).v);
    const cajaDe = (diasAtras) => uno(
      `SELECT coalesce(sum(monto_usd), 0)::numeric usd, coalesce(sum(ajustes_otros_dias_usd), 0)::numeric ajustes
         FROM v_venta_dia_metodo WHERE restaurante_id = $1 AND fecha_operativa = ${HOY} - $2::int`, [R, diasAtras]);
    let ventaAyer, cajaHoy;
    await ok('una factura de AYER, emitida completa en una transacción (fixture de histórico)', async () => {
      await q(`UPDATE cliente SET cerrado_en = NULL, cerrado_por_id = NULL WHERE id = $1`, [JUAN]);
      await comanda(C2, JUAN, 2, MESA5);
      await linea(L3, C2, JUAN, TORTA, 2);
      await q(`UPDATE comanda SET despachada_en = now() WHERE id = $1`, [C2]);
      await factura(FAYER, JUAN, 9, 10, { diasAtras: 1 });
      await q(`UPDATE comanda_item SET cobro_id = $1 WHERE id = $2`, [FAYER, L3]);
      await pago(FAYER, 10, { diasAtras: 1 });
      ventaAyer = await ventaDe(1);
      cajaHoy = await cajaDe(0);
      const cajaAyer = await cajaDe(1);
      esperar(ventaAyer === 10 && Number(cajaAyer.usd) === 10, `venta ${ventaAyer} caja ${JSON.stringify(cajaAyer)}`);
    });
    await ok('bajar hoy de 2 a 1 torta la factura de ayer: venta de AYER −5, devolución en la caja de HOY', async () => {
      await q(`SELECT set_config('app.motivo', 'cobramos una torta de más ayer', true)`);
      await q(`UPDATE comanda_item SET cantidad = 1, total_linea = 5 WHERE id = $1`, [L3]);
      await q(`UPDATE cobro SET subtotal = 5, total = 5, total_bs = 500 WHERE id = $1`, [FAYER]);
      await pago(FAYER, -5);
      const [vAyer, cAyer, cHoy] = [await ventaDe(1), await cajaDe(1), await cajaDe(0)];
      esperar(vAyer === ventaAyer - 5, `venta de ayer ${vAyer}`);
      esperar(Number(cAyer.usd) === 10, `la caja de ayer no debía cambiar: ${JSON.stringify(cAyer)}`);
      esperar(Number(cHoy.usd) === Number(cajaHoy.usd) - 5 && Number(cHoy.ajustes) === -5, `caja de hoy ${JSON.stringify(cHoy)}`);
      const b = await uno(`SELECT count(*)::int n FROM bitacora WHERE entidad_id IN ($1, $2) AND motivo = 'cobramos una torta de más ayer'`, [L3, FAYER]);
      esperar(b.n === 2, `bitácora: ${b.n} filas`);
    });
    await falla('…sin la devolución, no', 'cobro_pagos_cuadran', async () => {
      await q(`UPDATE cobro SET descuento = 1, total = 4, total_bs = 400 WHERE id = $1`, [FAYER]);
    });
    await falla('mover una factura de día', 'cobro_fecha_inmutable', () =>
      q(`UPDATE cobro SET fecha_operativa = fecha_operativa + 1 WHERE id = $1`, [FAYER]));
    await ok('anular la factura de ayer sigue permitido (sin cambios respecto a antes)', () =>
      q(`UPDATE cobro SET anulado_en = now(), anulado_por_id = $2, motivo_anulacion = 'prueba' WHERE id = $1`, [FAYER, ADMIN]));

    console.log(`\n${total - fallos}/${total} aserciones`);
  } finally {
    await q('ROLLBACK');
    await db.end();
  }
  process.exit(fallos ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
