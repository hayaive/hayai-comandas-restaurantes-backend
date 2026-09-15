-- ═══════════════════════════════════════════════════════════════════════════
-- 01 · Invariantes que Prisma no sabe declarar
--
-- Va AL FINAL del `migration.sql` de fundación, después de los CREATE TABLE.
--
-- ⚠️ REGLA DE ORO PARA D.A.N.I
-- Prisma modela tablas, columnas, índices y FKs; NO modela índices PARCIALES,
-- índices por EXPRESIÓN, CHECKs, EXCLUDE, triggers, funciones ni vistas.
-- Consecuencia práctica en cada `prisma migrate dev` posterior:
--   · Lo que Prisma no modela (CHECK, EXCLUDE, trigger, función, vista) lo
--     IGNORA: sobrevive solo.
--   · Los índices SÍ los modela. Un índice que existe en la base y no en
--     schema.prisma le parece basura y emite `DROP INDEX`.
-- Por eso: SIEMPRE generar con `--create-only`, LEER el SQL, y borrar a mano
-- cualquier DROP INDEX que apunte a un objeto de este archivo.
-- `99_verificar_objetos.sql` es la red de seguridad: correrlo en CI.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1 · Unicidad real del negocio (índices únicos PARCIALES y por EXPRESIÓN)
--
-- Todos son "único entre las filas vivas". Con un UNIQUE normal no se podría
-- reutilizar el nombre de una mesa borrada, que es justo lo que un restaurante
-- hace todo el tiempo.
-- ───────────────────────────────────────────────────────────────────────────

-- "Mesa 5" es una sola en todo el restaurante, aunque haya varios salones:
-- el mesero canta el número, no el salón. Case-insensitive.
CREATE UNIQUE INDEX "mesa_etiqueta_unica"
  ON "mesa" ("restaurante_id", lower("etiqueta"))
  WHERE "eliminada_en" IS NULL;

CREATE UNIQUE INDEX "salon_nombre_unico"
  ON "salon" ("restaurante_id", lower("nombre"))
  WHERE "eliminado_en" IS NULL;

CREATE UNIQUE INDEX "categoria_nombre_unica"
  ON "categoria" ("restaurante_id", lower("nombre"))
  WHERE "eliminada_en" IS NULL;

CREATE UNIQUE INDEX "producto_nombre_unico"
  ON "producto" ("restaurante_id", lower("nombre"))
  WHERE "activo";

CREATE UNIQUE INDEX "producto_codigo_unico"
  ON "producto" ("restaurante_id", lower("codigo"))
  WHERE "codigo" IS NOT NULL AND "activo";

-- ⭐ UNA sola plantilla activa por salón. Es el requisito "plantilla activa"
-- convertido en algo que la base hace cumplir: activar una segunda plantilla
-- del mismo salón falla, en vez de dejar el plano en un estado ambiguo.
-- El servicio hace UPDATE ... SET activa=false (la vieja) + true (la nueva)
-- en UNA transacción; el índice garantiza que no queden dos.
CREATE UNIQUE INDEX "plantilla_activa_unica"
  ON "plantilla" ("restaurante_id", "salon_id")
  WHERE "activa";

-- ⭐⭐ EL invariante de comandas: UNA cuenta viva por mesa.
-- Sin esto, dos meseros abriendo la misma mesa a la vez crean dos comandas y
-- el cliente paga una sola. No es prevenible de forma fiable en la aplicación
-- (dos procesos, dos transacciones), y aquí además es el índice que sirve al
-- panel lateral: contiene SOLO las mesas ocupadas ahora mismo, así que
-- "listar comandas activas" lee un índice diminuto, no la tabla histórica.
CREATE UNIQUE INDEX "comanda_mesa_activa_unica"
  ON "comanda" ("restaurante_id", "mesa_id")
  WHERE "mesa_id" IS NOT NULL AND "estado" IN ('abierta', 'por_cobrar');


-- ───────────────────────────────────────────────────────────────────────────
-- 2 · Índices parciales de operación
-- Cubren las tres pantallas que se consultan cada pocos segundos.
-- ───────────────────────────────────────────────────────────────────────────

-- Cola de cocina / barra (KDS): sólo lo que falta por despachar.
CREATE INDEX "comanda_item_cocina_idx"
  ON "comanda_item" ("restaurante_id", "destino_snap", "enviado_en")
  WHERE "estado" IN ('pendiente', 'en_preparacion');

-- Agenda de reservas: sólo las que todavía pueden ocupar una mesa.
CREATE INDEX "reservacion_agenda_idx"
  ON "reservacion" ("restaurante_id", "inicia_en")
  WHERE "estado" IN ('pendiente', 'confirmada');

-- Comandas por cobrar: el cajero las pide constantemente.
CREATE INDEX "comanda_por_cobrar_idx"
  ON "comanda" ("restaurante_id", "abierta_en")
  WHERE "estado" = 'por_cobrar';


-- ───────────────────────────────────────────────────────────────────────────
-- 3 · Reservaciones: rango temporal y prohibición de solape
--
-- `periodo` es tstzrange y lo mantiene un trigger. No se puede usar una
-- columna GENERATED porque `timestamptz + interval` es STABLE (depende del
-- huso horario por el horario de verano), y una columna generada exige
-- IMMUTABLE: Postgres rechaza la definición.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "hayai_reservacion_periodo"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Se valida aquí y no sólo con el CHECK porque `tstzrange()` con los límites
  -- invertidos lanza un 22000 genérico ANTES de que el CHECK llegue a
  -- evaluarse, y el backend no podría distinguirlo de cualquier otro error de
  -- datos. Con ERRCODE 23514 el caso se traduce a 422 como el resto.
  IF NEW."termina_en" <= NEW."inicia_en" THEN
    RAISE EXCEPTION 'La reserva termina (%) antes o a la misma hora que empieza (%)',
      NEW."termina_en", NEW."inicia_en"
      USING ERRCODE = '23514', CONSTRAINT = 'reservacion_rango_valido';
  END IF;

  -- '[)' : el que sale a las 21:00 no choca con el que entra a las 21:00.
  NEW."periodo" := tstzrange(NEW."inicia_en", NEW."termina_en", '[)');
  RETURN NEW;
END;
$$;

CREATE TRIGGER "reservacion_periodo"
  BEFORE INSERT OR UPDATE ON "reservacion"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_reservacion_periodo"();

-- ⭐⭐ Doble reserva imposible, a nivel de base de datos.
-- La alternativa en aplicación exige SERIALIZABLE o advisory locks y falla
-- justo cuando importa: dos reservas del sábado 8pm entrando a la vez por el
-- enlace público. Aquí la segunda recibe un error 23P01 y se traduce a un
-- 409 "esa mesa ya está reservada a esa hora".
-- Sólo aplica a los estados que ocupan la mesa: una cancelada o un no-show
-- liberan el hueco automáticamente.
ALTER TABLE "reservacion"
  ADD CONSTRAINT "reservacion_sin_solape"
  EXCLUDE USING gist (
    "restaurante_id" WITH =,
    "mesa_id"        WITH =,
    "periodo"        WITH &&
  )
  WHERE ("mesa_id" IS NOT NULL AND "estado" IN ('pendiente', 'confirmada', 'sentada'));


-- ───────────────────────────────────────────────────────────────────────────
-- 4 · Coherencia mesa ↔ salón ↔ plantilla
--
-- Una plantilla pertenece a un salón y una mesa también, pero la FK de
-- `plantilla_mesa` no puede comprobar que sean el MISMO salón. Sin esto se
-- puede colocar una mesa de la terraza dentro del plano del salón principal.
--
-- Se resuelve con trigger y no duplicando `salon_id` en `plantilla_mesa`
-- porque una columna copiada crearía un segundo problema: mantenerla
-- sincronizada cuando una mesa se mueve de salón.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "hayai_plantilla_mesa_mismo_salon"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_salon_plantilla uuid;
  v_salon_mesa      uuid;
BEGIN
  SELECT "salon_id" INTO v_salon_plantilla
    FROM "plantilla"
   WHERE "restaurante_id" = NEW."restaurante_id" AND "id" = NEW."plantilla_id";

  SELECT "salon_id" INTO v_salon_mesa
    FROM "mesa"
   WHERE "restaurante_id" = NEW."restaurante_id" AND "id" = NEW."mesa_id";

  IF v_salon_plantilla IS DISTINCT FROM v_salon_mesa THEN
    RAISE EXCEPTION
      'La mesa % pertenece al salon % y la plantilla % al salon %',
      NEW."mesa_id", v_salon_mesa, NEW."plantilla_id", v_salon_plantilla
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "plantilla_mesa_mismo_salon"
  BEFORE INSERT OR UPDATE OF "plantilla_id", "mesa_id" ON "plantilla_mesa"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_plantilla_mesa_mismo_salon"();

-- Y por el otro lado: no se puede mudar una mesa de salón mientras siga
-- dibujada en plantillas del salón anterior. Primero se quita del plano.
CREATE OR REPLACE FUNCTION "hayai_mesa_cambio_salon"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_en_plantillas int;
BEGIN
  IF NEW."salon_id" IS DISTINCT FROM OLD."salon_id" THEN
    SELECT count(*) INTO v_en_plantillas
      FROM "plantilla_mesa" pm
     WHERE pm."restaurante_id" = NEW."restaurante_id" AND pm."mesa_id" = NEW."id";

    IF v_en_plantillas > 0 THEN
      RAISE EXCEPTION
        'La mesa % está en % plantilla(s); quítala del plano antes de cambiarla de salón',
        NEW."etiqueta", v_en_plantillas
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "mesa_cambio_salon"
  BEFORE UPDATE OF "salon_id" ON "mesa"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_mesa_cambio_salon"();


-- ───────────────────────────────────────────────────────────────────────────
-- 5 · CHECKs de dominio
-- Prisma no los modela, así que sobreviven a las migraciones sin tocarlos.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE "plantilla_mesa"
  ADD CONSTRAINT "plantilla_mesa_capacidad_valida" CHECK ("capacidad" BETWEEN 1 AND 50),
  ADD CONSTRAINT "plantilla_mesa_rotacion_valida"  CHECK ("rotacion" BETWEEN 0 AND 359),
  ADD CONSTRAINT "plantilla_mesa_tamano_valido"    CHECK ("ancho" > 0 AND "alto" > 0),
  ADD CONSTRAINT "plantilla_mesa_posicion_valida"  CHECK ("pos_x" >= 0 AND "pos_y" >= 0);

ALTER TABLE "mesa"
  ADD CONSTRAINT "mesa_capacidad_valida" CHECK ("capacidad_default" BETWEEN 1 AND 50),
  ADD CONSTRAINT "mesa_etiqueta_no_vacia" CHECK (length(btrim("etiqueta")) > 0);

ALTER TABLE "plantilla"
  ADD CONSTRAINT "plantilla_plano_valido" CHECK ("ancho_plano" > 0 AND "alto_plano" > 0),
  -- Borrado lógico: una plantilla eliminada no puede ser a la vez la activa
  -- del salón. Cierra la puerta trasera de reactivar una plantilla borrada
  -- con un UPDATE directo a "activa" que se salte `PlantillasService`.
  ADD CONSTRAINT "plantilla_eliminada_no_activa" CHECK ("eliminada_en" IS NULL OR NOT "activa");

ALTER TABLE "reservacion"
  ADD CONSTRAINT "reservacion_rango_valido" CHECK ("termina_en" > "inicia_en"),
  ADD CONSTRAINT "reservacion_personas_valida" CHECK ("personas" BETWEEN 1 AND 200);

ALTER TABLE "producto"
  ADD CONSTRAINT "producto_precio_valido" CHECK ("precio" >= 0),
  ADD CONSTRAINT "producto_costo_valido"  CHECK ("costo" IS NULL OR "costo" >= 0);

ALTER TABLE "comanda_item"
  ADD CONSTRAINT "comanda_item_cantidad_valida" CHECK ("cantidad" > 0),
  ADD CONSTRAINT "comanda_item_precio_valido"   CHECK ("precio_unitario_snap" >= 0),
  ADD CONSTRAINT "comanda_item_descuento_valido" CHECK ("descuento_linea" >= 0);

-- Una comanda de mesa necesita mesa, salón y plantilla; una de para llevar,
-- ninguna de las tres. Sin esto aparecen comandas de mesa sin mesa, que es el
-- estado que rompe el panel lateral.
ALTER TABLE "comanda"
  ADD CONSTRAINT "comanda_tipo_coherente" CHECK (
    ("tipo" = 'mesa'        AND "mesa_id" IS NOT NULL AND "salon_id" IS NOT NULL AND "plantilla_id" IS NOT NULL)
    OR
    ("tipo" = 'para_llevar' AND "mesa_id" IS NULL)
  ),
  ADD CONSTRAINT "comanda_totales_validos" CHECK (
    "subtotal" >= 0 AND "descuento" >= 0 AND "impuesto" >= 0 AND "propina" >= 0 AND "total" >= 0
  ),
  ADD CONSTRAINT "comanda_cierre_coherente" CHECK (
    ("estado" IN ('cobrada', 'anulada') AND "cerrada_en" IS NOT NULL)
    OR
    ("estado" IN ('abierta', 'por_cobrar') AND "cerrada_en" IS NULL)
  ),
  -- Si se cobró, la tasa quedó congelada. Reimprimir el ticket un mes después
  -- tiene que dar el mismo monto en bolívares.
  ADD CONSTRAINT "comanda_tasa_congelada" CHECK (
    "estado" <> 'cobrada' OR ("tasa_valor" IS NOT NULL AND "total_bs" IS NOT NULL)
  );

-- Pago móvil y transferencia sin referencia = un pago que no se puede conciliar
-- con el banco. Se bloquea en la base, no en el formulario.
ALTER TABLE "comanda_pago"
  ADD CONSTRAINT "pago_monto_valido" CHECK ("monto" > 0 AND "monto_usd" > 0),
  ADD CONSTRAINT "pago_referencia_obligatoria" CHECK (
    "metodo" NOT IN ('pago_movil', 'transferencia') OR (length(btrim(coalesce("referencia", ''))) > 0)
  ),
  -- USD es la moneda base: no lleva tasa. Bs siempre la lleva.
  ADD CONSTRAINT "pago_tasa_coherente" CHECK (
    ("moneda" = 'USD' AND "tasa_aplicada" IS NULL)
    OR
    ("moneda" = 'BS'  AND "tasa_aplicada" IS NOT NULL AND "tasa_aplicada" > 0)
  );

ALTER TABLE "tasa_cambio"
  ADD CONSTRAINT "tasa_valor_valido" CHECK ("valor" > 0);


-- ───────────────────────────────────────────────────────────────────────────
-- 6 · Día operativo y turno
--
-- El día contable NO es `creado_en::date`. Un restaurante que cierra a las 2am
-- factura esa mesa al día anterior; si se deriva del UTC, además, el corte cae
-- a las 20:00 hora de Caracas y parte el servicio de la cena en dos días.
--
-- Estas funciones son la ÚNICA definición del día operativo. El backend las
-- llama al abrir la comanda (`SELECT hayai_fecha_operativa(...)`) en vez de
-- reimplementar la regla en TypeScript, para que reportes y app no diverjan.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "hayai_fecha_operativa"(
  momento timestamptz,
  zona    text,
  corte   time
)
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT ((momento AT TIME ZONE zona) - corte::interval)::date;
$$;

CREATE OR REPLACE FUNCTION "hayai_turno"(
  momento timestamptz,
  zona    text
)
RETURNS "turno_servicio"
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
           WHEN h >= 5  AND h < 11 THEN 'desayuno'
           WHEN h >= 11 AND h < 17 THEN 'almuerzo'
           WHEN h >= 17            THEN 'cena'
           ELSE 'madrugada'
         END::"turno_servicio"
  FROM (SELECT extract(hour FROM (momento AT TIME ZONE zona))::int AS h) t;
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- 7 · Tasa por divisa: el euro no puede cobrar          (añadido 2026-09-13)
--
-- `tasa_cambio` pasó a cotizar VARIAS divisas (USD y EUR, "tasa central" del
-- BCV). El cobro, en cambio, sigue siendo estrictamente USD/Bs: el euro es
-- informativo, nadie paga en euros todavía.
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
-- compuesta por la misma razón que en §4: una columna copiada crea un segundo
-- problema —mantenerla sincronizada— y aquí además cambiaría el contrato de
-- `Comanda` hacia el frontend a cambio de nada.
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
