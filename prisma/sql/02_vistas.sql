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
-- Se leen con `$queryRaw`.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- v_mesa_estado · el plano, ya resuelto
--
-- Una fila por mesa dibujada en una plantilla, con su geometría y su estado
-- real AHORA. Sirve a las dos pantallas a la vez:
--   · editor de plano   → WHERE plantilla_id = $1
--   · vista operativa   → WHERE plantilla_id = $1 AND plantilla_activa
-- Evita que el frontend haga tres consultas y cruce estados a mano.
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

    cmd."id"          AS "comanda_id",
    cmd."numero_dia"  AS "comanda_numero_dia",
    cmd."estado"      AS "comanda_estado",
    cmd."total"       AS "comanda_total",
    cmd."abierta_en"  AS "comanda_abierta_en",
    cmd."comensales"  AS "comanda_comensales",
    cmd."mesero_id"   AS "comanda_mesero_id",

    rsv."id"             AS "reservacion_id",
    rsv."inicia_en"      AS "reservacion_inicia_en",
    rsv."cliente_nombre" AS "reservacion_cliente",
    rsv."personas"       AS "reservacion_personas",

    CASE
      WHEN pm."bloqueada"     THEN 'bloqueada'
      WHEN cmd."id" IS NOT NULL THEN 'ocupada'
      WHEN rsv."id" IS NOT NULL THEN 'reservada'
      ELSE 'libre'
    END AS "estado"
FROM "plantilla_mesa" pm
JOIN "plantilla" pl
  ON pl."restaurante_id" = pm."restaurante_id" AND pl."id" = pm."plantilla_id"
JOIN "mesa" m
  ON m."restaurante_id" = pm."restaurante_id" AND m."id" = pm."mesa_id"
-- Comanda viva de esa mesa. El índice único parcial garantiza que hay 0 o 1,
-- y hace que este LATERAL sea una lectura de índice, no un escaneo.
LEFT JOIN LATERAL (
    SELECT c."id", c."numero_dia", c."estado", c."total",
           c."abierta_en", c."comensales", c."mesero_id"
      FROM "comanda" c
     WHERE c."restaurante_id" = pm."restaurante_id"
       AND c."mesa_id"        = pm."mesa_id"
       AND c."estado" IN ('abierta', 'por_cobrar')
     LIMIT 1
) cmd ON TRUE
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
-- v_comanda_activa · el panel lateral
--
-- "Las comandas de las mesas ocupadas ahora", con lo que el panel muestra sin
-- pedir los ítems: cuántas líneas van, cuántas faltan por servir y hace cuánto
-- está sentada la mesa.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_comanda_activa" WITH (security_invoker = true) AS
SELECT
    c."id"            AS "comanda_id",
    c."restaurante_id",
    c."tipo",
    c."salon_id",
    c."mesa_id",
    m."etiqueta"      AS "mesa_etiqueta",
    c."numero_dia",
    c."estado",
    c."comensales",
    c."mesero_id",
    u."nombre"        AS "mesero_nombre",
    c."abierta_en",
    round(extract(epoch FROM (now() - c."abierta_en")) / 60)::int AS "minutos_abierta",
    c."subtotal", c."descuento", c."impuesto", c."propina", c."total",
    it."items",
    it."items_pendientes",
    it."ultimo_envio_en"
FROM "comanda" c
LEFT JOIN "mesa" m
  ON m."restaurante_id" = c."restaurante_id" AND m."id" = c."mesa_id"
LEFT JOIN "usuario" u
  ON u."restaurante_id" = c."restaurante_id" AND u."id" = c."mesero_id"
LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE ci."estado" <> 'cancelado')                         AS "items",
           count(*) FILTER (WHERE ci."estado" IN ('pendiente', 'en_preparacion'))      AS "items_pendientes",
           max(ci."enviado_en")                                                        AS "ultimo_envio_en"
      FROM "comanda_item" ci
     WHERE ci."comanda_id" = c."id"
) it ON TRUE
WHERE c."estado" IN ('abierta', 'por_cobrar');


-- ───────────────────────────────────────────────────────────────────────────
-- v_venta_dia · ventas por día operativo y turno
--
-- Fuente del "resumen de ventas del día". Sólo comandas cobradas.
-- `ventas_usd` excluye la propina a propósito: la propina es del mesero, no
-- ingreso del restaurante, y mezclarlas infla el reporte.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_venta_dia" WITH (security_invoker = true) AS
SELECT
    c."restaurante_id",
    c."fecha_operativa",
    c."turno",
    count(*)                                   AS "comandas",
    sum(c."comensales")                        AS "comensales",
    sum(c."total")                             AS "total_usd",
    sum(c."total" - c."propina")               AS "ventas_usd",
    sum(c."propina")                           AS "propinas_usd",
    sum(c."descuento")                         AS "descuentos_usd",
    sum(c."impuesto")                          AS "impuestos_usd",
    round(avg(c."total"), 4)                   AS "ticket_promedio_usd",
    round(avg(NULLIF(c."comensales", 0)), 2)   AS "comensales_promedio"
FROM "comanda" c
WHERE c."estado" = 'cobrada'
GROUP BY c."restaurante_id", c."fecha_operativa", c."turno";


-- ───────────────────────────────────────────────────────────────────────────
-- v_venta_dia_metodo · desglose por método de pago (cuadre de caja)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_venta_dia_metodo" WITH (security_invoker = true) AS
SELECT
    c."restaurante_id",
    c."fecha_operativa",
    p."metodo",
    p."moneda",
    count(*)           AS "pagos",
    sum(p."monto")     AS "monto_moneda",
    sum(p."monto_usd") AS "monto_usd"
FROM "comanda_pago" p
JOIN "comanda" c
  ON c."restaurante_id" = p."restaurante_id" AND c."id" = p."comanda_id"
WHERE c."estado" = 'cobrada'
GROUP BY c."restaurante_id", c."fecha_operativa", p."metodo", p."moneda";


-- ───────────────────────────────────────────────────────────────────────────
-- v_producto_vendido_dia · base del "producto más vendido"
--
-- Una fila por producto y día. El ranking se saca encima con ORDER BY:
--   · por cantidad → ORDER BY cantidad DESC
--   · por ingreso  → ORDER BY ingreso_usd DESC
-- (son respuestas distintas: la empanada gana por unidades, el solomo por
-- ingreso; por eso la vista devuelve las dos y no decide por el negocio).
-- Los ítems cancelados no cuentan: se pidieron, no se vendieron.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_producto_vendido_dia" WITH (security_invoker = true) AS
SELECT
    c."restaurante_id",
    c."fecha_operativa",
    c."turno",
    ci."producto_id",
    ci."nombre_snap"       AS "producto_nombre",
    sum(ci."cantidad")     AS "cantidad",
    sum(ci."total_linea")  AS "ingreso_usd",
    count(DISTINCT ci."comanda_id") AS "comandas"
FROM "comanda_item" ci
JOIN "comanda" c
  ON c."restaurante_id" = ci."restaurante_id" AND c."id" = ci."comanda_id"
WHERE c."estado" = 'cobrada'
  AND ci."estado" <> 'cancelado'
GROUP BY c."restaurante_id", c."fecha_operativa", c."turno",
         ci."producto_id", ci."nombre_snap";


-- ───────────────────────────────────────────────────────────────────────────
-- v_comanda_descuadre · auditoría de caja
--
-- Comandas cobradas donde la suma de los pagos no coincide con el total.
-- No se puede expresar como CHECK (cruza dos tablas) y no debería ocurrir
-- nunca: si aparece una fila aquí, hay un bug de cobro o un cobro a medias.
-- Consultarla en el cierre de caja.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_comanda_descuadre" WITH (security_invoker = true) AS
SELECT
    c."restaurante_id",
    c."fecha_operativa",
    c."id" AS "comanda_id",
    c."numero_dia",
    c."total"                        AS "total_comanda",
    coalesce(sum(p."monto_usd"), 0)  AS "total_pagado",
    c."total" - coalesce(sum(p."monto_usd"), 0) AS "diferencia"
FROM "comanda" c
LEFT JOIN "comanda_pago" p
  ON p."restaurante_id" = c."restaurante_id" AND p."comanda_id" = c."id"
WHERE c."estado" = 'cobrada'
GROUP BY c."restaurante_id", c."fecha_operativa", c."id", c."numero_dia", c."total"
HAVING abs(c."total" - coalesce(sum(p."monto_usd"), 0)) > 0.01;


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
