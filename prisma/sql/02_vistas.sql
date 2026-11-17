-- ═══════════════════════════════════════════════════════════════════════════
-- 02 · Vistas de operación y reporte
--
-- Requiere PostgreSQL 15+ por `security_invoker`.
--
-- ⚠️ `WITH (security_invoker = true)` NO es cosmético. Por defecto una vista se
-- ejecuta con los permisos de SU DUEÑO, lo que significa que una vista creada
-- por el rol de migraciones SALTARÍA las políticas RLS del día que se activen
-- (03_rls.sql) y devolvería mesas de otros restaurantes. Con security_invoker
-- la vista se evalúa con el rol que consulta y RLS se aplica igual.
--
-- Prisma no modela vistas: sobreviven a `migrate dev` sin tocarlas. La
-- contrapartida es que una vista bloquea el ALTER de las columnas que usa; si
-- hay que cambiar una, la migración hace DROP VIEW → ALTER → CREATE VIEW.
-- ⚠️ Y si cambia la LISTA de columnas (no sólo su contenido), `CREATE OR
-- REPLACE` no basta ni siquiera fuera de un ALTER: Postgres exige que las
-- columnas coincidan en nombre, tipo y orden. Es lo que obligó al DROP + CREATE
-- de `v_mesa_estado` en la migración 20260915183000.
-- Se leen con `$queryRaw`.
--
-- Copia de DOCUMENTACIÓN del estado vigente: la fuente es la última migración
-- que tocó cada vista (20261105120100 para todas salvo v_venta_dia,
-- v_cobro_descuadre y v_reservacion_huerfana).
--
-- Mapa de las vistas y quién las consume:
--   v_mesa_estado         → GET /plano                (PlanoService)
--   v_cola_despacho       → GET /despacho/cola        (DespachoService, KDS)
--   v_cuenta_cliente      → cuentas por cobrar y la ficha del cliente (sustituye
--                           a v_cuenta_mesa, que ya no existe: 2026-11-05)
--   v_venta_dia           → GET /reportes/ventas, /reportes/dia
--   v_venta_dia_metodo    → GET /reportes/cierre-caja
--   v_producto_vendido_dia→ GET /reportes/productos
--   v_cobro_descuadre     → GET /reportes/cierre-caja (auditoría)
--   v_reservacion_huerfana→ POST /plantillas/:id/activar
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- v_mesa_estado · el plano, ya resuelto
--
-- Una fila por mesa dibujada en una plantilla, con su geometría y su estado
-- real AHORA. Sirve a las dos pantallas a la vez:
--   · editor de plano   → WHERE plantilla_id = $1
--   · vista operativa   → WHERE plantilla_id = $1 AND plantilla_activa
--
-- Desde 2026-11-05 (DECISIONES-DATOS §15) la ocupación la da el CLIENTE:
--   · ocupada ⟺ al menos un cliente ABIERTO sentado en la mesa (antes: una
--     comanda viva o una reserva `sentada`). Un cliente que ya pagó todo pero
--     sigue sentado mantiene la mesa ocupada; se libera al cerrarlo o moverlo.
--   · comandas / cuenta_total = la deuda viva de los clientes sentados.
--   · sentada_cliente / sentada_en / sentada_reservacion_id = el PRIMER
--     cliente sentado ("Mesa ocupada · Juan").
--   · clientes / clientes_detalle = todos los sentados [{id, nombre}].
-- Mismas columnas y en el mismo orden que antes, más las dos últimas.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_mesa_estado" WITH (security_invoker = true) AS
SELECT
    pm."restaurante_id",
    pl."salon_id",
    pm."plantilla_id",
    pl."activa"       AS "plantilla_activa",
    pm."mesa_id",
    m."etiqueta",
    pm."pos_x", pm."pos_y", pm."ancho", pm."alto", pm."rotacion",
    pm."forma", pm."capacidad", pm."bloqueada",

    coalesce(cta."comandas", 0)            AS "comandas",
    coalesce(cta."comandas_en_cocina", 0)  AS "comandas_en_cocina",
    coalesce(cta."comandas_por_cobrar", 0) AS "comandas_por_cobrar",
    coalesce(cta."cuenta_total", 0)        AS "cuenta_total",
    cli."primero_en"                       AS "ocupada_desde",
    coalesce(cta."comensales", 0)          AS "comensales",
    cli."mesero_id",

    rsv."id"             AS "reservacion_id",
    rsv."inicia_en"      AS "reservacion_inicia_en",
    rsv."cliente_nombre" AS "reservacion_cliente",
    rsv."personas"       AS "reservacion_personas",

    cli."reservacion_id" AS "sentada_reservacion_id",
    cli."nombre"         AS "sentada_cliente",
    cli."primero_en"     AS "sentada_en",

    CASE
      WHEN pm."bloqueada"        THEN 'bloqueada'
      WHEN cli."clientes" > 0    THEN 'ocupada'
      WHEN rsv."id" IS NOT NULL  THEN 'reservada'
      ELSE 'libre'
    END AS "estado",

    cli."clientes",
    cli."detalle"        AS "clientes_detalle"
FROM "plantilla_mesa" pm
JOIN "plantilla" pl
  ON pl."restaurante_id" = pm."restaurante_id" AND pl."id" = pm."plantilla_id"
JOIN "mesa" m
  ON m."restaurante_id" = pm."restaurante_id" AND m."id" = pm."mesa_id"
-- Quién está sentado. Usa `cliente_abierto_idx`. Siempre una fila (agregados).
LEFT JOIN LATERAL (
    SELECT count(*)::int                                                         AS "clientes",
           min(k."creado_en")                                                    AS "primero_en",
           (array_agg(k."nombre" ORDER BY k."creado_en"))[1]                     AS "nombre",
           (array_agg(k."creado_por_id" ORDER BY k."creado_en"))[1]              AS "mesero_id",
           (array_agg(k."reservacion_id" ORDER BY k."creado_en")
              FILTER (WHERE k."reservacion_id" IS NOT NULL))[1]                  AS "reservacion_id",
           coalesce(jsonb_agg(jsonb_build_object('id', k."id", 'nombre', k."nombre")
                              ORDER BY k."creado_en"), '[]'::jsonb)              AS "detalle",
           coalesce(array_agg(k."id"), '{}'::uuid[])                             AS "ids"
      FROM "cliente" k
     WHERE k."restaurante_id" = pm."restaurante_id"
       AND k."mesa_id"        = pm."mesa_id"
       AND k."cerrado_en" IS NULL
) cli ON TRUE
-- Su deuda viva (usa `comanda_item_deuda_idx`) y sus comensales.
LEFT JOIN LATERAL (
    SELECT count(DISTINCT ci."comanda_id")::int                                              AS "comandas",
           count(DISTINCT ci."comanda_id") FILTER (WHERE c."despachada_en" IS NULL)::int     AS "comandas_en_cocina",
           count(DISTINCT ci."comanda_id") FILTER (WHERE c."despachada_en" IS NOT NULL)::int AS "comandas_por_cobrar",
           sum(ci."total_linea")                                                             AS "cuenta_total",
           (SELECT max(c2."comensales") FROM "comanda" c2
             WHERE c2."restaurante_id" = pm."restaurante_id"
               AND c2."cliente_id" = ANY (cli."ids") AND c2."anulada_en" IS NULL)            AS "comensales"
      FROM "comanda_item" ci
      JOIN "comanda" c ON c."restaurante_id" = ci."restaurante_id" AND c."id" = ci."comanda_id"
     WHERE ci."restaurante_id" = pm."restaurante_id"
       AND ci."cliente_id" = ANY (cli."ids")
       AND ci."cobro_id"     IS NULL
       AND ci."cancelado_en" IS NULL
       AND c."anulada_en"    IS NULL
) cta ON TRUE
-- Próxima reserva que ya "pesa" sobre la mesa: desde 30 min antes de la hora
-- hasta 2 h después (una reserva de las 8pm bloquea la mesa desde las 7:30).
LEFT JOIN LATERAL (
    SELECT r."id", r."inicia_en", r."cliente_nombre", r."personas"
      FROM "reservacion" r
     WHERE r."restaurante_id" = pm."restaurante_id"
       AND r."mesa_id"        = pm."mesa_id"
       AND r."estado" IN ('pendiente', 'confirmada')
       AND r."inicia_en" BETWEEN now() - interval '30 minutes'
                             AND now() + interval '2 hours'
     ORDER BY r."inicia_en"
     LIMIT 1
) rsv ON TRUE
WHERE pl."eliminada_en" IS NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- v_cola_despacho · LA cola de cocina (KDS)
--
-- Global, todas las mesas juntas, estrictamente por orden de llegada. Cocina y
-- barra despachan la comanda como una sola unidad, así que la fila es la
-- comanda y las líneas van embebidas.
--
-- El jsonb no es decorativo: es la consulta que el KDS repite cada pocos
-- segundos, y pedir los ítems aparte sería un N+1 contra la tabla más grande
-- del sistema. Lee `comanda_cola_despacho_idx`, que ya viene ordenado.
--
-- ⚠️ Los ítems cancelados VIENEN en el jsonb, marcados con `cancelado: true`,
-- en vez de filtrarse: la cocina tiene que ver que algo se anuló si ya lo había
-- empezado. Quien sume dinero usa `comanda.total`, que sólo cuenta los vivos.
-- `cliente_id`/`cliente_nombre` (2026-11-05): la comanda puede no tener mesa.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_cola_despacho" WITH (security_invoker = true) AS
SELECT
    c."id"            AS "comanda_id",
    c."restaurante_id",
    c."tipo",
    c."mesa_id",
    m."etiqueta"      AS "mesa_etiqueta",
    c."numero_dia",
    c."creada_en",
    round(extract(epoch FROM (now() - c."creada_en")) / 60)::int AS "minutos_en_cola",
    c."mesero_id",
    u."nombre"        AS "mesero_nombre",
    c."comensales",
    c."total",
    c."notas",
    it."items",
    c."cliente_id",
    k."nombre"        AS "cliente_nombre"
FROM "comanda" c
JOIN "cliente" k      ON k."restaurante_id" = c."restaurante_id" AND k."id" = c."cliente_id"
LEFT JOIN "mesa" m    ON m."restaurante_id" = c."restaurante_id" AND m."id" = c."mesa_id"
LEFT JOIN "usuario" u ON u."restaurante_id" = c."restaurante_id" AND u."id" = c."mesero_id"
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'id',          ci."id",
             'nombre',      ci."nombre_snap",
             'cantidad',    ci."cantidad",
             'destino',     ci."destino_snap",
             'nota',        ci."nota",
             'cancelado',   ci."cancelado_en" IS NOT NULL
           ) ORDER BY ci."orden") AS "items"
      FROM "comanda_item" ci
     WHERE ci."comanda_id" = c."id"
) it ON TRUE
WHERE c."despachada_en" IS NULL
  AND c."anulada_en"    IS NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- v_cuenta_cliente · LA cuenta: una fila por cliente ABIERTO   (2026-11-05)
--
-- Sustituye a v_cuenta_mesa. "Cuentas por cobrar" = `total_por_cobrar > 0`;
-- la ficha de un cliente filtra por `cliente_id`; la de una mesa, por
-- `mesa_id` (puede haber varios clientes en la misma mesa).
--   cuenta_total      = toda su deuda viva (en cocina + despachada)
--   total_por_cobrar  = lo facturable YA (despachado)
--   total_cobrado     = lo que ya pagó en facturas vivas de esta visita
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_cuenta_cliente" WITH (security_invoker = true) AS
SELECT
    k."restaurante_id",
    k."id"            AS "cliente_id",
    k."nombre"        AS "cliente_nombre",
    k."mesa_id",
    m."etiqueta"      AS "mesa_etiqueta",
    m."salon_id",
    s."nombre"        AS "salon_nombre",
    (k."mesa_id" IS NOT NULL) AS "sentado",
    k."reservacion_id",
    k."fecha_operativa",
    k."creado_por_id" AS "mesero_id",
    k."creado_en"     AS "ocupada_desde",
    round(extract(epoch FROM (now() - k."creado_en")) / 60)::int AS "minutos_ocupada",
    d."comandas",
    d."comandas_por_cobrar",
    d."comandas_en_cocina",
    d."lineas_por_cobrar",
    d."cuenta_total",
    d."total_por_cobrar",
    d."total_en_cocina",
    cm."comensales",
    cb."facturas",
    cb."total_cobrado"
FROM "cliente" k
LEFT JOIN "mesa"  m ON m."restaurante_id" = k."restaurante_id" AND m."id" = k."mesa_id"
LEFT JOIN "salon" s ON s."restaurante_id" = m."restaurante_id" AND s."id" = m."salon_id"
-- La deuda viva. Usa `comanda_item_deuda_idx`.
LEFT JOIN LATERAL (
    SELECT count(DISTINCT ci."comanda_id")::int                                              AS "comandas",
           count(DISTINCT ci."comanda_id") FILTER (WHERE c."despachada_en" IS NOT NULL)::int AS "comandas_por_cobrar",
           count(DISTINCT ci."comanda_id") FILTER (WHERE c."despachada_en" IS NULL)::int     AS "comandas_en_cocina",
           count(*) FILTER (WHERE c."despachada_en" IS NOT NULL)::int                        AS "lineas_por_cobrar",
           coalesce(sum(ci."total_linea"), 0)                                                AS "cuenta_total",
           coalesce(sum(ci."total_linea") FILTER (WHERE c."despachada_en" IS NOT NULL), 0)   AS "total_por_cobrar",
           coalesce(sum(ci."total_linea") FILTER (WHERE c."despachada_en" IS NULL), 0)       AS "total_en_cocina"
      FROM "comanda_item" ci
      JOIN "comanda" c ON c."restaurante_id" = ci."restaurante_id" AND c."id" = ci."comanda_id"
     WHERE ci."restaurante_id" = k."restaurante_id"
       AND ci."cliente_id"     = k."id"
       AND ci."cobro_id"     IS NULL
       AND ci."cancelado_en" IS NULL
       AND c."anulada_en"    IS NULL
) d ON TRUE
-- El grupo tiene UN número de comensales; si creció, manda el mayor.
LEFT JOIN LATERAL (
    SELECT coalesce(max(c."comensales"), 0) AS "comensales"
      FROM "comanda" c
     WHERE c."restaurante_id" = k."restaurante_id" AND c."cliente_id" = k."id" AND c."anulada_en" IS NULL
) cm ON TRUE
LEFT JOIN LATERAL (
    SELECT count(*)::int AS "facturas", coalesce(sum(f."total"), 0) AS "total_cobrado"
      FROM "cobro" f
     WHERE f."restaurante_id" = k."restaurante_id" AND f."cliente_id" = k."id" AND f."anulado_en" IS NULL
) cb ON TRUE
WHERE k."cerrado_en" IS NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- v_venta_dia · ventas por día operativo y turno
--
-- La venta se reconoce cuando ENTRA EL DINERO, y el dinero entra por un cobro.
-- Por eso agrupa por `cobro.fecha_operativa` (calculada al cobrar) y no por la
-- de la comanda: el cierre de caja tiene que cuadrar con lo que hay en la
-- gaveta al final del turno, y una comanda pedida a las 23:50 y pagada a las
-- 00:10 es dinero del turno que cerró.
--
-- `ventas_usd` excluye la propina a propósito: la propina es del mesero, no
-- ingreso del restaurante, y mezclarlas infla el reporte.
--
-- ⚠️ La columna `comandas` del modelo viejo NO tiene sucesora, y es a propósito.
-- Contaba comandas cuando una comanda ERA la cuenta de la mesa; hoy ese número
-- es `cobros` (facturas emitidas = mesas atendidas) y es el denominador
-- correcto del ticket promedio. Contar además los pedidos costaba un LATERAL
-- por cobro: medido, 198 ms contra 24 ms sobre 21.900 cobros, y creciendo con
-- el histórico. "Cuántos pedidos salieron" es una pregunta operativa distinta,
-- que se responde por `comanda.despachada_en` —el día en que la cocina
-- trabajó— y no por el día en que el cliente pagó.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_venta_dia" WITH (security_invoker = true) AS
SELECT
    cb."restaurante_id",
    cb."fecha_operativa",
    cb."turno",
    count(*)::int                                   AS "cobros",
    sum(cb."comensales")                            AS "comensales",
    sum(cb."total")                                 AS "total_usd",
    sum(cb."total" - cb."propina")                  AS "ventas_usd",
    sum(cb."propina")                               AS "propinas_usd",
    sum(cb."descuento")                             AS "descuentos_usd",
    sum(cb."impuesto")                              AS "impuestos_usd",
    round(sum(cb."total") / nullif(count(*), 0), 4) AS "ticket_promedio_usd",
    round(avg(NULLIF(cb."comensales", 0)), 2)       AS "comensales_promedio"
FROM "cobro" cb
WHERE cb."anulado_en" IS NULL
GROUP BY cb."restaurante_id", cb."fecha_operativa", cb."turno";


-- ───────────────────────────────────────────────────────────────────────────
-- v_venta_dia_metodo · desglose por método de pago (cuadre de caja)
--
-- Desde 2026-11-05 agrupa por el día en que el dinero ENTRÓ o SALIÓ
-- (`cobro_pago.fecha_operativa`), no por el de la factura: una devolución hecha
-- hoy sobre una factura de ayer cuadra la caja de hoy. Para lo histórico ambos
-- días coinciden. Las devoluciones (montos negativos) suman con su signo;
-- `pagos` cuenta sólo los positivos.
-- `ajustes_otros_dias_usd` = la parte de `monto_usd` que corrige facturas de
-- OTRO día operativo (se corrigen cualquier día). Es lo que separa la caja del
-- día de la venta del día: caja = venta del día + ajustes_otros_dias_usd.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_venta_dia_metodo" WITH (security_invoker = true) AS
SELECT
    p."restaurante_id",
    p."fecha_operativa",
    p."metodo",
    p."moneda",
    count(*) FILTER (WHERE p."monto" > 0)               AS "pagos",
    count(*) FILTER (WHERE p."monto" < 0)               AS "devoluciones",
    sum(p."monto")                                      AS "monto_moneda",
    sum(p."monto_usd")                                  AS "monto_usd",
    coalesce(sum(p."monto_usd") FILTER (WHERE cb."fecha_operativa" <> p."fecha_operativa"), 0)
                                                        AS "ajustes_otros_dias_usd"
FROM "cobro_pago" p
JOIN "cobro" cb
  ON cb."restaurante_id" = p."restaurante_id" AND cb."id" = p."cobro_id"
WHERE cb."anulado_en" IS NULL
GROUP BY p."restaurante_id", p."fecha_operativa", p."metodo", p."moneda";


-- ───────────────────────────────────────────────────────────────────────────
-- v_producto_vendido_dia · base del "producto más vendido"
--
-- Una fila por producto y día. El ranking se saca encima con ORDER BY:
--   · por cantidad → ORDER BY cantidad DESC
--   · por ingreso  → ORDER BY ingreso_usd DESC
-- (son respuestas distintas: la empanada gana por unidades, el solomo por
-- ingreso; por eso la vista devuelve las dos y no decide por el negocio).
-- Los ítems cancelados no cuentan: se pidieron, no se vendieron; tampoco una
-- línea facturada y cancelada después (devolución).
--
-- El día y el turno salen del COBRO, igual que v_venta_dia. Desde 2026-11-05
-- la línea apunta a su factura directamente (`comanda_item.cobro_id`).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_producto_vendido_dia" WITH (security_invoker = true) AS
SELECT
    cb."restaurante_id",
    cb."fecha_operativa",
    cb."turno",
    ci."producto_id",
    ci."nombre_snap"       AS "producto_nombre",
    sum(ci."cantidad")     AS "cantidad",
    sum(ci."total_linea")  AS "ingreso_usd",
    count(DISTINCT ci."comanda_id") AS "comandas"
FROM "comanda_item" ci
JOIN "cobro" cb
  ON cb."restaurante_id" = ci."restaurante_id" AND cb."id" = ci."cobro_id"
WHERE cb."anulado_en"  IS NULL
  AND ci."cancelado_en" IS NULL
GROUP BY cb."restaurante_id", cb."fecha_operativa", cb."turno",
         ci."producto_id", ci."nombre_snap";


-- ───────────────────────────────────────────────────────────────────────────
-- v_cobro_descuadre · auditoría de caja  (antes v_comanda_descuadre)
--
-- Cobros donde la suma de los pagos no coincide con el total. Desde
-- 2026-11-05 lo impide el constraint trigger diferido `cobro_coherente`
-- (`cobro_pagos_cuadran`), así que sólo podría listar facturas históricas
-- anteriores a esa migración. Debe dar 0 filas siempre.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_cobro_descuadre" WITH (security_invoker = true) AS
SELECT
    cb."restaurante_id",
    cb."fecha_operativa",
    cb."id" AS "cobro_id",
    cb."numero_dia",
    cb."total"                       AS "total_cobro",
    coalesce(sum(p."monto_usd"), 0)  AS "total_pagado",
    cb."total" - coalesce(sum(p."monto_usd"), 0) AS "diferencia"
FROM "cobro" cb
LEFT JOIN "cobro_pago" p
  ON p."restaurante_id" = cb."restaurante_id" AND p."cobro_id" = cb."id"
WHERE cb."anulado_en" IS NULL
GROUP BY cb."restaurante_id", cb."fecha_operativa", cb."id", cb."numero_dia", cb."total"
HAVING abs(cb."total" - coalesce(sum(p."monto_usd"), 0)) > 0.01;


-- ───────────────────────────────────────────────────────────────────────────
-- v_reservacion_huerfana · reservas que quedaron fuera del plano
--
-- Se reservó la mesa 12 contra la plantilla "Normal" y para el sábado se
-- activó "Evento boda", donde esa mesa no existe. La reserva sigue viva pero
-- apunta a una mesa que ya no está dibujada. El anfitrión tiene que verlo
-- ANTES del sábado, no cuando llegue el cliente.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_reservacion_huerfana" WITH (security_invoker = true) AS
SELECT
    r."restaurante_id",
    r."id" AS "reservacion_id",
    r."inicia_en",
    r."cliente_nombre",
    r."personas",
    r."mesa_id",
    m."etiqueta" AS "mesa_etiqueta",
    r."plantilla_id" AS "plantilla_reservada_id",
    act."id"         AS "plantilla_activa_id",
    act."nombre"     AS "plantilla_activa_nombre"
FROM "reservacion" r
JOIN "mesa" m
  ON m."restaurante_id" = r."restaurante_id" AND m."id" = r."mesa_id"
-- LEFT y no JOIN: un salón sin plantilla activa deja a TODAS sus reservas
-- huérfanas, que es precisamente el caso que hay que ver.
LEFT JOIN LATERAL (
    SELECT pl."id", pl."nombre"
      FROM "plantilla" pl
     WHERE pl."restaurante_id" = r."restaurante_id"
       AND pl."salon_id"       = r."salon_id"
       AND pl."activa"
     LIMIT 1
) act ON TRUE
WHERE r."mesa_id" IS NOT NULL
  AND r."estado" IN ('pendiente', 'confirmada')
  AND r."inicia_en" >= now()
  AND NOT EXISTS (
        SELECT 1
          FROM "plantilla_mesa" pm
         WHERE pm."restaurante_id" = r."restaurante_id"
           AND pm."plantilla_id"   = act."id"
           AND pm."mesa_id"        = r."mesa_id"
           AND NOT pm."bloqueada"
      );
