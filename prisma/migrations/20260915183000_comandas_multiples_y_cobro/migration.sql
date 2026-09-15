-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDAS MÚLTIPLES POR MESA + COBRO CONSOLIDADO
--
-- Diseño de datos: J.O.R.B.I (data-engineer), verificado contra PostgreSQL 17
-- real con 43 aserciones y 65.706 comandas simuladas antes de escribirse aquí.
-- Traducción a migración del repo: D.A.N.I.
--
-- ⚠️ ESTA MIGRACIÓN NO ES LA QUE GENERA PRISMA, y no puede serlo. El diff de
-- `prisma migrate diff` proponía, verificado:
--   · `DROP TABLE comanda_pago` + `DROP TABLE contador_comanda` en vez de los
--     RENAME → perdería TODOS los pagos históricos y los contadores del día.
--   · `USING ("estado"::text::"estado_comanda_new")` para el swap del enum →
--     revienta en la primera fila 'abierta' o 'por_cobrar' (no existen en el
--     tipo nuevo). Hace falta el CASE de §4.
--   · Ningún backfill: dejaría `cobro` vacío y las comandas cobradas sin factura.
-- Lo que SÍ se tomó del diff generado: los nombres exactos de FKs e índices,
-- para que la próxima migración no vea deriva.
--
-- Orden obligatorio (cada bloque depende del anterior):
--   0 · Aserciones previas       (abortar ANTES de tocar nada)
--   1 · DROP de vistas            (bloquean el ALTER de las columnas que usan)
--   2 · DROP de triggers/índices/CHECKs que se van
--   3 · DDL de tablas y columnas nuevas
--   4 · Swap del enum estado_comanda
--   5 · Funciones de trigger  (los triggers de `comanda`/`comanda_item` se
--       instalan en §6.7 y §6.8, DESPUÉS del backfill — ver el motivo allí)
--   6 · Backfill
--   7 · DROP de columnas y tipos viejos
--   8 · CHECKs e índices nuevos
--   9 · Vistas nuevas
--
-- Correr con el local CERRADO: con cero comandas vivas el backfill de §6.1 no
-- llega a ejecutarse sobre nada.
--
-- ⚠️ ESTE ARCHIVO EXIGE UNA SOLA TRANSACCIÓN, y justo por eso NO lleva
-- BEGIN/COMMIT propios: `prisma migrate deploy` ya envuelve cada migración en
-- una, y un BEGIN anidado haría COMMIT a media migración.
-- Si alguien lo aplica a mano con `psql -f`, psql va en AUTOCOMMIT: cada
-- sentencia es su propia transacción, así que el constraint trigger DIFERIDO
-- `cobro_no_vacio` (§5.4) se evalúa al terminar el INSERT de §6.4 —antes de que
-- el UPDATE siguiente enlace las comandas— y aborta con "el cobro X no cubre
-- ninguna comanda". Verificado en los dos sentidos: falla por psql suelto, pasa
-- por migrate deploy. Para aplicarlo a mano hay que envolverlo:
--     ( echo 'BEGIN;'; cat migration.sql; echo 'COMMIT;' ) | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 0 · Aserciones previas
-- Fallar aquí es barato; fallar a mitad del backfill con un mensaje del
-- catálogo de Postgres ("null value in column tasa_id") no dice qué hacer.
-- ───────────────────────────────────────────────────────────────────────────

-- 0.1 · `abierta_en` y `creada_en` son la misma cosa. Se va a eliminar
-- `abierta_en` y la cola de despacho pasa a ordenar por `creada_en`. Si en
-- producción difirieran, este bloque aborta la migración.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "comanda"
   WHERE abs(extract(epoch FROM ("abierta_en" - "creada_en"))) > 1;
  IF n > 0 THEN
    RAISE EXCEPTION '% comanda(s) tienen abierta_en <> creada_en; revisar antes de eliminar abierta_en', n;
  END IF;
END $$;

-- 0.2 · ⚠️ AÑADIDO POR D.A.N.I (hueco del borrador, ver el informe).
-- `cobro.tasa_id` es NOT NULL, pero el CHECK viejo `comanda_tasa_congelada`
-- sólo exigía `tasa_valor` y `total_bs`: una comanda cobrada podía quedar con
-- `tasa_id` NULL (cargada a mano, o por el seed de un test). El backfill de
-- §6.4 la copiaría a `cobro.tasa_id` y moriría con un 23502 que no explica
-- nada. Se detecta aquí, con el número de comandas y qué hacer con ellas.
-- NO se inventa una tasa: eso fabricaría el tipo de cambio de una venta real.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "comanda"
   WHERE "estado" = 'cobrada' AND "tasa_id" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      '% comanda(s) cobradas no tienen tasa_id y cobro.tasa_id es NOT NULL. '
      'Asignarles a mano la tasa con la que se cobraron (SELECT id, numero_dia, '
      'fecha_operativa, tasa_valor FROM comanda WHERE estado = ''cobrada'' AND '
      'tasa_id IS NULL) antes de volver a correr esta migración.', n;
  END IF;
END $$;

-- 0.3 · ⚠️ AÑADIDO POR D.A.N.I (mismo hueco).
-- Los pagos se repuntan de la comanda al cobro en §6.4 cruzando por la comanda
-- de origen. Un pago colgado de una comanda que NO está cobrada no encuentra
-- cobro, se quedaría apuntando a un uuid de comanda, y la FK nueva de §8 lo
-- rechazaría al final con un mensaje que ya no señala la causa.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n
    FROM "comanda_pago" p
    JOIN "comanda" c ON c."id" = p."comanda_id"
   WHERE c."estado" <> 'cobrada';
  IF n > 0 THEN
    RAISE EXCEPTION
      '% pago(s) cuelgan de comandas que no están cobradas; no hay cobro al que '
      'moverlos. Revisar comanda_pago contra comanda.estado antes de migrar.', n;
  END IF;
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 1 · Fuera las vistas (se recrean en §9 con otras columnas)
--
-- `v_mesa_estado` cambia su LISTA de columnas (pasa de un LATERAL LIMIT 1 a
-- agregados), así que es DROP + CREATE y no CREATE OR REPLACE: Postgres sólo
-- permite reemplazar una vista si las columnas coinciden en nombre y tipo.
-- ───────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS "v_mesa_estado";
DROP VIEW IF EXISTS "v_comanda_activa";
DROP VIEW IF EXISTS "v_venta_dia";
DROP VIEW IF EXISTS "v_venta_dia_metodo";
DROP VIEW IF EXISTS "v_producto_vendido_dia";
DROP VIEW IF EXISTS "v_comanda_descuadre";


-- ───────────────────────────────────────────────────────────────────────────
-- 2 · Fuera lo que el modelo viejo hacía cumplir
--
-- Estos índices son PARCIALES y por tanto invisibles para Prisma: el diff
-- generado no los menciona, pero referencian columnas que §7 elimina y
-- bloquearían el ALTER. Se quitan a mano, a propósito.
-- ───────────────────────────────────────────────────────────────────────────

-- ⭐ EL cambio: una mesa puede tener varias comandas vivas.
DROP INDEX IF EXISTS "comanda_mesa_activa_unica";
-- La cola de cocina ya no es por ítem.
DROP INDEX IF EXISTS "comanda_item_cocina_idx";
-- Ya no existe el estado `por_cobrar`.
DROP INDEX IF EXISTS "comanda_por_cobrar_idx";
-- Una reserva sentada genera N comandas, no una.
DROP INDEX IF EXISTS "comanda_reservacion_unica";
-- Índices de Prisma que referencian columnas que se van.
DROP INDEX IF EXISTS "comanda_restaurante_id_estado_abierta_en_idx";
DROP INDEX IF EXISTS "comanda_item_comanda_id_ronda_orden_idx";
DROP INDEX IF EXISTS "comanda_item_restaurante_id_destino_snap_estado_enviado_en_idx";

ALTER TABLE "comanda"
  DROP CONSTRAINT IF EXISTS "comanda_cierre_coherente",
  DROP CONSTRAINT IF EXISTS "comanda_tasa_congelada",
  DROP CONSTRAINT IF EXISTS "comanda_totales_validos";

-- El trigger que impide congelar la tasa del euro viaja de `comanda` a `cobro`
-- (§5.3). Si se olvidara, el agujero de docs/DECISIONES-DATOS.md §10.4 se reabre.
DROP TRIGGER IF EXISTS "comanda_tasa_base" ON "comanda";
DROP FUNCTION IF EXISTS "hayai_comanda_tasa_base"();


-- ───────────────────────────────────────────────────────────────────────────
-- 3 · Tablas y columnas nuevas
-- ───────────────────────────────────────────────────────────────────────────

-- 3.1 · cobro — la factura consolidada de una mesa.
CREATE TABLE "cobro" (
    "id"               UUID NOT NULL,
    "restaurante_id"   UUID NOT NULL,
    "mesa_id"          UUID,
    "salon_id"         UUID,
    "numero_dia"       INTEGER NOT NULL,
    "fecha_operativa"  DATE NOT NULL,
    "turno"            "turno_servicio" NOT NULL,
    "comensales"       INTEGER NOT NULL DEFAULT 1,
    "subtotal"         DECIMAL(14,4) NOT NULL DEFAULT 0,
    "descuento"        DECIMAL(14,4) NOT NULL DEFAULT 0,
    "impuesto"         DECIMAL(14,4) NOT NULL DEFAULT 0,
    "propina"          DECIMAL(14,4) NOT NULL DEFAULT 0,
    "total"            DECIMAL(14,4) NOT NULL DEFAULT 0,
    "tasa_id"          UUID NOT NULL,
    "tasa_valor"       DECIMAL(18,8) NOT NULL,
    "total_bs"         DECIMAL(18,4) NOT NULL,
    "cobrado_en"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cobrado_por_id"   UUID,
    "anulado_en"       TIMESTAMPTZ(6),
    "anulado_por_id"   UUID,
    "motivo_anulacion" TEXT,
    "notas"            TEXT,
    "creado_en"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en"   TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "cobro_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cobro_restaurante_id_key"  ON "cobro" ("restaurante_id", "id");
CREATE UNIQUE INDEX "cobro_numero_dia_unico"    ON "cobro" ("restaurante_id", "fecha_operativa", "numero_dia");
CREATE INDEX "cobro_dia_idx"                    ON "cobro" ("restaurante_id", "fecha_operativa", "turno");
CREATE INDEX "cobro_mesa_idx"                   ON "cobro" ("restaurante_id", "mesa_id", "cobrado_en");

ALTER TABLE "cobro"
  ADD CONSTRAINT "cobro_restaurante_id_fkey"
      FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "cobro_restaurante_id_mesa_id_fkey"
      FOREIGN KEY ("restaurante_id","mesa_id") REFERENCES "mesa"("restaurante_id","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cobro_restaurante_id_salon_id_fkey"
      FOREIGN KEY ("restaurante_id","salon_id") REFERENCES "salon"("restaurante_id","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cobro_restaurante_id_tasa_id_fkey"
      FOREIGN KEY ("restaurante_id","tasa_id") REFERENCES "tasa_cambio"("restaurante_id","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cobro_restaurante_id_cobrado_por_id_fkey"
      FOREIGN KEY ("restaurante_id","cobrado_por_id") REFERENCES "usuario"("restaurante_id","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cobro_restaurante_id_anulado_por_id_fkey"
      FOREIGN KEY ("restaurante_id","anulado_por_id") REFERENCES "usuario"("restaurante_id","id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Columna TEMPORAL del backfill: de qué comanda salió este cobro histórico.
-- Se usa para repuntar los pagos y se elimina en §7.
ALTER TABLE "cobro" ADD COLUMN "_comanda_origen_id" UUID;

-- 3.2 · comanda: los tres ejes independientes.
ALTER TABLE "comanda"
  ADD COLUMN "despachada_en" TIMESTAMPTZ(6),
  ADD COLUMN "anulada_en"    TIMESTAMPTZ(6),
  ADD COLUMN "cobro_id"      UUID;

ALTER TABLE "comanda"
  ADD CONSTRAINT "comanda_restaurante_id_cobro_id_fkey"
      FOREIGN KEY ("restaurante_id","cobro_id") REFERENCES "cobro"("restaurante_id","id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3.3 · comanda_item: la cancelación pasa a ser un hecho con fecha.
ALTER TABLE "comanda_item" ADD COLUMN "cancelado_en" TIMESTAMPTZ(6);

-- 3.4 · comanda_pago -> cobro_pago (RENAME: preserva los datos; el
--       DROP TABLE + CREATE TABLE que propone Prisma los perdería).
ALTER TABLE "comanda_pago" RENAME TO "cobro_pago";
ALTER TABLE "cobro_pago"   RENAME COLUMN "comanda_id" TO "cobro_id";
ALTER TABLE "cobro_pago"   RENAME CONSTRAINT "comanda_pago_pkey" TO "cobro_pago_pkey";
ALTER TABLE "cobro_pago"   RENAME CONSTRAINT "pago_monto_valido" TO "cobro_pago_monto_valido";
ALTER TABLE "cobro_pago"   RENAME CONSTRAINT "pago_referencia_obligatoria" TO "cobro_pago_referencia_obligatoria";
ALTER TABLE "cobro_pago"   RENAME CONSTRAINT "pago_tasa_coherente" TO "cobro_pago_tasa_coherente";
ALTER INDEX IF EXISTS "comanda_pago_restaurante_id_key"        RENAME TO "cobro_pago_restaurante_id_key";
ALTER INDEX IF EXISTS "comanda_pago_comanda_id_idx"            RENAME TO "cobro_pago_cobro_id_idx";
ALTER INDEX IF EXISTS "comanda_pago_restaurante_id_recibido_en_idx" RENAME TO "cobro_pago_restaurante_id_recibido_en_idx";
ALTER TABLE "cobro_pago" DROP CONSTRAINT IF EXISTS "comanda_pago_restaurante_id_comanda_id_fkey";
-- ⚠️ AÑADIDO POR D.A.N.I: un RENAME TABLE no renombra las FK que la tabla ya
-- tenía. Sin esto quedan con el nombre viejo, y el `migrate diff` de la próxima
-- migración las ve como deriva y propone DROP + ADD en cada despliegue.
ALTER TABLE "cobro_pago" RENAME CONSTRAINT "comanda_pago_restaurante_id_fkey"
                                        TO "cobro_pago_restaurante_id_fkey";
ALTER TABLE "cobro_pago" RENAME CONSTRAINT "comanda_pago_restaurante_id_registrado_por_id_fkey"
                                        TO "cobro_pago_restaurante_id_registrado_por_id_fkey";
-- La FK cobro_pago -> cobro se añade en §8, cuando el backfill de §6.4 ya
-- repuntó `cobro_id` de la comanda de origen al cobro de verdad.

-- 3.5 · contador_comanda -> contador_dia (ahora numera dos documentos).
ALTER TABLE "contador_comanda" RENAME TO "contador_dia";
ALTER TABLE "contador_dia" RENAME COLUMN "ultimo" TO "ultimo_comanda";
ALTER TABLE "contador_dia" RENAME CONSTRAINT "contador_comanda_pkey" TO "contador_dia_pkey";
-- Mismo motivo que arriba.
ALTER TABLE "contador_dia" RENAME CONSTRAINT "contador_comanda_restaurante_id_fkey"
                                          TO "contador_dia_restaurante_id_fkey";
ALTER TABLE "contador_dia" ADD COLUMN "ultimo_cobro" INTEGER NOT NULL DEFAULT 0;

-- ⚠️ El diff generado incluye además
--   ALTER TABLE "restaurante" ALTER COLUMN "hora_corte_dia" SET DEFAULT '05:00'::time;
-- que NO se aplica aquí: es ruido preexistente, ajeno a este cambio. La base ya
-- tiene ese default desde la migración de fundación; Prisma lo re-emite en cada
-- diff porque `dbgenerated("'05:00'::time")` no round-trippea contra el
-- `'05:00:00'::time without time zone` que devuelve el catálogo. Aplicarlo no lo
-- silencia (verificado), así que sólo añadiría una línea que no hace nada.


-- ───────────────────────────────────────────────────────────────────────────
-- 4 · Swap del enum estado_comanda
--     abierta -> pendiente · por_cobrar -> despachada (§6 lo afina con los
--     timestamps: una comanda 'abierta' con todo servido queda 'despachada').
--
-- El cast directo `estado::text::estado_comanda_new` que genera Prisma no
-- sirve: 'abierta' y 'por_cobrar' no existen en el tipo nuevo y la primera fila
-- revienta con 22P02. El CASE traduce.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TYPE "estado_comanda_nuevo" AS ENUM ('pendiente', 'despachada', 'cobrada', 'anulada');

ALTER TABLE "comanda" ALTER COLUMN "estado" DROP DEFAULT;
ALTER TABLE "comanda" ALTER COLUMN "estado" TYPE "estado_comanda_nuevo"
  USING (CASE "estado"::text
           WHEN 'abierta'    THEN 'pendiente'
           WHEN 'por_cobrar' THEN 'despachada'
           ELSE "estado"::text
         END)::"estado_comanda_nuevo";

DROP TYPE "estado_comanda";
ALTER TYPE "estado_comanda_nuevo" RENAME TO "estado_comanda";
ALTER TABLE "comanda" ALTER COLUMN "estado" SET DEFAULT 'pendiente';


-- ───────────────────────────────────────────────────────────────────────────
-- 5 · Funciones de trigger
--     (espejo de prisma/sql/01_constraints_y_triggers.sql §8-§11)
-- ───────────────────────────────────────────────────────────────────────────

-- 5.1 ⭐ `estado` es DERIVADO. Los hechos son `despachada_en`, `cobro_id` y
-- `anulada_en`; la columna existe para que el contrato con el frontend, los
-- filtros de Prisma y los predicados de las vistas sigan leyéndose de una sola
-- palabra. El trigger es la ÚNICA definición de esa derivación: escriba quien
-- escriba (Prisma, un $executeRaw, un UPDATE a mano), no puede desincronizarse.
-- No es una columna GENERATED porque el cast texto->enum no es IMMUTABLE
-- (la misma trampa que impidió generar `reservacion.periodo`).
CREATE OR REPLACE FUNCTION "hayai_comanda_estado"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."estado" := CASE
    WHEN NEW."anulada_en"    IS NOT NULL THEN 'anulada'
    WHEN NEW."cobro_id"      IS NOT NULL THEN 'cobrada'
    WHEN NEW."despachada_en" IS NOT NULL THEN 'despachada'
    ELSE                                      'pendiente'
  END::"estado_comanda";
  RETURN NEW;
END;
$$;

-- ⚠️ El TRIGGER se instala en §6.7, DESPUÉS del backfill. En cuanto existe,
-- `estado` deja de ser un dato y pasa a ser una derivación: el primer UPDATE
-- del backfill (poner `despachada_en`) recalcularía `estado` y borraría el
-- 'cobrada' que el paso siguiente necesita leer para crear los cobros. El
-- backfill trabaja sobre el `estado` VIEJO y al final deja que el trigger lo
-- recalcule de una pasada.

-- 5.2 Función del guardián de ítems. ⚠️ El TRIGGER que la usa se instala en
-- §6.8, DESPUÉS del backfill: si se instalara aquí, bloquearía el propio
-- backfill (`UPDATE comanda_item SET cancelado_en` sobre ítems de comandas que
-- el paso anterior acaba de marcar despachadas o cobradas). Un guardián de
-- escrituras futuras no debe vigilar la migración que crea el pasado.
CREATE OR REPLACE FUNCTION "hayai_comanda_item_solo_pendiente"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_estado "estado_comanda";
BEGIN
  SELECT c."estado" INTO v_estado
    FROM "comanda" c
   WHERE c."restaurante_id" = NEW."restaurante_id" AND c."id" = NEW."comanda_id";

  -- Sin fila: que hable la FK compuesta (23503), cuyo mensaje es el correcto.
  IF v_estado IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_estado <> 'pendiente' THEN
    RAISE EXCEPTION
      'La comanda % está % : sus ítems ya no se pueden modificar',
      NEW."comanda_id", v_estado
      USING ERRCODE = '23514', CONSTRAINT = 'comanda_item_solo_pendiente';
  END IF;

  RETURN NEW;
END;
$$;

-- 5.3 El euro no puede cobrar. Mismo invariante de DECISIONES-DATOS §10.4,
-- mudado a `cobro`, que es donde ahora se congela la tasa.
CREATE OR REPLACE FUNCTION "hayai_cobro_tasa_base"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_divisa "divisa";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."tasa_id" IS NOT DISTINCT FROM OLD."tasa_id" THEN
    RETURN NEW;
  END IF;

  SELECT t."divisa" INTO v_divisa
    FROM "tasa_cambio" t
   WHERE t."restaurante_id" = NEW."restaurante_id" AND t."id" = NEW."tasa_id";

  IF v_divisa IS NOT NULL AND v_divisa <> 'USD'::"divisa" THEN
    RAISE EXCEPTION
      'El cobro % intenta congelar una tasa de %; el cobro sólo admite la divisa base (USD)',
      NEW."id", v_divisa
      USING ERRCODE = '23514', CONSTRAINT = 'cobro_tasa_base';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "cobro_tasa_base"
  BEFORE INSERT OR UPDATE ON "cobro"
  FOR EACH ROW EXECUTE FUNCTION "hayai_cobro_tasa_base"();

-- 5.4 ⭐⭐ Un cobro SIEMPRE cubre al menos una comanda.
-- Es la red que convierte la carrera de dos cajeros cobrando la misma mesa en
-- un error limpio en vez de en una factura fantasma con pagos dentro y ninguna
-- venta detrás. DEFERRABLE porque la transacción legítima es
-- INSERT cobro -> UPDATE comanda SET cobro_id, y en el instante del INSERT
-- todavía no hay ninguna comanda apuntando.
CREATE OR REPLACE FUNCTION "hayai_cobro_no_vacio"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."anulado_en" IS NULL
     AND NOT EXISTS (
           SELECT 1 FROM "comanda" c
            WHERE c."restaurante_id" = NEW."restaurante_id" AND c."cobro_id" = NEW."id")
  THEN
    RAISE EXCEPTION
      'El cobro % no cubre ninguna comanda (¿la mesa ya la cobró otro cajero?)',
      NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'cobro_no_vacio';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "cobro_no_vacio"
  AFTER INSERT OR UPDATE ON "cobro"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "hayai_cobro_no_vacio"();


-- ───────────────────────────────────────────────────────────────────────────
-- 6 · Backfill
-- ───────────────────────────────────────────────────────────────────────────

-- 6.1 Despacho. Regla CONSERVADORA y deliberada: una comanda se da por
-- despachada sólo si TODAS sus líneas vivas salieron alguna vez. La regla
-- laxa ("alguna salió") dejaría cobrable un plato que la cocina nunca hizo,
-- porque en el modelo nuevo la comanda es la unidad y ya no hay forma de que
-- una línea suelta vuelva a la cola: se le cobraría al cliente comida que no
-- recibió. Con la regla conservadora lo peor que pasa es que la cocina vuelva
-- a ver un ticket casi terminado y lo despache de un clic.
UPDATE "comanda" c
   SET "despachada_en" = d."momento"
  FROM (
    SELECT ci."comanda_id",
           max(coalesce(ci."servido_en", ci."enviado_en"))     AS "momento",
           count(*) FILTER (WHERE ci."estado" <> 'cancelado'
                              AND ci."servido_en" IS NULL
                              AND ci."enviado_en" IS NULL)::int AS "sin_salir"
      FROM "comanda_item" ci
     GROUP BY ci."comanda_id"
  ) d
 WHERE d."comanda_id" = c."id"
   AND d."sin_salir"  = 0
   AND d."momento" IS NOT NULL
   AND c."estado" <> 'anulada';

-- Una comanda ya cobrada estuvo despachada por definición, aunque sus ítems
-- no tuvieran fecha (datos viejos o cargados a mano).
UPDATE "comanda"
   SET "despachada_en" = coalesce("cerrada_en", "actualizada_en")
 WHERE "estado" = 'cobrada' AND "despachada_en" IS NULL;

-- 6.2 Anulación.
UPDATE "comanda"
   SET "anulada_en" = coalesce("cerrada_en", "actualizada_en")
 WHERE "estado" = 'anulada';

-- 6.3 Ítems cancelados.
UPDATE "comanda_item"
   SET "cancelado_en" = "actualizado_en"
 WHERE "estado" = 'cancelado';

-- 6.4 Un cobro por cada comanda cobrada. Históricamente una comanda ERA la
-- cuenta de la mesa, así que el 1:1 es la traducción fiel: no se inventan
-- agrupaciones que nunca ocurrieron.
INSERT INTO "cobro" (
  "id", "restaurante_id", "mesa_id", "salon_id", "numero_dia", "fecha_operativa",
  "turno", "comensales", "subtotal", "descuento", "impuesto", "propina", "total",
  "tasa_id", "tasa_valor", "total_bs", "cobrado_en", "creado_en", "actualizado_en",
  "_comanda_origen_id"
)
SELECT
  gen_random_uuid(), c."restaurante_id", c."mesa_id", c."salon_id",
  row_number() OVER (PARTITION BY c."restaurante_id", c."fecha_operativa"
                         ORDER BY c."cerrada_en", c."numero_dia")::int,
  c."fecha_operativa", c."turno", c."comensales",
  c."subtotal", c."descuento", c."impuesto", c."propina", c."total",
  c."tasa_id", c."tasa_valor", c."total_bs",
  c."cerrada_en", c."creada_en", now(),
  c."id"
FROM "comanda" c
WHERE c."estado" = 'cobrada';

UPDATE "comanda" c SET "cobro_id" = cb."id"
  FROM "cobro" cb WHERE cb."_comanda_origen_id" = c."id";

-- Los pagos cuelgan del cobro, no de la comanda.
UPDATE "cobro_pago" p SET "cobro_id" = cb."id"
  FROM "cobro" cb WHERE cb."_comanda_origen_id" = p."cobro_id";

-- 6.5 ⚠️ El contador del día TIENE que quedar por delante de los números ya
-- repartidos, o el primer cobro real del día choca con `cobro_numero_dia_unico`.
UPDATE "contador_dia" cd
   SET "ultimo_cobro" = x."maximo"
  FROM (SELECT "restaurante_id", "fecha_operativa", max("numero_dia") AS "maximo"
          FROM "cobro" GROUP BY 1, 2) x
 WHERE x."restaurante_id" = cd."restaurante_id"
   AND x."fecha_operativa" = cd."fecha_operativa";

INSERT INTO "contador_dia" ("restaurante_id", "fecha_operativa", "ultimo_comanda", "ultimo_cobro")
SELECT x."restaurante_id", x."fecha_operativa", 0, x."maximo"
  FROM (SELECT "restaurante_id", "fecha_operativa", max("numero_dia") AS "maximo"
          FROM "cobro" GROUP BY 1, 2) x
 WHERE NOT EXISTS (SELECT 1 FROM "contador_dia" cd
                    WHERE cd."restaurante_id" = x."restaurante_id"
                      AND cd."fecha_operativa" = x."fecha_operativa");

-- 6.6 `comanda.total` pasa a ser SÓLO la suma de sus líneas vivas: descuento,
-- impuesto y propina se negocian sobre la cuenta de la mesa, no sobre el
-- ticket de cocina, y ya viven en `cobro`. Va DESPUÉS de crear los cobros,
-- que son los que necesitaban el total económico viejo.
UPDATE "comanda" SET "total" = "subtotal";

-- 6.7 ⭐ Ahora sí entra el trigger de `estado` (función definida en §5.1), y un
-- UPDATE que no cambia nada lo obliga a recalcular la columna en todas las
-- filas. Así la derivación existe en UN solo sitio —el trigger— también para
-- los datos históricos: este bloque no repite el CASE.
CREATE TRIGGER "comanda_estado"
  BEFORE INSERT OR UPDATE ON "comanda"
  FOR EACH ROW EXECUTE FUNCTION "hayai_comanda_estado"();

UPDATE "comanda" SET "estado" = "estado";

-- 6.8 ⭐ Y por último el guardián de ítems (función definida en §5.2).
-- Cubre las tres reglas del dueño de una vez:
--   · se puede anular un ítem ANTES de despachar la comanda;
--   · no se le agregan ítems a una comanda que ya salió (rompería el FIFO:
--     el pedido entró a la cola con un contenido y saldría con otro);
--   · no se toca nada de una comanda ya cobrada — eso cambiaría el monto de
--     una factura ya emitida.
-- Sólo INSERT/UPDATE: el DELETE de un ítem no existe en el producto (cancelar
-- es lógico) y meterlo aquí rompería el DELETE en cascada del restaurante.
CREATE TRIGGER "comanda_item_solo_pendiente"
  BEFORE INSERT OR UPDATE ON "comanda_item"
  FOR EACH ROW EXECUTE FUNCTION "hayai_comanda_item_solo_pendiente"();

-- 6.9 ⚠️ Dos cosas de una: valida YA el backfill contra `cobro_no_vacio` (el
-- error sale aquí, señalando el backfill, y no al final del COMMIT señalando
-- la nada) y vacía la cola de eventos diferidos — sin esto el `ALTER TABLE`
-- de §7 falla con "cannot ALTER TABLE because it has pending trigger events".
SET CONSTRAINTS ALL IMMEDIATE;


-- ───────────────────────────────────────────────────────────────────────────
-- 7 · Fuera lo que ya no se usa
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "cobro" DROP COLUMN "_comanda_origen_id";

ALTER TABLE "comanda"
  DROP COLUMN "subtotal",
  DROP COLUMN "descuento",
  DROP COLUMN "impuesto",
  DROP COLUMN "propina",
  DROP COLUMN "abierta_en",
  DROP COLUMN "cerrada_en",
  DROP COLUMN "tasa_id",
  DROP COLUMN "tasa_valor",
  DROP COLUMN "total_bs";

ALTER TABLE "comanda_item"
  DROP COLUMN "estado",
  DROP COLUMN "ronda",
  DROP COLUMN "enviado_en",
  DROP COLUMN "servido_en";

DROP TYPE "estado_comanda_item";


-- ───────────────────────────────────────────────────────────────────────────
-- 8 · CHECKs e índices del modelo nuevo
-- ───────────────────────────────────────────────────────────────────────────

-- ⚠️ AÑADIDO POR D.A.N.I: la FK que le faltaba a `cobro_pago`. El borrador
-- dejaba caer la vieja (hacia `comanda`) y no ponía la nueva, así que un pago
-- podía quedar apuntando a un cobro inexistente — justo la integridad que la
-- tabla tenía antes. Va aquí y no en §3.4 porque hasta §6.4 la columna
-- `cobro_id` todavía contenía ids de comanda.
ALTER TABLE "cobro_pago"
  ADD CONSTRAINT "cobro_pago_restaurante_id_cobro_id_fkey"
      FOREIGN KEY ("restaurante_id","cobro_id") REFERENCES "cobro"("restaurante_id","id")
      ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comanda"
  ADD CONSTRAINT "comanda_total_valido" CHECK ("total" >= 0),
  -- Una comanda anulada no se cobra, y una cobrada no se anula.
  ADD CONSTRAINT "comanda_anulada_no_cobrada" CHECK ("anulada_en" IS NULL OR "cobro_id" IS NULL),
  -- La traza de anulación sólo existe si hubo anulación.
  ADD CONSTRAINT "comanda_anulacion_coherente" CHECK (
    "anulada_en" IS NOT NULL OR ("anulada_por_id" IS NULL AND "motivo_anulacion" IS NULL)
  ),
  -- No se factura lo que no salió de cocina. El dueño confirmó la regla: si una
  -- mesa tiene un pedido todavía en cocina, se cobra sólo lo ya despachado y lo
  -- pendiente arranca una cuenta nueva.
  ADD CONSTRAINT "comanda_cobro_tras_despacho" CHECK (
    "cobro_id" IS NULL OR "despachada_en" IS NOT NULL
  );

ALTER TABLE "comanda_item"
  ADD CONSTRAINT "comanda_item_cancelacion_coherente" CHECK (
    "cancelado_en" IS NOT NULL OR ("cancelado_por_id" IS NULL AND "motivo_cancelacion" IS NULL)
  );

ALTER TABLE "cobro"
  ADD CONSTRAINT "cobro_totales_validos" CHECK (
    "subtotal" >= 0 AND "descuento" >= 0 AND "impuesto" >= 0 AND "propina" >= 0
    AND "total" >= 0 AND "total_bs" >= 0
  ),
  ADD CONSTRAINT "cobro_tipo_coherente" CHECK (
    ("mesa_id" IS NOT NULL AND "salon_id" IS NOT NULL) OR "mesa_id" IS NULL
  ),
  ADD CONSTRAINT "cobro_anulacion_coherente" CHECK (
    "anulado_en" IS NOT NULL OR ("anulado_por_id" IS NULL AND "motivo_anulacion" IS NULL)
  );

-- ⭐ Cola de despacho GLOBAL, estrictamente por orden de llegada.
-- Índice diminuto: sólo contiene lo que la cocina todavía no sacó, y ya viene
-- ordenado, así que la pantalla del KDS es una lectura secuencial del índice.
CREATE INDEX "comanda_cola_despacho_idx"
  ON "comanda" ("restaurante_id", "creada_en")
  WHERE "despachada_en" IS NULL AND "anulada_en" IS NULL;

-- ⭐ La cuenta viva de una mesa. Es el mismo índice que `comanda_mesa_activa_unica`
-- menos el UNIQUE: conserva sus dos beneficios de rendimiento (v_mesa_estado y
-- cuentas por cobrar leen un índice minúsculo) y pierde el que ya no aplica.
CREATE INDEX "comanda_cuenta_abierta_idx"
  ON "comanda" ("restaurante_id", "mesa_id")
  WHERE "mesa_id" IS NOT NULL AND "cobro_id" IS NULL AND "anulada_en" IS NULL;

-- Las comandas que cubre un cobro (reimprimir la factura).
CREATE INDEX "comanda_cobro_idx" ON "comanda" ("restaurante_id", "cobro_id");

-- Reemplazo de los índices de Prisma que se cayeron en §2.
CREATE INDEX "comanda_restaurante_id_estado_creada_en_idx"
  ON "comanda" ("restaurante_id", "estado", "creada_en");
CREATE INDEX "comanda_item_comanda_id_orden_idx"
  ON "comanda_item" ("comanda_id", "orden");
-- Una reserva sentada genera N comandas: índice, ya no unicidad.
CREATE INDEX "comanda_restaurante_id_reservacion_id_idx"
  ON "comanda" ("restaurante_id", "reservacion_id");


-- ───────────────────────────────────────────────────────────────────────────
-- 9 · Vistas  (espejo de prisma/sql/02_vistas.sql)
-- ───────────────────────────────────────────────────────────────────────────

-- 9.1 v_mesa_estado · el plano. Ahora AGREGA sobre N comandas por mesa.
-- El LATERAL con agregados devuelve siempre exactamente una fila (0 comandas
-- cuando la mesa está libre), así que el CASE mira el contador, no un NULL.
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


-- 9.2 v_cola_despacho · LA cola de cocina. Global, todas las mesas juntas,
-- estrictamente por orden de llegada. Trae las líneas embebidas porque es la
-- consulta que el KDS repite cada pocos segundos y un N+1 ahí se nota.
CREATE VIEW "v_cola_despacho" WITH (security_invoker = true) AS
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


-- 9.3 v_cuenta_mesa · "cuentas por cobrar" y la ficha de la mesa ocupada.
-- Una fila por mesa con cuenta viva. El menú de cuentas por cobrar filtra
-- `comandas_por_cobrar > 0`; la ficha de una mesa filtra por `mesa_id`.
-- Se llama v_cuenta_mesa y no v_cuenta_por_cobrar porque también contiene lo
-- que todavía está en cocina — y esa cifra es justo la que el cajero necesita
-- ver antes de cerrar la cuenta.
CREATE VIEW "v_cuenta_mesa" WITH (security_invoker = true) AS
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


-- 9.4 v_venta_dia · la venta se reconoce cuando ENTRA EL DINERO, y el dinero
-- entra por un cobro. Por eso agrupa por `cobro.fecha_operativa` (calculada al
-- cobrar) y no por la de la comanda: el cierre de caja tiene que cuadrar con
-- lo que hay en la gaveta al final del turno.
--
-- La columna `comandas` del modelo viejo NO tiene sucesora aquí, y es a
-- propósito. Contaba comandas cuando una comanda ERA la cuenta de la mesa; hoy
-- ese número es `cobros` (facturas emitidas = mesas atendidas) y es el
-- denominador correcto del ticket promedio. Contar además los pedidos costaba
-- un LATERAL por cobro: medido, 198 ms contra 24 ms sobre 21.900 cobros, y
-- creciendo con el histórico. "Cuántos pedidos salieron" es una pregunta
-- operativa distinta, que se responde por `comanda.despachada_en` —el día en
-- que la cocina trabajó— y no por el día en que el cliente pagó.
CREATE VIEW "v_venta_dia" WITH (security_invoker = true) AS
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


-- 9.5 v_venta_dia_metodo · cuadre de caja por método de pago.
CREATE VIEW "v_venta_dia_metodo" WITH (security_invoker = true) AS
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


-- 9.6 v_producto_vendido_dia · el día y el turno salen del COBRO, igual que
-- v_venta_dia. Si uno usara la fecha de la comanda y el otro la del cobro, la
-- suma de los productos de un día dejaría de dar la venta de ese día en las
-- noches que cruzan la hora de corte.
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
JOIN "comanda" c
  ON c."restaurante_id" = ci."restaurante_id" AND c."id" = ci."comanda_id"
JOIN "cobro" cb
  ON cb."restaurante_id" = c."restaurante_id" AND cb."id" = c."cobro_id"
WHERE cb."anulado_en"  IS NULL
  AND ci."cancelado_en" IS NULL
GROUP BY cb."restaurante_id", cb."fecha_operativa", cb."turno",
         ci."producto_id", ci."nombre_snap";


-- 9.7 v_cobro_descuadre · sustituye a v_comanda_descuadre. Debe dar 0 filas.
CREATE VIEW "v_cobro_descuadre" WITH (security_invoker = true) AS
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
