-- ═══════════════════════════════════════════════════════════════════════════
-- BORRADO LÓGICO DE PLANTILLA
--
-- Autor: J.O.R.B.I (data-engineer) · 2026-09-15
--
-- QUÉ CAMBIA
--   · `plantilla.eliminada_en` (nullable). `DELETE /plantillas/:id` deja de
--     ser un DELETE físico: es un `UPDATE ... SET eliminada_en = now()`.
--   · Antes, una plantilla con reservaciones/comandas históricas, o que
--     alguna vez fue clonada, no se podía borrar: las FK RESTRICT hacia
--     `comanda`/`reservacion`/`plantilla.clonada_de_id` lo impedían con un
--     422. Ahora se preserva el histórico (incluida `plantilla_mesa`, que NO
--     se toca) y sólo se marca la plantilla como borrada.
--   · CHECK nuevo `plantilla_eliminada_no_activa`: una plantilla borrada
--     nunca puede ser la activa del salón. Cierra la puerta trasera de
--     reactivar una plantilla borrada con un UPDATE directo a "activa" que
--     se salte `PlantillasService`.
--   · `v_mesa_estado` deja de mostrar mesas de plantillas borradas.
--     `v_reservacion_huerfana` NO se toca: sólo mira la plantilla `activa`,
--     y el CHECK de arriba ya garantiza que una plantilla borrada nunca lo es.
--
-- Se omitió a propósito un `ALTER TABLE "restaurante" ALTER COLUMN
-- "hora_corte_dia" SET DEFAULT '05:00'::time` que el diff de Prisma emite en
-- cada corrida: es ruido idempotente de `dbgenerated()`, no pertenece a este
-- cambio y mezclarlo aquí haría ilegible la migración.
--
-- ⚠️ INVENTARIO DE DDL A MANO QUE VIVE EN ESTE ARCHIVO
--    (copiado de prisma/sql/01_constraints_y_triggers.sql §5 y
--     prisma/sql/02_vistas.sql — esos son la fuente canónica; si se editan
--     allí, se editan aquí)
--      · CHECK `plantilla_eliminada_no_activa` sobre `plantilla`
--      · vista `v_mesa_estado` (WHERE nuevo al final, sin tocar columnas)
--    Prisma no modela CHECKs a mano ni vistas: sobreviven solos al diff.
--    `npm run db:verify` falla si alguno desaparece.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1 · Lo generado por Prisma
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE "plantilla" ADD COLUMN "eliminada_en" TIMESTAMPTZ(6);


-- ───────────────────────────────────────────────────────────────────────────
-- 2 · DDL a mano — prisma/sql/01_constraints_y_triggers.sql §5
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE "plantilla"
  ADD CONSTRAINT "plantilla_eliminada_no_activa"
  CHECK ("eliminada_en" IS NULL OR NOT "activa");


-- ───────────────────────────────────────────────────────────────────────────
-- 3 · DDL a mano — prisma/sql/02_vistas.sql (v_mesa_estado)
--
-- `CREATE OR REPLACE VIEW` es válido aquí: no cambia columnas ni tipos, sólo
-- agrega un filtro al final.
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
