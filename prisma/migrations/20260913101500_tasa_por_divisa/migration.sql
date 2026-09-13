-- ═══════════════════════════════════════════════════════════════════════════
-- TASA DE CAMBIO POR DIVISA — dólar (BCV) y euro ("tasa central")
--
-- Autor: J.O.R.B.I (data-engineer) · 2026-09-13
-- Justificación completa: docs/DECISIONES-DATOS.md §D13/§D14 y §10.
--
-- QUÉ CAMBIA
--   · Enum nuevo `divisa` ('USD','EUR'). NO se toca el enum `moneda`, que
--     sigue siendo el dominio del COBRO (USD/BS). Son cosas distintas.
--   · `tasa_cambio.divisa` NOT NULL DEFAULT 'USD'. Las filas existentes son
--     todas cotizaciones del dólar (la columna no existía), así que el
--     backfill por default es exacto, no una suposición.
--   · `tasa_cambio_dia_unica` pasa de (restaurante_id, fecha, fuente) a
--     (restaurante_id, divisa, fecha, fuente). Con todas las filas viejas en
--     'USD' no puede haber duplicados: el aviso de Prisma es falso aquí.
--
-- ⚠️ INVENTARIO DE DDL A MANO QUE VIVE EN ESTE ARCHIVO
--    (copiado de prisma/sql/01_constraints_y_triggers.sql §7 — esa es la
--     fuente canónica; si se edita allí, se edita aquí)
--      · función hayai_comanda_tasa_base      + trigger comanda_tasa_base
--      · función hayai_tasa_divisa_inmutable  + trigger tasa_divisa_inmutable
--    Prisma no modela triggers ni funciones: sobreviven solos al diff.
--    `npm run db:verify` falla si alguno desaparece.
--
-- ⚠️ ESTA MIGRACIÓN Y EL CÓDIGO VAN JUNTOS
--    Aplicarla sola es seguro (no crea ninguna fila de euro). Lo que NO es
--    seguro es registrar la primera tasa de euro con el backend viejo: sus
--    consultas de tasa no filtran divisa. Los triggers de aquí convierten ese
--    bug de dinero en un 422, pero el orden correcto es desplegar el backend
--    con el filtro `divisa: 'USD'` ANTES de exponer el alta de euro.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1 · Lo generado por Prisma
--     (`prisma migrate diff --from-config-datasource --to-schema ... --script`)
--
-- Se omitió a propósito un `ALTER TABLE "restaurante" ALTER COLUMN
-- "hora_corte_dia" SET DEFAULT '05:00'::time` que el diff emite en cada
-- corrida: es ruido idempotente de `dbgenerated()`, no pertenece a este
-- cambio y mezclarlo aquí haría ilegible la migración.
-- ───────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "divisa" AS ENUM ('USD', 'EUR');

-- DropIndex
DROP INDEX "tasa_cambio_dia_unica";

-- AlterTable
-- En PostgreSQL 11+ un ADD COLUMN con default no volátil es metadato puro:
-- no reescribe la tabla y no bloquea más que un instante.
ALTER TABLE "tasa_cambio" ADD COLUMN     "divisa" "divisa" NOT NULL DEFAULT 'USD';

-- CreateIndex
-- `divisa` en segunda posición: el prefijo (restaurante_id, divisa) hace que
-- este mismo índice resuelva "la tasa vigente del euro" sin un índice extra.
CREATE UNIQUE INDEX "tasa_cambio_dia_unica" ON "tasa_cambio"("restaurante_id", "divisa", "fecha", "fuente");


-- ───────────────────────────────────────────────────────────────────────────
-- 2 · DDL a mano — prisma/sql/01_constraints_y_triggers.sql §7
--
-- EL RIESGO CONCRETO que estos dos triggers cierran:
-- el código que elige la tasa para cobrar hacía
--   `findFirst({ where: { restauranteId }, orderBy: { fecha: 'desc' } })`
-- sin filtrar divisa. En cuanto existe una fila de euro del mismo día, ESA
-- consulta puede devolver el euro, y `montoUsd = monto / tasa.valor` convierte
-- cada bolívar recibido con la cotización equivocada. El error es de ~8-15 %
-- (lo que separa al euro del dólar), no revienta nada y no se nota hasta que
-- el cierre de caja lleva días sin cuadrar.
--
-- Se resuelve con triggers y NO con una columna `comanda.tasa_divisa` + FK
-- compuesta por la misma razón que en §4 del archivo canónico: una columna
-- copiada crea un segundo problema —mantenerla sincronizada— y aquí además
-- cambiaría el contrato de `Comanda` hacia el frontend a cambio de nada.
-- ───────────────────────────────────────────────────────────────────────────

-- ⭐⭐ Una comanda sólo congela tasas de la divisa BASE (USD).
-- 'USD' va literal, igual que en `pago_tasa_coherente`: la moneda base es un
-- invariante del producto, no un parámetro. Si algún día un restaurante opera
-- con otra base, se cambia aquí y en ese CHECK a la vez, a propósito.
CREATE OR REPLACE FUNCTION "hayai_comanda_tasa_base"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_divisa "divisa";
BEGIN
  IF NEW."tasa_id" IS NULL THEN
    RETURN NEW;
  END IF;

  -- Salida temprana. La comanda se UPDATEa en cada ronda (recálculo de
  -- totales) y sólo interesa mirar cuando `tasa_id` entra o cambia; así el
  -- SELECT extra ocurre una vez por cobro y no en el camino caliente.
  -- El TG_OP es obligatorio: en un trigger de INSERT, OLD no está asignado y
  -- leer OLD."tasa_id" sería un error de ejecución de plpgsql.
  IF TG_OP = 'UPDATE' AND NEW."tasa_id" IS NOT DISTINCT FROM OLD."tasa_id" THEN
    RETURN NEW;
  END IF;

  SELECT t."divisa" INTO v_divisa
    FROM "tasa_cambio" t
   WHERE t."restaurante_id" = NEW."restaurante_id"
     AND t."id"             = NEW."tasa_id";

  -- Si no hay fila, NO se lanza aquí: que hable la FK compuesta
  -- (`comanda_restaurante_id_tasa_id_fkey`, 23503), cuyo mensaje es el correcto
  -- para "esa tasa no existe o es de otro restaurante".
  IF v_divisa IS NOT NULL AND v_divisa <> 'USD'::"divisa" THEN
    RAISE EXCEPTION
      'La comanda % intenta congelar una tasa de %; el cobro sólo admite la divisa base (USD)',
      NEW."id", v_divisa
      USING ERRCODE = '23514', CONSTRAINT = 'comanda_tasa_base';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "comanda_tasa_base"
  BEFORE INSERT OR UPDATE ON "comanda"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_comanda_tasa_base"();

-- La divisa de una tasa es inmutable. Sin esto, el trigger de arriba tiene una
-- puerta trasera: se congela una tasa USD en la comanda y DESPUÉS alguien hace
-- `UPDATE tasa_cambio SET divisa='EUR'`. La comanda ya cobrada quedaría
-- apuntando a una cotización de euro y el trigger de `comanda` no se entera,
-- porque no se escribe en `comanda`.
-- Además es la regla correcta por sí sola: una cotización del dólar no se
-- "convierte" en una del euro; se registra otra fila.
CREATE OR REPLACE FUNCTION "hayai_tasa_divisa_inmutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."divisa" IS DISTINCT FROM OLD."divisa" THEN
    RAISE EXCEPTION
      'La divisa de una tasa registrada no se cambia (% → %); registra otra fila',
      OLD."divisa", NEW."divisa"
      USING ERRCODE = '23514', CONSTRAINT = 'tasa_divisa_inmutable';
  END IF;
  RETURN NEW;
END;
$$;

-- `BEFORE UPDATE` a secas, sin `OF "divisa"`: la tabla recibe un par de
-- escrituras al día y no vale la pena depender de la sutileza de cuándo
-- dispara un `UPDATE OF`.
CREATE TRIGGER "tasa_divisa_inmutable"
  BEFORE UPDATE ON "tasa_cambio"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_tasa_divisa_inmutable"();
