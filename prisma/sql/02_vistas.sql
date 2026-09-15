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
-- Mapa de las vistas y quién las consume:
--   v_mesa_estado         → GET /plano                (PlanoService)
--   v_cola_despacho       → GET /despacho/cola        (DespachoService, KDS)
--   v_cuenta_mesa         → GET /cuentas-por-cobrar   y GET /mesas/:id/cuenta
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
-- ⚠️ Desde el rediseño de comandas múltiples AGREGA sobre N comandas por mesa
-- en vez de traer "la" comanda viva con un LATERAL LIMIT 1 — ese modelo asumía
-- el índice único `comanda_mesa_activa_unica`, que ya no existe. La mesa está
-- ocupada ⟺ tiene al menos una comanda viva, y su cuenta es la suma de todas.
-- El LATERAL con agregados devuelve siempre exactamente una fila (0 comandas
-- cuando la mesa está libre), así que el CASE mira el contador, no un NULL.
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

    cta."comandas",
    cta."comandas_en_cocina",
    cta."comandas_por_cobrar",
    cta."cuenta_total",
    -- Desde cuándo está tomada la mesa: el primer pedido, o —si todavía no
    -- pidieron nada— el momento en que se sentó la reserva.
    coalesce(cta."primera_comanda_en", sent."sentada_en") AS "ocupada_desde",
    cta."comensales",
    cta."mesero_id",

    rsv."id"             AS "reservacion_id",
    rsv."inicia_en"      AS "reservacion_inicia_en",
    rsv."cliente_nombre" AS "reservacion_cliente",
    rsv."personas"       AS "reservacion_personas",

    -- La reserva que YA está sentada en esta mesa (distinta de `reservacion_id`,
    -- que es la próxima que llega). Sirve para rotular "Mesa ocupada · Juan".
    sent."id"             AS "sentada_reservacion_id",
    sent."cliente_nombre" AS "sentada_cliente",
    sent."sentada_en",

    CASE
      WHEN pm."bloqueada"        THEN 'bloqueada'
      WHEN cta."comandas" > 0    THEN 'ocupada'
      -- ⭐ La reserva sentada TAMBIÉN ocupa, aunque todavía no haya pedido.
      -- El cliente escaneó su QR y se sentó: la mesa está tomada desde ese
      -- instante, no desde que el mesero toma la nota. Sin esta rama, el
      -- check-in pinta la mesa ocupada de forma optimista y el siguiente
      -- refresco del plano la devolvía a 'libre'.
      WHEN sent."id" IS NOT NULL THEN 'ocupada'
      WHEN rsv."id" IS NOT NULL  THEN 'reservada'
      ELSE 'libre'
    END AS "estado"
FROM "plantilla_mesa" pm
JOIN "plantilla" pl
  ON pl."restaurante_id" = pm."restaurante_id" AND pl."id" = pm."plantilla_id"
JOIN "mesa" m
  ON m."restaurante_id" = pm."restaurante_id" AND m."id" = pm."mesa_id"
-- La cuenta viva de la mesa: TODA comanda no cobrada y no anulada, esté en
-- cocina o esperando pago. Usa `comanda_cuenta_abierta_idx`.
LEFT JOIN LATERAL (
    SELECT count(*)::int                                                  AS "comandas",
           count(*) FILTER (WHERE c."despachada_en" IS NULL)::int         AS "comandas_en_cocina",
           count(*) FILTER (WHERE c."despachada_en" IS NOT NULL)::int     AS "comandas_por_cobrar",
           coalesce(sum(c."total"), 0)                                    AS "cuenta_total",
           min(c."creada_en")                                             AS "primera_comanda_en",
           -- La mesa tiene UN número de comensales; si creció durante la
           -- noche, manda el mayor. Regla escrita una sola vez, aquí.
           coalesce(max(c."comensales"), 0)                               AS "comensales",
           (array_agg(c."mesero_id" ORDER BY c."creada_en"))[1]           AS "mesero_id"
      FROM "comanda" c
     WHERE c."restaurante_id" = pm."restaurante_id"
       AND c."mesa_id"        = pm."mesa_id"
       AND c."cobro_id"   IS NULL
       AND c."anulada_en" IS NULL
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
-- ⭐ La reserva SENTADA. Va aparte de `rsv` a propósito: aquella son las que
-- todavía no llegaron (y por eso lleva ventana de tiempo), ésta es gente que ya
-- está en la mesa. Sin ventana: una comida se alarga más de dos horas y la mesa
-- no puede "liberarse sola" mientras siguen ahí. Se cierra al cobrar, o
-- explícitamente con cancelar / no-show.
LEFT JOIN LATERAL (
    SELECT r."id", r."cliente_nombre", r."sentada_en"
      FROM "reservacion" r
     WHERE r."restaurante_id" = pm."restaurante_id"
       AND r."mesa_id"        = pm."mesa_id"
       AND r."estado"         = 'sentada'
     ORDER BY r."sentada_en" DESC NULLS LAST
     LIMIT 1
) sent ON TRUE
WHERE pl."eliminada_en" IS NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- v_cola_despacho · LA cola de cocina (KDS)
--
-- Global, todas las mesas juntas, estrictamente por orden de llegada. Sustituye
-- a la cola por ítem del modelo viejo: cocina y barra despachan la comanda como
-- una sola unidad, así que la fila es la comanda y las líneas van embebidas.
--
-- El jsonb no es decorativo: es la consulta que el KDS repite cada pocos
-- segundos, y pedir los ítems aparte sería un N+1 contra la tabla más grande
-- del sistema. Lee `comanda_cola_despacho_idx`, que ya viene ordenado.
--
-- ⚠️ Los ítems cancelados VIENEN en el jsonb, marcados con `cancelado: true`,
-- en vez de filtrarse: la cocina tiene que ver que algo se anuló si ya lo había
-- empezado. Quien sume dinero usa `comanda.total`, que sólo cuenta los vivos.
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
    it."items"
FROM "comanda" c
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
-- v_cuenta_mesa · "cuentas por cobrar" y la ficha de la mesa ocupada
--
-- Una fila por mesa con cuenta viva. El menú de cuentas por cobrar filtra
-- `comandas_por_cobrar > 0`; la ficha de una mesa filtra por `mesa_id`.
--
-- Se llama v_cuenta_mesa y no v_cuenta_por_cobrar porque también contiene lo
-- que todavía está en cocina — y esa cifra es justo la que el cajero necesita
-- ver antes de cerrar la cuenta: cobrar deja lo pendiente en cocina y le abre
-- a la mesa una cuenta nueva.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_cuenta_mesa" WITH (security_invoker = true) AS
SELECT
    c."restaurante_id",
    c."mesa_id",
    m."etiqueta"  AS "mesa_etiqueta",
    c."salon_id",
    s."nombre"    AS "salon_nombre",
    count(*)::int                                                      AS "comandas",
    count(*) FILTER (WHERE c."despachada_en" IS NOT NULL)::int         AS "comandas_por_cobrar",
    count(*) FILTER (WHERE c."despachada_en" IS NULL)::int             AS "comandas_en_cocina",
    sum(c."total")                                                     AS "cuenta_total",
    coalesce(sum(c."total") FILTER (WHERE c."despachada_en" IS NOT NULL), 0) AS "total_por_cobrar",
    coalesce(sum(c."total") FILTER (WHERE c."despachada_en" IS NULL), 0)     AS "total_en_cocina",
    max(c."comensales")                                                AS "comensales",
    min(c."creada_en")                                                 AS "ocupada_desde",
    round(extract(epoch FROM (now() - min(c."creada_en"))) / 60)::int  AS "minutos_ocupada",
    (array_agg(c."mesero_id" ORDER BY c."creada_en"))[1]               AS "mesero_id",
    (array_agg(c."reservacion_id" ORDER BY c."creada_en")
       FILTER (WHERE c."reservacion_id" IS NOT NULL))[1]               AS "reservacion_id"
FROM "comanda" c
JOIN "mesa"  m ON m."restaurante_id" = c."restaurante_id" AND m."id" = c."mesa_id"
LEFT JOIN "salon" s ON s."restaurante_id" = c."restaurante_id" AND s."id" = c."salon_id"
WHERE c."mesa_id"    IS NOT NULL
  AND c."cobro_id"   IS NULL
  AND c."anulada_en" IS NULL
GROUP BY c."restaurante_id", c."mesa_id", m."etiqueta", c."salon_id", s."nombre";


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
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_venta_dia_metodo" WITH (security_invoker = true) AS
SELECT
    cb."restaurante_id",
    cb."fecha_operativa",
    p."metodo",
    p."moneda",
    count(*)           AS "pagos",
    sum(p."monto")     AS "monto_moneda",
    sum(p."monto_usd") AS "monto_usd"
FROM "cobro_pago" p
JOIN "cobro" cb
  ON cb."restaurante_id" = p."restaurante_id" AND cb."id" = p."cobro_id"
WHERE cb."anulado_en" IS NULL
GROUP BY cb."restaurante_id", cb."fecha_operativa", p."metodo", p."moneda";


-- ───────────────────────────────────────────────────────────────────────────
-- v_producto_vendido_dia · base del "producto más vendido"
--
-- Una fila por producto y día. El ranking se saca encima con ORDER BY:
--   · por cantidad → ORDER BY cantidad DESC
--   · por ingreso  → ORDER BY ingreso_usd DESC
-- (son respuestas distintas: la empanada gana por unidades, el solomo por
-- ingreso; por eso la vista devuelve las dos y no decide por el negocio).
-- Los ítems cancelados no cuentan: se pidieron, no se vendieron.
--
-- El día y el turno salen del COBRO, igual que v_venta_dia. Si uno usara la
-- fecha de la comanda y el otro la del cobro, la suma de los productos de un
-- día dejaría de dar la venta de ese día en las noches que cruzan la hora de
-- corte.
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
JOIN "comanda" c
  ON c."restaurante_id" = ci."restaurante_id" AND c."id" = ci."comanda_id"
JOIN "cobro" cb
  ON cb."restaurante_id" = c."restaurante_id" AND cb."id" = c."cobro_id"
WHERE cb."anulado_en"  IS NULL
  AND ci."cancelado_en" IS NULL
GROUP BY cb."restaurante_id", cb."fecha_operativa", cb."turno",
         ci."producto_id", ci."nombre_snap";


-- ───────────────────────────────────────────────────────────────────────────
-- v_cobro_descuadre · auditoría de caja  (antes v_comanda_descuadre)
--
-- Cobros donde la suma de los pagos no coincide con el total. No se puede
-- expresar como CHECK (cruza dos tablas) y no debería ocurrir nunca: si aparece
-- una fila aquí, hay un bug de cobro o un cobro a medias.
-- Consultarla en el cierre de caja. Debe dar 0 filas siempre.
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
