-- ═══════════════════════════════════════════════════════════════════════════
-- CLIENTE COMO UNIDAD DE COBRO + FACTURACIÓN POR LÍNEAS + CORRECCIONES AUDITADAS
--
-- Diseño: J.O.R.B.I (data-engineer), 2026-11-05. Justificación completa y
-- contrato para el backend en docs/DECISIONES-DATOS.md §15.
-- Requiere la migración anterior (20261105120000), que añade el valor de enum
-- 'cobrada_parcial': un valor nuevo no se puede usar en la misma transacción.
--
-- Qué cambia, en una línea cada cosa:
--   · `cliente`          tabla nueva: la visita / cuenta. Mesa opcional.
--   · `comanda.cliente_id`      NOT NULL: para quién se pidió.
--   · `comanda_item.cliente_id` NOT NULL: quién DEBE la línea.
--   · `comanda_item.cobro_id`   la factura pasa de la comanda a la LÍNEA.
--   · `comanda.cobro_id`        DESAPARECE (y con ella `comanda_cuenta_abierta_idx`).
--   · `cobro.cliente_id`        NOT NULL: a quién se le cobró.
--   · `cobro_pago.fecha_operativa`  el día en que se movió el dinero.
--   · `bitacora`         tabla nueva, la escriben triggers.
--   · comanda.total y comanda.estado pasan a derivarse de las líneas.
--   · la factura se verifica entera al COMMIT; se corrige cualquier día (con
--     bitácora) sin cambiar nunca su día ni su número.
--
-- ⚠️ ESTA MIGRACIÓN NO ES LA QUE GENERA PRISMA. El diff de `prisma migrate
-- diff` proponía `ADD COLUMN cliente_id UUID NOT NULL` sobre tablas con filas
-- (revienta) y `DROP COLUMN comanda.cobro_id` sin trasladar la factura a las
-- líneas (perdería qué se cobró en cada factura). De él se tomaron los NOMBRES
-- exactos de índices y FKs, para que la próxima migración no vea deriva.
-- Lo único del diff que se omite a propósito es
-- `ALTER TABLE restaurante ALTER COLUMN hora_corte_dia SET DEFAULT '05:00'::time`:
-- es ruido preexistente de `dbgenerated` y no cambia nada.
--
-- Orden obligatorio:
--   0 · Aserciones previas
--   1 · Fuera vistas y triggers que se rehacen (ANTES de cualquier UPDATE: un
--       trigger diferido con eventos pendientes impide el ALTER TABLE)
--   2 · Tablas y columnas nuevas (nullable hasta el backfill)
--   3 · Backfill: clientes para TODO el histórico y para lo vivo
--   4 · NOT NULL, y fuera `comanda.cobro_id`
--   5 · Índices, FKs y CHECKs
--   6 · Funciones y triggers inmediatos
--   7 · Recalcular `comanda.total` / `comanda.estado` con el trigger nuevo
--   8 · Vistas
--   9 · Triggers diferidos y de bitácora (al final: no deben ver el backfill)
--
-- Correr con el local CERRADO es lo ideal (lo vivo se agrupa por mesa en un
-- cliente que se llama como el primer nombre que dio el mesero, la reserva o
-- "Mesa N"). Abierto también funciona; ver §3.2.
--
-- Una sola transacción, sin BEGIN/COMMIT propios (igual que 20260915183000):
-- `prisma migrate deploy` ya la envuelve. A mano:
--   ( echo 'BEGIN;'; cat migration.sql; echo 'COMMIT;' ) | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 0 · Aserciones previas
-- ───────────────────────────────────────────────────────────────────────────

-- 0.1 · El backfill traslada `comanda.cobro_id` a sus líneas. Una comanda
-- cobrada SIN líneas dejaría su factura sin nada que la cubra; con el
-- constraint trigger nuevo esa factura no se podría volver a tocar nunca.
-- Sólo se avisa: el histórico no se reescribe.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "comanda" c
   WHERE c."cobro_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "comanda_item" i WHERE i."comanda_id" = c."id");
  IF n > 0 THEN
    RAISE NOTICE '% comanda(s) cobradas no tienen líneas: sus facturas quedan como histórico intocable', n;
  END IF;
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 1 · Fuera lo que se rehace
-- ───────────────────────────────────────────────────────────────────────────

-- Vistas que leen `comanda.cobro_id` (bloquean el DROP COLUMN) o cambian de
-- columnas. `v_cuenta_mesa` NO vuelve: la sustituye `v_cuenta_cliente`.
DROP VIEW IF EXISTS "v_mesa_estado";
DROP VIEW IF EXISTS "v_cuenta_mesa";
DROP VIEW IF EXISTS "v_producto_vendido_dia";
DROP VIEW IF EXISTS "v_venta_dia_metodo";

-- El constraint trigger diferido se va PRIMERO: el backfill hace UPDATE sobre
-- `cobro`, y con el trigger vivo cada fila dejaría un evento pendiente que
-- (a) prohíbe los ALTER TABLE siguientes y (b) verificaría todo el histórico
-- al COMMIT con las reglas nuevas.
DROP TRIGGER IF EXISTS "cobro_no_vacio" ON "cobro";
DROP FUNCTION IF EXISTS "hayai_cobro_no_vacio"();

-- Sustituido por `comanda_item_editable` (§6.3): ya se pueden tocar líneas de
-- comandas despachadas y cobradas. Además rechazaría el backfill de §3.
DROP TRIGGER IF EXISTS "comanda_item_solo_pendiente" ON "comanda_item";
DROP FUNCTION IF EXISTS "hayai_comanda_item_solo_pendiente"();

-- Se reinstala con otro cuerpo en §6.2 (deriva también `total`).
DROP TRIGGER IF EXISTS "comanda_estado" ON "comanda";


-- ───────────────────────────────────────────────────────────────────────────
-- 2 · Tablas y columnas nuevas
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE "cliente" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "mesa_id" UUID,
    "reservacion_id" UUID,
    "fecha_operativa" DATE NOT NULL,
    "creado_por_id" UUID,
    "cerrado_en" TIMESTAMPTZ(6),
    "cerrado_por_id" UUID,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cliente_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bitacora" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "restaurante_id" UUID NOT NULL,
    "tabla" TEXT NOT NULL,
    "entidad_id" UUID NOT NULL,
    "operacion" TEXT NOT NULL,
    "cambios" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "antes" JSONB,
    "despues" JSONB,
    "usuario_id" UUID NOT NULL,
    "motivo" TEXT,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "bitacora_pkey" PRIMARY KEY ("id")
);

-- Nullable hasta que el backfill las llene (§4 las pasa a NOT NULL).
ALTER TABLE "comanda"      ADD COLUMN "cliente_id" UUID;
ALTER TABLE "comanda_item" ADD COLUMN "cliente_id" UUID,
                           ADD COLUMN "cobro_id"   UUID;
ALTER TABLE "cobro"        ADD COLUMN "cliente_id" UUID;
ALTER TABLE "cobro_pago"   ADD COLUMN "fecha_operativa" DATE;


-- ───────────────────────────────────────────────────────────────────────────
-- 3 · Backfill
--
-- TODA comanda queda con cliente, también el histórico: una comanda cobrada
-- puede recibir hoy una corrección (§15.2) y esa deuda necesita dueño. Reglas:
--   3.1 una factura = un cliente CERRADO (al cobrar), con sus comandas;
--   3.2 lo vivo con mesa = un cliente ABIERTO por mesa, sentado en ella;
--   3.3 lo vivo sin mesa (para llevar) = un cliente abierto por comanda;
--   3.4 reserva `sentada` sin cliente = un cliente abierto sentado (antes la
--       reserva ocupaba la mesa por sí sola en `v_mesa_estado`; ahora ocupa
--       el cliente, y la mesa no puede "liberarse" por la migración);
--   3.5 anuladas sin factura: al cliente abierto de su mesa si son del mismo
--       día operativo, si no un cliente cerrado por comanda.
-- Ids con gen_random_uuid() (v4): son filas de migración, no de origen.
-- El nombre pasa siempre por btrim/nullif: `cliente_nombre_normalizado`.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE "_cliente_de_comanda" (
  "comanda_id" uuid PRIMARY KEY,
  "cliente_id" uuid NOT NULL
) ON COMMIT DROP;

-- 3.1 · Un cliente cerrado por factura ─────────────────────────────────────
CREATE TEMP TABLE "_cliente_de_cobro" ON COMMIT DROP AS
SELECT cb."id" AS "cobro_id", gen_random_uuid() AS "cliente_id" FROM "cobro" cb;

INSERT INTO "cliente" ("id", "restaurante_id", "nombre", "mesa_id", "reservacion_id", "fecha_operativa",
                       "creado_por_id", "cerrado_en", "cerrado_por_id", "creado_en", "actualizado_en")
SELECT x."cliente_id", cb."restaurante_id",
       coalesce(cb."cliente_nombre", a."nombre", nullif(btrim(r."cliente_nombre"), ''),
                'Mesa ' || nullif(btrim(me."etiqueta"), ''), 'Factura #' || cb."numero_dia"),
       cb."mesa_id", a."reservacion_id",
       coalesce(a."fecha_operativa", cb."fecha_operativa"),
       a."mesero_id", cb."cobrado_en", cb."cobrado_por_id",
       coalesce(a."creada_en", cb."cobrado_en"), now()
  FROM "_cliente_de_cobro" x
  JOIN "cobro" cb ON cb."id" = x."cobro_id"
  LEFT JOIN (
        SELECT c."cobro_id",
               min(c."fecha_operativa") AS "fecha_operativa",
               min(c."creada_en")       AS "creada_en",
               (array_agg(c."mesero_id" ORDER BY c."creada_en"))[1] AS "mesero_id",
               (array_agg(c."cliente_nombre" ORDER BY c."creada_en")
                  FILTER (WHERE c."cliente_nombre" IS NOT NULL))[1] AS "nombre",
               (array_agg(c."reservacion_id" ORDER BY c."creada_en")
                  FILTER (WHERE c."reservacion_id" IS NOT NULL))[1] AS "reservacion_id"
          FROM "comanda" c
         WHERE c."cobro_id" IS NOT NULL
         GROUP BY c."cobro_id"
       ) a ON a."cobro_id" = cb."id"
  LEFT JOIN "reservacion" r ON r."restaurante_id" = cb."restaurante_id" AND r."id" = a."reservacion_id"
  LEFT JOIN "mesa" me       ON me."restaurante_id" = cb."restaurante_id" AND me."id" = cb."mesa_id";

INSERT INTO "_cliente_de_comanda"
SELECT c."id", x."cliente_id"
  FROM "comanda" c JOIN "_cliente_de_cobro" x ON x."cobro_id" = c."cobro_id";

UPDATE "cobro" cb SET "cliente_id" = x."cliente_id"
  FROM "_cliente_de_cobro" x WHERE x."cobro_id" = cb."id";

-- 3.2 · Un cliente abierto por mesa con comandas vivas ─────────────────────
-- Si a esa hora hay en una mesa dos grupos que pidieron por separado, quedan
-- como UN cliente: la base no tiene forma de saberlo. Se separan después
-- reasignando líneas (§15.4). Con el local cerrado no hay ninguno.
CREATE TEMP TABLE "_cliente_de_mesa" ON COMMIT DROP AS
SELECT c."restaurante_id", c."mesa_id", gen_random_uuid() AS "cliente_id",
       min(c."fecha_operativa") AS "fecha_operativa",
       min(c."creada_en")       AS "creada_en",
       (array_agg(c."mesero_id" ORDER BY c."creada_en"))[1] AS "mesero_id",
       (array_agg(c."cliente_nombre" ORDER BY c."creada_en")
          FILTER (WHERE c."cliente_nombre" IS NOT NULL))[1] AS "nombre",
       (array_agg(c."reservacion_id" ORDER BY c."creada_en")
          FILTER (WHERE c."reservacion_id" IS NOT NULL))[1] AS "reservacion_id"
  FROM "comanda" c
 WHERE c."cobro_id" IS NULL AND c."anulada_en" IS NULL AND c."mesa_id" IS NOT NULL
 GROUP BY c."restaurante_id", c."mesa_id";

-- Sin reserva en sus comandas: la reserva `sentada` de esa mesa, si la hay.
UPDATE "_cliente_de_mesa" t
   SET "reservacion_id" = (SELECT r."id" FROM "reservacion" r
                            WHERE r."restaurante_id" = t."restaurante_id"
                              AND r."mesa_id" = t."mesa_id" AND r."estado" = 'sentada'
                            ORDER BY r."sentada_en" DESC NULLS LAST LIMIT 1)
 WHERE t."reservacion_id" IS NULL;

-- Una reserva, a lo sumo un cliente abierto (`cliente_reservacion_abierta_unica`):
-- si sus comandas acabaron en dos mesas, se la queda el cliente más antiguo.
UPDATE "_cliente_de_mesa" t SET "reservacion_id" = NULL
 WHERE t."reservacion_id" IS NOT NULL
   AND EXISTS (SELECT 1 FROM "_cliente_de_mesa" o
                WHERE o."restaurante_id" = t."restaurante_id"
                  AND o."reservacion_id" = t."reservacion_id"
                  AND (o."creada_en", o."cliente_id") < (t."creada_en", t."cliente_id"));

INSERT INTO "cliente" ("id", "restaurante_id", "nombre", "mesa_id", "reservacion_id", "fecha_operativa",
                       "creado_por_id", "creado_en", "actualizado_en")
SELECT t."cliente_id", t."restaurante_id",
       coalesce(t."nombre", nullif(btrim(r."cliente_nombre"), ''), 'Mesa ' || btrim(m."etiqueta")),
       t."mesa_id", t."reservacion_id", t."fecha_operativa", t."mesero_id", t."creada_en", now()
  FROM "_cliente_de_mesa" t
  JOIN "mesa" m             ON m."restaurante_id" = t."restaurante_id" AND m."id" = t."mesa_id"
  LEFT JOIN "reservacion" r ON r."restaurante_id" = t."restaurante_id" AND r."id" = t."reservacion_id";

INSERT INTO "_cliente_de_comanda"
SELECT c."id", t."cliente_id"
  FROM "comanda" c
  JOIN "_cliente_de_mesa" t ON t."restaurante_id" = c."restaurante_id" AND t."mesa_id" = c."mesa_id"
 WHERE c."cobro_id" IS NULL AND c."anulada_en" IS NULL;

-- 3.3 · Lo vivo sin mesa: un cliente abierto por comanda ───────────────────
CREATE TEMP TABLE "_cliente_suelto" ON COMMIT DROP AS
SELECT c."id" AS "comanda_id", gen_random_uuid() AS "cliente_id"
  FROM "comanda" c
 WHERE c."cobro_id" IS NULL AND c."anulada_en" IS NULL AND c."mesa_id" IS NULL;

INSERT INTO "cliente" ("id", "restaurante_id", "nombre", "fecha_operativa", "creado_por_id",
                       "creado_en", "actualizado_en")
SELECT x."cliente_id", c."restaurante_id",
       coalesce(c."cliente_nombre", 'Para llevar #' || c."numero_dia"),
       c."fecha_operativa", c."mesero_id", c."creada_en", now()
  FROM "_cliente_suelto" x JOIN "comanda" c ON c."id" = x."comanda_id";

INSERT INTO "_cliente_de_comanda" SELECT "comanda_id", "cliente_id" FROM "_cliente_suelto";

-- 3.4 · Reservas sentadas que todavía no tienen cliente ────────────────────
INSERT INTO "cliente" ("id", "restaurante_id", "nombre", "mesa_id", "reservacion_id", "fecha_operativa",
                       "creado_por_id", "creado_en", "actualizado_en")
SELECT gen_random_uuid(), r."restaurante_id",
       coalesce(nullif(btrim(r."cliente_nombre"), ''), 'Reserva ' || btrim(r."codigo_corto")),
       r."mesa_id", r."id",
       "hayai_fecha_operativa"(coalesce(r."sentada_en", r."inicia_en"), rs."zona_horaria", rs."hora_corte_dia"),
       r."creada_por_id", coalesce(r."sentada_en", r."inicia_en"), now()
  FROM "reservacion" r
  JOIN "restaurante" rs ON rs."id" = r."restaurante_id"
 WHERE r."estado" = 'sentada'
   AND NOT EXISTS (SELECT 1 FROM "cliente" k
                    WHERE k."restaurante_id" = r."restaurante_id"
                      AND k."reservacion_id" = r."id" AND k."cerrado_en" IS NULL);

-- 3.5 · Anuladas sin factura ───────────────────────────────────────────────
INSERT INTO "_cliente_de_comanda"
SELECT c."id", t."cliente_id"
  FROM "comanda" c
  JOIN "_cliente_de_mesa" t ON t."restaurante_id" = c."restaurante_id" AND t."mesa_id" = c."mesa_id"
 WHERE c."anulada_en" IS NOT NULL AND c."cobro_id" IS NULL
   AND c."fecha_operativa" = t."fecha_operativa";

CREATE TEMP TABLE "_cliente_anulada" ON COMMIT DROP AS
SELECT c."id" AS "comanda_id", gen_random_uuid() AS "cliente_id"
  FROM "comanda" c
 WHERE NOT EXISTS (SELECT 1 FROM "_cliente_de_comanda" x WHERE x."comanda_id" = c."id");

INSERT INTO "cliente" ("id", "restaurante_id", "nombre", "mesa_id", "fecha_operativa", "creado_por_id",
                       "cerrado_en", "cerrado_por_id", "creado_en", "actualizado_en")
SELECT x."cliente_id", c."restaurante_id",
       coalesce(c."cliente_nombre", 'Mesa ' || nullif(btrim(m."etiqueta"), ''), 'Comanda #' || c."numero_dia"),
       c."mesa_id", c."fecha_operativa", c."mesero_id",
       -- Una comanda que no es viva ni cobrada sólo puede estar anulada; el
       -- coalesce es por si acaso, para no dejar un cliente abierto fantasma.
       coalesce(c."anulada_en", c."creada_en"), c."anulada_por_id", c."creada_en", now()
  FROM "_cliente_anulada" x
  JOIN "comanda" c    ON c."id" = x."comanda_id"
  LEFT JOIN "mesa" m  ON m."restaurante_id" = c."restaurante_id" AND m."id" = c."mesa_id";

INSERT INTO "_cliente_de_comanda" SELECT "comanda_id", "cliente_id" FROM "_cliente_anulada";

-- 3.6 · Aplicar ────────────────────────────────────────────────────────────
UPDATE "comanda" c SET "cliente_id" = x."cliente_id"
  FROM "_cliente_de_comanda" x WHERE x."comanda_id" = c."id";

-- La factura baja de la comanda a TODAS sus líneas, también a las que se
-- cancelaron antes de cobrar: es lo que la reimpresión mostraba hasta hoy (la
-- factura listaba sus comandas con todas sus líneas). Las canceladas no suman.
UPDATE "comanda_item" ci
   SET "cliente_id" = c."cliente_id",
       "cobro_id"   = c."cobro_id"
  FROM "comanda" c
 WHERE c."restaurante_id" = ci."restaurante_id" AND c."id" = ci."comanda_id";

-- El día de cada movimiento de caja: el de su factura (todo lo histórico se
-- registró en la misma transacción que la factura). Así `v_venta_dia_metodo`
-- devuelve exactamente lo mismo que antes para los días ya cerrados.
UPDATE "cobro_pago" p SET "fecha_operativa" = cb."fecha_operativa"
  FROM "cobro" cb WHERE cb."restaurante_id" = p."restaurante_id" AND cb."id" = p."cobro_id";

-- 3.7 · Nada sin dueño ─────────────────────────────────────────────────────
DO $$
DECLARE a bigint; b bigint; c bigint; d bigint;
BEGIN
  SELECT count(*) INTO a FROM "comanda"      WHERE "cliente_id" IS NULL;
  SELECT count(*) INTO b FROM "comanda_item" WHERE "cliente_id" IS NULL;
  SELECT count(*) INTO c FROM "cobro"        WHERE "cliente_id" IS NULL;
  SELECT count(*) INTO d FROM "cobro_pago"   WHERE "fecha_operativa" IS NULL;
  IF a + b + c + d > 0 THEN
    RAISE EXCEPTION 'Backfill incompleto: % comanda(s), % línea(s), % cobro(s) sin cliente, % pago(s) sin día', a, b, c, d;
  END IF;
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 4 · NOT NULL, y fuera `comanda.cobro_id`
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE "comanda"      ALTER COLUMN "cliente_id" SET NOT NULL;
ALTER TABLE "comanda_item" ALTER COLUMN "cliente_id" SET NOT NULL;
ALTER TABLE "cobro"        ALTER COLUMN "cliente_id" SET NOT NULL;
ALTER TABLE "cobro_pago"   ALTER COLUMN "fecha_operativa" SET NOT NULL,
                           ALTER COLUMN "fecha_operativa" SET DEFAULT CURRENT_DATE;

-- Las dos reglas que vivían como CHECK sobre `comanda.cobro_id` pasan a los
-- triggers de §6 CON EL MISMO NOMBRE de constraint en el error, para que
-- `pg-error.filter.ts` las siga traduciendo igual.
ALTER TABLE "comanda"
  DROP CONSTRAINT IF EXISTS "comanda_anulada_no_cobrada",
  DROP CONSTRAINT IF EXISTS "comanda_cobro_tras_despacho",
  DROP CONSTRAINT IF EXISTS "comanda_restaurante_id_cobro_id_fkey";
DROP INDEX IF EXISTS "comanda_cobro_idx";
-- Parcial, escrito a mano: Prisma no lo ve. Su sucesor es `comanda_item_deuda_idx`.
DROP INDEX IF EXISTS "comanda_cuenta_abierta_idx";
ALTER TABLE "comanda" DROP COLUMN "cobro_id";


-- ───────────────────────────────────────────────────────────────────────────
-- 5 · Índices, FKs y CHECKs
-- ───────────────────────────────────────────────────────────────────────────

-- 5.1 · Los que declara schema.prisma (nombres del diff generado) ──────────
CREATE UNIQUE INDEX "cliente_restaurante_id_key" ON "cliente"("restaurante_id", "id");
CREATE INDEX "bitacora_entidad_idx" ON "bitacora"("restaurante_id", "entidad_id");
CREATE INDEX "bitacora_fecha_idx" ON "bitacora"("restaurante_id", "creado_en");
CREATE INDEX "cobro_cliente_idx" ON "cobro"("restaurante_id", "cliente_id");
CREATE UNIQUE INDEX "cobro_cliente_key" ON "cobro"("restaurante_id", "id", "cliente_id");
CREATE INDEX "comanda_cliente_idx" ON "comanda"("restaurante_id", "cliente_id");
CREATE INDEX "comanda_item_cobro_idx" ON "comanda_item"("restaurante_id", "cobro_id");
CREATE INDEX "cobro_pago_dia_idx" ON "cobro_pago"("restaurante_id", "fecha_operativa");

ALTER TABLE "cliente" ADD CONSTRAINT "cliente_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_restaurante_id_mesa_id_fkey" FOREIGN KEY ("restaurante_id", "mesa_id") REFERENCES "mesa"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_restaurante_id_reservacion_id_fkey" FOREIGN KEY ("restaurante_id", "reservacion_id") REFERENCES "reservacion"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_restaurante_id_creado_por_id_fkey" FOREIGN KEY ("restaurante_id", "creado_por_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_restaurante_id_cerrado_por_id_fkey" FOREIGN KEY ("restaurante_id", "cerrado_por_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "comanda" ADD CONSTRAINT "comanda_restaurante_id_cliente_id_fkey" FOREIGN KEY ("restaurante_id", "cliente_id") REFERENCES "cliente"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "comanda_item" ADD CONSTRAINT "comanda_item_restaurante_id_cliente_id_fkey" FOREIGN KEY ("restaurante_id", "cliente_id") REFERENCES "cliente"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- ⭐ La línea facturada es del cliente de su factura. MATCH SIMPLE (default):
-- con `cobro_id` NULL no se comprueba nada.
ALTER TABLE "comanda_item" ADD CONSTRAINT "comanda_item_restaurante_id_cobro_id_cliente_id_fkey" FOREIGN KEY ("restaurante_id", "cobro_id", "cliente_id") REFERENCES "cobro"("restaurante_id", "id", "cliente_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "cobro" ADD CONSTRAINT "cobro_restaurante_id_cliente_id_fkey" FOREIGN KEY ("restaurante_id", "cliente_id") REFERENCES "cliente"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bitacora" ADD CONSTRAINT "bitacora_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bitacora" ADD CONSTRAINT "bitacora_restaurante_id_usuario_id_fkey" FOREIGN KEY ("restaurante_id", "usuario_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5.2 · Índices PARCIALES (Prisma no los ve ni los toca) ───────────────────

-- ⭐ La deuda viva: líneas sin factura y sin cancelar, por deudor. Diminuto:
-- sólo lo que está por cobrar AHORA. Sirve a `v_cuenta_cliente`, a
-- `v_mesa_estado` y al cierre del cliente. Sucesor de `comanda_cuenta_abierta_idx`.
-- ponytail: incluye las líneas de comandas ANULADAS (la anulación no toca las
-- líneas y el filtro `comanda.anulada_en` está en otra tabla); crecen al
-- ritmo de las anulaciones, que son pocas. Si algún día pesa, cancelar las
-- líneas al anular la comanda y el índice vuelve a ser exacto.
CREATE INDEX "comanda_item_deuda_idx"
  ON "comanda_item" ("restaurante_id", "cliente_id")
  WHERE "cobro_id" IS NULL AND "cancelado_en" IS NULL;

-- Clientes ABIERTOS por mesa: el plano (¿quién está sentado aquí?) y la
-- pantalla de mesas (con el prefijo restaurante_id, todos los abiertos).
CREATE INDEX "cliente_abierto_idx"
  ON "cliente" ("restaurante_id", "mesa_id")
  WHERE "cerrado_en" IS NULL;

-- Un solo cliente ABIERTO por reserva: el doble toque en "sentar" (o dos
-- pantallas haciendo check-in a la vez) da 23505 en vez de dos cuentas.
CREATE UNIQUE INDEX "cliente_reservacion_abierta_unica"
  ON "cliente" ("restaurante_id", "reservacion_id")
  WHERE "reservacion_id" IS NOT NULL AND "cerrado_en" IS NULL;

-- 5.3 · CHECKs ─────────────────────────────────────────────────────────────
ALTER TABLE "cliente"
  ADD CONSTRAINT "cliente_nombre_normalizado" CHECK (length("nombre") > 0 AND "nombre" = btrim("nombre")),
  ADD CONSTRAINT "cliente_cierre_coherente" CHECK ("cerrado_en" IS NOT NULL OR "cerrado_por_id" IS NULL);

-- Una comanda puede no tener mesa aunque se consuma en el local (cliente sin
-- mesa). Lo que no puede es tener mesa sin salón ni plantilla, ni una para
-- llevar con mesa.
ALTER TABLE "comanda" DROP CONSTRAINT "comanda_tipo_coherente";
ALTER TABLE "comanda" ADD CONSTRAINT "comanda_tipo_coherente" CHECK (
  ("mesa_id" IS NULL OR ("salon_id" IS NOT NULL AND "plantilla_id" IS NOT NULL))
  AND ("tipo" = 'mesa' OR "mesa_id" IS NULL)
);

-- Negativo = devolución. Nunca 0, y los dos montos con el mismo signo.
ALTER TABLE "cobro_pago" DROP CONSTRAINT "cobro_pago_monto_valido";
ALTER TABLE "cobro_pago" ADD CONSTRAINT "cobro_pago_monto_valido" CHECK (
  ("monto" > 0 AND "monto_usd" > 0) OR ("monto" < 0 AND "monto_usd" < 0)
);

-- `total_linea` es lo que suma el subtotal de la factura: no puede mentir.
-- NOT VALID + VALIDATE en un bloque que perdona: si alguna fila histórica no
-- cuadra, la migración NO se cae en pleno deploy; el CHECK queda vigilando las
-- filas nuevas y modificadas, y 99_verificar_objetos.sql avisa (convalidated).
ALTER TABLE "comanda_item" ADD CONSTRAINT "comanda_item_total_coherente"
  CHECK ("total_linea" = round("cantidad" * "precio_unitario_snap" - "descuento_linea", 4)) NOT VALID;
DO $$
BEGIN
  ALTER TABLE "comanda_item" VALIDATE CONSTRAINT "comanda_item_total_coherente";
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'comanda_item_total_coherente queda NOT VALID: hay líneas históricas con total_linea <> cantidad*precio-descuento';
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 6 · Funciones y triggers inmediatos
-- ───────────────────────────────────────────────────────────────────────────

-- 6.2 · `comanda.estado` y `comanda.total`, derivados de las líneas ─────────
CREATE OR REPLACE FUNCTION "hayai_comanda_estado"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_total      numeric;
  v_facturadas int;
  v_por_cobrar int;
BEGIN
  SELECT coalesce(sum(ci."total_linea") FILTER (WHERE ci."cancelado_en" IS NULL), 0),
         count(*) FILTER (WHERE ci."cobro_id" IS NOT NULL),
         count(*) FILTER (WHERE ci."cobro_id" IS NULL AND ci."cancelado_en" IS NULL)
    INTO v_total, v_facturadas, v_por_cobrar
    FROM "comanda_item" ci
   WHERE ci."restaurante_id" = NEW."restaurante_id" AND ci."comanda_id" = NEW."id";

  -- Eran CHECKs sobre `comanda.cobro_id`; ahora cruzan a las líneas.
  IF v_facturadas > 0 AND NEW."anulada_en" IS NOT NULL THEN
    RAISE EXCEPTION 'La comanda % tiene líneas facturadas: desfactúralas antes de anularla', NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'comanda_anulada_no_cobrada';
  END IF;
  IF v_facturadas > 0 AND NEW."despachada_en" IS NULL THEN
    RAISE EXCEPTION 'La comanda % tiene líneas facturadas y no figura como despachada', NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'comanda_cobro_tras_despacho';
  END IF;

  NEW."total"  := v_total;
  NEW."estado" := CASE
    WHEN NEW."anulada_en"    IS NOT NULL THEN 'anulada'
    WHEN NEW."despachada_en" IS NULL     THEN 'pendiente'
    WHEN v_facturadas = 0                THEN 'despachada'
    WHEN v_por_cobrar = 0                THEN 'cobrada'
    ELSE                                      'cobrada_parcial'
  END::"estado_comanda";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "comanda_estado"
  BEFORE INSERT OR UPDATE ON "comanda"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_comanda_estado"();

-- 6.3 · Qué se puede escribir en una línea ─────────────────────────────────
-- Sustituye a `comanda_item_solo_pendiente`. Ya se pueden agregar, cambiar y
-- cancelar líneas de comandas despachadas y cobradas (§15.2); lo que sigue
-- prohibido:
--   · tocar líneas de una comanda ANULADA;
--   · mover una línea a otra comanda (rompería el estado y el total de ambas);
--   · facturar una línea que no salió de cocina, o una ya cancelada;
--   · meter o sacar líneas de una factura ANULADA, o cambiarlas (salvo la nota);
--   · dejar deuda viva a un cliente CERRADO (cerrar y anotar a la vez se
--     serializa con FOR SHARE: ver `hayai_cliente_cierre`).
-- La regla "la línea facturada es del cliente de su factura" no está aquí: la
-- hace la FK `comanda_item_restaurante_id_cobro_id_cliente_id_fkey`.
-- Sólo INSERT/UPDATE: el DELETE no existe en el producto (cancelar es lógico)
-- y vigilarlo rompería el DELETE en cascada del restaurante.
CREATE OR REPLACE FUNCTION "hayai_comanda_item_editable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_despachada timestamptz;
  v_anulada    timestamptz;
  v_cobro_anul timestamptz;
  v_cerrado    timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."comanda_id" IS DISTINCT FROM OLD."comanda_id" THEN
    RAISE EXCEPTION 'Una línea no cambia de comanda (línea %)', NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'comanda_item_comanda_fija';
  END IF;

  SELECT c."despachada_en", c."anulada_en" INTO v_despachada, v_anulada
    FROM "comanda" c
   WHERE c."restaurante_id" = NEW."restaurante_id" AND c."id" = NEW."comanda_id";
  -- Sin fila: que hable la FK compuesta (23503), cuyo mensaje es el correcto.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_anulada IS NOT NULL THEN
    RAISE EXCEPTION 'La comanda % está anulada: sus líneas ya no se pueden modificar', NEW."comanda_id"
      USING ERRCODE = '23514', CONSTRAINT = 'comanda_item_comanda_anulada';
  END IF;

  -- Entra en una factura (nueva o distinta).
  IF NEW."cobro_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."cobro_id" IS DISTINCT FROM OLD."cobro_id") THEN
    IF v_despachada IS NULL THEN
      RAISE EXCEPTION 'La comanda % sigue en cocina: sus líneas todavía no se facturan', NEW."comanda_id"
        USING ERRCODE = '23514', CONSTRAINT = 'comanda_cobro_tras_despacho';
    END IF;
    IF NEW."cancelado_en" IS NOT NULL THEN
      RAISE EXCEPTION 'La línea % está cancelada: no se factura', NEW."id"
        USING ERRCODE = '23514', CONSTRAINT = 'comanda_item_factura_linea_viva';
    END IF;
    SELECT cb."anulado_en" INTO v_cobro_anul
      FROM "cobro" cb WHERE cb."restaurante_id" = NEW."restaurante_id" AND cb."id" = NEW."cobro_id";
    IF v_cobro_anul IS NOT NULL THEN
      RAISE EXCEPTION 'La factura % está anulada: no admite líneas', NEW."cobro_id"
        USING ERRCODE = '23514', CONSTRAINT = 'cobro_anulado_inmutable';
    END IF;
  END IF;

  -- Una línea de una factura anulada está congelada (salvo la nota).
  IF TG_OP = 'UPDATE' AND OLD."cobro_id" IS NOT NULL
     AND (NEW."cantidad", NEW."precio_unitario_snap", NEW."descuento_linea", NEW."total_linea",
          NEW."cancelado_en", NEW."cliente_id", NEW."cobro_id")
         IS DISTINCT FROM
         (OLD."cantidad", OLD."precio_unitario_snap", OLD."descuento_linea", OLD."total_linea",
          OLD."cancelado_en", OLD."cliente_id", OLD."cobro_id") THEN
    SELECT cb."anulado_en" INTO v_cobro_anul
      FROM "cobro" cb WHERE cb."restaurante_id" = OLD."restaurante_id" AND cb."id" = OLD."cobro_id";
    IF v_cobro_anul IS NOT NULL THEN
      RAISE EXCEPTION 'La línea % pertenece a la factura anulada %: no se modifica', NEW."id", OLD."cobro_id"
        USING ERRCODE = '23514', CONSTRAINT = 'cobro_anulado_inmutable';
    END IF;
  END IF;

  -- Deuda viva ⇒ deudor abierto. FOR SHARE choca con el UPDATE que cierra al
  -- cliente: o este INSERT espera y ve el cierre, o el cierre espera y ve la
  -- línea (y se niega). Sin el lock, los dos pasan y queda un cliente cerrado
  -- con deuda, que es dinero que nadie cobrará.
  IF NEW."cobro_id" IS NULL AND NEW."cancelado_en" IS NULL THEN
    SELECT k."cerrado_en" INTO v_cerrado
      FROM "cliente" k
     WHERE k."restaurante_id" = NEW."restaurante_id" AND k."id" = NEW."cliente_id"
       FOR SHARE;
    IF FOUND AND v_cerrado IS NOT NULL THEN
      RAISE EXCEPTION 'El cliente % está cerrado: reábrelo para anotarle consumo', NEW."cliente_id"
        USING ERRCODE = '23514', CONSTRAINT = 'cliente_cerrado';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "comanda_item_editable"
  BEFORE INSERT OR UPDATE ON "comanda_item"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_comanda_item_editable"();

-- 6.4 · Cada cambio de una línea re-deriva su comanda ──────────────────────
-- `UPDATE comanda SET total = total` no escribe nada útil: dispara
-- `comanda_estado`, que recalcula total y estado desde las líneas. Sólo cuando
-- cambió algo que los afecta (una nota no).
CREATE OR REPLACE FUNCTION "hayai_comanda_item_derivar"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "comanda" SET "total" = "total"
     WHERE "restaurante_id" = OLD."restaurante_id" AND "id" = OLD."comanda_id";
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW."total_linea"  IS NOT DISTINCT FROM OLD."total_linea"
     AND NEW."cancelado_en" IS NOT DISTINCT FROM OLD."cancelado_en"
     AND NEW."cobro_id"     IS NOT DISTINCT FROM OLD."cobro_id" THEN
    RETURN NULL;
  END IF;

  UPDATE "comanda" SET "total" = "total"
   WHERE "restaurante_id" = NEW."restaurante_id" AND "id" = NEW."comanda_id";
  RETURN NULL;
END;
$$;

CREATE TRIGGER "comanda_item_derivar"
  AFTER INSERT OR UPDATE OR DELETE ON "comanda_item"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_comanda_item_derivar"();

-- 6.5 · Un cliente no se cierra con deuda ──────────────────────────────────
-- Deuda = líneas vivas sin factura que él DEBE, en comandas no anuladas. Lo
-- que esté en cocina cuenta: si se va, alguien tiene que pagarlo o cancelarlo.
CREATE OR REPLACE FUNCTION "hayai_cliente_cierre"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_lineas int;
  v_monto  numeric;
BEGIN
  IF NEW."cerrado_en" IS NOT NULL AND OLD."cerrado_en" IS NULL THEN
    SELECT count(*), coalesce(sum(ci."total_linea"), 0) INTO v_lineas, v_monto
      FROM "comanda_item" ci
      JOIN "comanda" c ON c."restaurante_id" = ci."restaurante_id" AND c."id" = ci."comanda_id"
     WHERE ci."restaurante_id" = NEW."restaurante_id"
       AND ci."cliente_id"     = NEW."id"
       AND ci."cobro_id"     IS NULL
       AND ci."cancelado_en" IS NULL
       AND c."anulada_en"    IS NULL;
    IF v_lineas > 0 THEN
      RAISE EXCEPTION 'El cliente % debe % línea(s) por % USD: factúralas, reasígnalas o cancélalas antes de cerrarlo',
        NEW."nombre", v_lineas, v_monto
        USING ERRCODE = '23514', CONSTRAINT = 'cliente_cierre_sin_deuda';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "cliente_cierre_sin_deuda"
  BEFORE UPDATE ON "cliente"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_cliente_cierre"();

-- 6.6 · Lo que una factura emitida no puede hacer ──────────────────────────
-- Decisión del dueño (2026-11-05): una factura se CORRIGE en cualquier día
-- operativo, con bitácora. Lo que nunca cambia es su día y su número (la
-- venta sigue perteneciendo a su día original), y una anulada no se toca ni
-- se reactiva. El dinero del ajuste cae en la caja del día en que se corrige
-- (`cobro_pago.fecha_operativa`, §6.7); la venta cambia en el día de la factura.
CREATE OR REPLACE FUNCTION "hayai_cobro_guardia"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."fecha_operativa" IS DISTINCT FROM OLD."fecha_operativa"
     OR NEW."numero_dia" IS DISTINCT FROM OLD."numero_dia" THEN
    RAISE EXCEPTION 'El día y el número de una factura emitida no cambian (factura %)', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'cobro_fecha_inmutable';
  END IF;

  IF OLD."anulado_en" IS NOT NULL AND NEW."anulado_en" IS NULL THEN
    RAISE EXCEPTION 'Una factura anulada no se reactiva (factura %)', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'cobro_anulado_inmutable';
  END IF;

  IF (NEW."subtotal", NEW."descuento", NEW."impuesto", NEW."propina", NEW."total",
      NEW."total_bs", NEW."tasa_id", NEW."tasa_valor")
     IS DISTINCT FROM
     (OLD."subtotal", OLD."descuento", OLD."impuesto", OLD."propina", OLD."total",
      OLD."total_bs", OLD."tasa_id", OLD."tasa_valor") THEN
    IF OLD."anulado_en" IS NOT NULL THEN
      RAISE EXCEPTION 'La factura % está anulada: no se corrige', OLD."id"
        USING ERRCODE = '23514', CONSTRAINT = 'cobro_anulado_inmutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "cobro_guardia"
  BEFORE UPDATE ON "cobro"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_cobro_guardia"();

-- 6.7 · Los pagos son un libro de sólo agregar ─────────────────────────────
-- INSERT: fecha el movimiento con el día operativo en que ocurre (no el de la
-- factura) y rechaza pagos sobre facturas anuladas.
-- UPDATE: sólo la referencia se puede corregir; el dinero registrado no se
-- edita, se compensa con una devolución (fila negativa).
CREATE OR REPLACE FUNCTION "hayai_cobro_pago_guardia"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_anulado timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."cobro_id", NEW."metodo", NEW."moneda", NEW."monto", NEW."tasa_aplicada", NEW."monto_usd",
        NEW."recibido_en", NEW."fecha_operativa", NEW."registrado_por_id")
       IS DISTINCT FROM
       (OLD."cobro_id", OLD."metodo", OLD."moneda", OLD."monto", OLD."tasa_aplicada", OLD."monto_usd",
        OLD."recibido_en", OLD."fecha_operativa", OLD."registrado_por_id") THEN
      RAISE EXCEPTION 'Un pago registrado no se edita: registra una devolución y el pago correcto (pago %)', OLD."id"
        USING ERRCODE = '23514', CONSTRAINT = 'cobro_pago_inmutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT cb."anulado_en" INTO v_anulado
    FROM "cobro" cb WHERE cb."restaurante_id" = NEW."restaurante_id" AND cb."id" = NEW."cobro_id";
  IF v_anulado IS NOT NULL THEN
    RAISE EXCEPTION 'La factura % está anulada: no admite pagos ni devoluciones', NEW."cobro_id"
      USING ERRCODE = '23514', CONSTRAINT = 'cobro_anulado_inmutable';
  END IF;

  SELECT "hayai_fecha_operativa"(NEW."recibido_en", r."zona_horaria", r."hora_corte_dia")
    INTO NEW."fecha_operativa"
    FROM "restaurante" r WHERE r."id" = NEW."restaurante_id";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "cobro_pago_guardia"
  BEFORE INSERT OR UPDATE ON "cobro_pago"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_cobro_pago_guardia"();

-- 6.8 · La bitácora no se reescribe ────────────────────────────────────────
CREATE OR REPLACE FUNCTION "hayai_bitacora_inmutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'La bitácora no se modifica'
    USING ERRCODE = '23514', CONSTRAINT = 'bitacora_inmutable';
END;
$$;

CREATE TRIGGER "bitacora_inmutable"
  BEFORE UPDATE ON "bitacora"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_bitacora_inmutable"();


-- ───────────────────────────────────────────────────────────────────────────
-- 7 · Recalcular total y estado de todas las comandas con el trigger nuevo
-- Ninguna comanda histórica cambia de estado: las cobradas tienen todas sus
-- líneas facturadas (§3.6). Lo que sí puede corregirse es un `total` que el
-- servicio hubiera dejado desactualizado.
-- ───────────────────────────────────────────────────────────────────────────
UPDATE "comanda" SET "total" = "total";


-- ───────────────────────────────────────────────────────────────────────────
-- 8 · Vistas (security_invoker, igual que el resto: ver 02_vistas.sql)
-- ───────────────────────────────────────────────────────────────────────────

-- 8.1 · v_cuenta_cliente · LA cuenta: una fila por cliente ABIERTO ─────────
-- Sustituye a v_cuenta_mesa. "Cuentas por cobrar" = `total_por_cobrar > 0`;
-- la ficha de un cliente filtra por `cliente_id`; la de una mesa, por `mesa_id`
-- (puede haber varios clientes en la misma mesa).
--   cuenta_total      = toda su deuda viva (en cocina + despachada)
--   total_por_cobrar  = lo facturable YA (despachado)
--   total_cobrado     = lo que ya pagó en facturas vivas de esta visita
CREATE VIEW "v_cuenta_cliente" WITH (security_invoker = true) AS
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

-- 8.2 · v_mesa_estado · el plano ───────────────────────────────────────────
-- Mismas columnas y en el mismo orden que antes (el frontend las lee tal
-- cual) más dos al final. Lo que cambió es de DÓNDE salen:
--   · ocupada ⟺ al menos un cliente ABIERTO sentado en la mesa (antes: una
--     comanda viva o una reserva `sentada`). Un cliente que ya pagó todo pero
--     sigue sentado mantiene la mesa ocupada; se libera al cerrarlo o moverlo.
--   · comandas / cuenta_total = la deuda viva de los clientes sentados.
--   · sentada_cliente / sentada_en / sentada_reservacion_id = el PRIMER
--     cliente sentado ("Mesa ocupada · Juan").
--   · clientes / clientes_detalle = todos los sentados [{id, nombre}].
CREATE VIEW "v_mesa_estado" WITH (security_invoker = true) AS
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
-- Próxima reserva que ya "pesa" sobre la mesa (sin cambios).
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

-- 8.3 · v_cola_despacho · + el cliente (la comanda puede no tener mesa) ────
-- CREATE OR REPLACE: sólo se AÑADEN columnas al final.
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

-- 8.4 · v_venta_dia_metodo · el cuadre por método, por día DEL MOVIMIENTO ──
-- Antes agrupaba por el día de la factura. Ahora por el día en que entró o
-- salió el dinero: una devolución hecha hoy sobre una factura de ayer cuadra
-- la caja de hoy. Para todo lo histórico ambos días coinciden (§3.6). Las
-- devoluciones suman con su signo; `pagos` sólo cuenta los positivos.
-- `ajustes_otros_dias_usd` = la parte de `monto_usd` que corrige facturas de
-- OTRO día operativo. Es exactamente lo que hace que la caja del día no sea
-- igual a la venta del día (v_venta_dia), y el cierre de caja debe mostrarlo
-- aparte: caja del día = venta del día + ajustes_otros_dias_usd.
CREATE VIEW "v_venta_dia_metodo" WITH (security_invoker = true) AS
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

-- 8.5 · v_producto_vendido_dia · de la línea a su factura, directo ─────────
-- Una línea facturada y cancelada después (devolución) no cuenta.
CREATE VIEW "v_producto_vendido_dia" WITH (security_invoker = true) AS
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
-- 9 · Triggers diferidos y de bitácora
-- Al final a propósito: no deben ver ni verificar el backfill.
-- ───────────────────────────────────────────────────────────────────────────

-- 9.1 · ⭐⭐ La factura, verificada entera al COMMIT ──────────────────────────
-- Sustituye a `cobro_no_vacio` y lo amplía. Una factura VIVA tiene que:
--   1. cubrir al menos una línea viva           (error `cobro_no_vacio`: la
--      carrera de dos cajeros; o se le quitaron todas → anularla);
--   2. subtotal = Σ total_linea de sus líneas vivas   (`cobro_subtotal_coherente`);
--   3. total = subtotal - descuento + impuesto + propina, y
--      total_bs = round(total * tasa_valor, 4) ± 0,01  (`cobro_total_coherente`);
--   4. Σ pagos.monto_usd = total ± 0,01               (`cobro_pagos_cuadran`).
-- Diferido porque la transacción legítima pasa por estados intermedios
-- (INSERT cobro → facturar líneas → INSERT pagos; o cancelar línea → bajar
-- subtotal → devolución). No desactivarlo con SET CONSTRAINTS.
-- Una factura anulada no se verifica: es histórico congelado.
CREATE OR REPLACE FUNCTION "hayai_cobro_verificar"(p_restaurante uuid, p_cobro uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  cb         record;
  v_vivas    int;
  v_subtotal numeric;
  v_pagado   numeric;
BEGIN
  SELECT * INTO cb FROM "cobro" WHERE "restaurante_id" = p_restaurante AND "id" = p_cobro;
  IF NOT FOUND OR cb."anulado_en" IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT count(*), coalesce(sum(ci."total_linea"), 0) INTO v_vivas, v_subtotal
    FROM "comanda_item" ci
   WHERE ci."restaurante_id" = p_restaurante AND ci."cobro_id" = p_cobro AND ci."cancelado_en" IS NULL;

  IF v_vivas = 0 THEN
    RAISE EXCEPTION 'La factura % no cubre ninguna línea viva (¿la cuenta ya la cobró otro cajero? si se le quitaron todas, anúlala)', p_cobro
      USING ERRCODE = '23514', CONSTRAINT = 'cobro_no_vacio';
  END IF;
  IF cb."subtotal" <> v_subtotal THEN
    RAISE EXCEPTION 'La factura % dice subtotal % y sus líneas vivas suman %', p_cobro, cb."subtotal", v_subtotal
      USING ERRCODE = '23514', CONSTRAINT = 'cobro_subtotal_coherente';
  END IF;
  IF cb."total" <> cb."subtotal" - cb."descuento" + cb."impuesto" + cb."propina"
     OR abs(cb."total_bs" - round(cb."total" * cb."tasa_valor", 4)) > 0.01 THEN
    RAISE EXCEPTION 'La factura % tiene total % / total_bs % incoherentes con subtotal, descuento, impuesto, propina y tasa',
      p_cobro, cb."total", cb."total_bs"
      USING ERRCODE = '23514', CONSTRAINT = 'cobro_total_coherente';
  END IF;

  SELECT coalesce(sum(p."monto_usd"), 0) INTO v_pagado
    FROM "cobro_pago" p WHERE p."restaurante_id" = p_restaurante AND p."cobro_id" = p_cobro;
  IF abs(cb."total" - v_pagado) > 0.01 THEN
    RAISE EXCEPTION 'La factura % suma % USD y sus pagos % USD: registra el cobro adicional o la devolución de la diferencia',
      p_cobro, cb."total", v_pagado
      USING ERRCODE = '23514', CONSTRAINT = 'cobro_pagos_cuadran';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "hayai_cobro_coherente"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'cobro' THEN
    PERFORM "hayai_cobro_verificar"(NEW."restaurante_id", NEW."id");
  ELSE
    -- cobro_pago y comanda_item: la factura de antes y la de después.
    IF TG_OP <> 'INSERT' AND OLD."cobro_id" IS NOT NULL THEN
      PERFORM "hayai_cobro_verificar"(OLD."restaurante_id", OLD."cobro_id");
    END IF;
    IF TG_OP <> 'DELETE' AND NEW."cobro_id" IS NOT NULL THEN
      PERFORM "hayai_cobro_verificar"(NEW."restaurante_id", NEW."cobro_id");
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "cobro_coherente"
  AFTER INSERT OR UPDATE ON "cobro"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_cobro_coherente"();

CREATE CONSTRAINT TRIGGER "comanda_item_cobro_coherente"
  AFTER INSERT OR UPDATE OR DELETE ON "comanda_item"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_cobro_coherente"();

CREATE CONSTRAINT TRIGGER "cobro_pago_cobro_coherente"
  AFTER INSERT OR UPDATE OR DELETE ON "cobro_pago"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_cobro_coherente"();

-- 9.2 · Bitácora ───────────────────────────────────────────────────────────
-- AFTER: registra la fila tal como quedó. Qué entra (y qué no, a propósito):
--   · comanda_item: INSERT o UPDATE cuando la comanda YA salió de cocina.
--     Antes del despacho no se audita (era libre antes de esta migración y la
--     cocina todavía no hizo nada). Tampoco el "facturar" a secas (cobro_id
--     de NULL a X sin otro cambio): la factura misma es el registro.
--   · cobro: todo UPDATE que cambie algo (el INSERT es la factura misma).
--   · cliente: todo UPDATE que cambie algo — el cambio de `mesa_id` ES el
--     historial de asiento.
-- El autor viene de `SET LOCAL app.usuario_id` (set_config(..., true)) y el
-- motivo, opcional, de `app.motivo`. Sin autor, error: falla cerrado.
CREATE OR REPLACE FUNCTION "hayai_bitacora"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_antes      jsonb;
  v_despues    jsonb;
  v_cambios    text[] := '{}';
  v_despachada timestamptz;
  v_usuario    uuid;
BEGIN
  v_despues := to_jsonb(NEW) - 'actualizado_en';
  IF TG_OP = 'UPDATE' THEN
    v_antes := to_jsonb(OLD) - 'actualizado_en';
    SELECT coalesce(array_agg(d.key ORDER BY d.key), '{}') INTO v_cambios
      FROM jsonb_each(v_despues) d
     WHERE d.value IS DISTINCT FROM v_antes -> d.key;
    IF cardinality(v_cambios) = 0 THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'comanda_item' THEN
    SELECT c."despachada_en" INTO v_despachada
      FROM "comanda" c WHERE c."restaurante_id" = NEW."restaurante_id" AND c."id" = NEW."comanda_id";
    IF v_despachada IS NULL THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND v_cambios = ARRAY['cobro_id'] AND OLD."cobro_id" IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  v_usuario := nullif(current_setting('app.usuario_id', true), '')::uuid;
  IF v_usuario IS NULL THEN
    RAISE EXCEPTION 'Corrección sin autor en % (%): el servicio debe fijar app.usuario_id con SET LOCAL', TG_TABLE_NAME, NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'bitacora_sin_autor';
  END IF;

  INSERT INTO "bitacora" ("restaurante_id", "tabla", "entidad_id", "operacion", "cambios",
                          "antes", "despues", "usuario_id", "motivo")
  VALUES (NEW."restaurante_id", TG_TABLE_NAME, NEW."id", TG_OP, v_cambios,
          v_antes, v_despues, v_usuario, nullif(current_setting('app.motivo', true), ''));
  RETURN NULL;
END;
$$;

CREATE TRIGGER "comanda_item_bitacora"
  AFTER INSERT OR UPDATE ON "comanda_item"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_bitacora"();

CREATE TRIGGER "cobro_bitacora"
  AFTER UPDATE ON "cobro"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_bitacora"();

CREATE TRIGGER "cliente_bitacora"
  AFTER UPDATE ON "cliente"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_bitacora"();

-- ═══════════════════════════════════════════════════════════════════════════
-- Inventario de objetos escritos a mano (los vigila 99_verificar_objetos.sql):
--   índices parciales: comanda_item_deuda_idx, cliente_abierto_idx,
--                      cliente_reservacion_abierta_unica
--   CHECKs:   cliente_nombre_normalizado, cliente_cierre_coherente,
--             comanda_tipo_coherente (nuevo cuerpo), cobro_pago_monto_valido
--             (admite devoluciones), comanda_item_total_coherente
--   triggers: comanda_estado (nuevo cuerpo), comanda_item_editable,
--             comanda_item_derivar, cliente_cierre_sin_deuda, cobro_guardia,
--             cobro_pago_guardia, bitacora_inmutable, cobro_coherente,
--             comanda_item_cobro_coherente, cobro_pago_cobro_coherente,
--             comanda_item_bitacora, cobro_bitacora, cliente_bitacora
--   vistas:   v_cuenta_cliente (nueva), v_mesa_estado, v_cola_despacho,
--             v_venta_dia_metodo, v_producto_vendido_dia
--   muertos:  v_cuenta_mesa, comanda_cuenta_abierta_idx, cobro_no_vacio
--             (trigger; el nombre sigue vivo como error), comanda_item_solo_pendiente
-- ═══════════════════════════════════════════════════════════════════════════
