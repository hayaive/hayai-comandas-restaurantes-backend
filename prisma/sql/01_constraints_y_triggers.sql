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

-- ⚠️ AQUÍ VIVÍA `comanda_mesa_activa_unica` (UNA cuenta viva por mesa).
-- Murió con el rediseño de comandas múltiples (migración
-- 20260915183000_comandas_multiples_y_cobro): ahora cada envío a cocina es una
-- comanda propia y una mesa tiene N vivas a la vez. Su sucesor sin el UNIQUE es
-- `comanda_cuenta_abierta_idx` (que a su vez murió el 2026-11-05: hoy la cuenta
-- es del cliente y la sirven `comanda_item_deuda_idx` y `cliente_abierto_idx`,
-- en §2). Tampoco hay unicidad de cliente por mesa: dos cuentas separadas en
-- la misma mesa son legales.
-- No se reintroduce: si alguien lo recrea, la segunda comanda de una mesa
-- empieza a fallar con 23505 en plena cena.


-- ───────────────────────────────────────────────────────────────────────────
-- 2 · Índices parciales de operación
-- Cubren las pantallas que se consultan cada pocos segundos.
-- ───────────────────────────────────────────────────────────────────────────

-- ⭐ Cola de despacho GLOBAL (KDS), estrictamente por orden de llegada.
-- Índice diminuto: sólo contiene lo que la cocina todavía no sacó, y ya viene
-- ordenado, así que la pantalla del KDS es una lectura secuencial del índice.
-- Sustituye a `comanda_item_cocina_idx`: la cola ya no es por ítem, porque
-- cocina y barra despachan la comanda como una sola unidad.
CREATE INDEX "comanda_cola_despacho_idx"
  ON "comanda" ("restaurante_id", "creada_en")
  WHERE "despachada_en" IS NULL AND "anulada_en" IS NULL;

-- ⚠️ AQUÍ VIVÍA `comanda_cuenta_abierta_idx` (comandas sin cobrar por mesa).
-- Murió con `comanda.cobro_id` en la migración 20261105120100: la factura pasó
-- a la LÍNEA y la cuenta, al CLIENTE (docs/DECISIONES-DATOS.md §15). Sus
-- sucesores son los tres de abajo.

-- ⭐ La deuda viva: líneas sin factura y sin cancelar, por deudor. Diminuto:
-- sólo lo que está por cobrar AHORA. Sirve a `v_cuenta_cliente`, a
-- `v_mesa_estado` y al cierre del cliente.
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

-- Agenda de reservas: sólo las que todavía pueden ocupar una mesa.
CREATE INDEX "reservacion_agenda_idx"
  ON "reservacion" ("restaurante_id", "inicia_en")
  WHERE "estado" IN ('pendiente', 'confirmada');


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
  ADD CONSTRAINT "comanda_item_descuento_valido" CHECK ("descuento_linea" >= 0),
  -- La traza de cancelación sólo existe si hubo cancelación.
  ADD CONSTRAINT "comanda_item_cancelacion_coherente" CHECK (
    "cancelado_en" IS NOT NULL OR ("cancelado_por_id" IS NULL AND "motivo_cancelacion" IS NULL)
  ),
  -- (2026-11-05) `total_linea` es lo que suma el subtotal de la factura: no
  -- puede mentir. La migración lo crea NOT VALID + VALIDATE que perdona, para
  -- no caerse en el deploy si hay líneas históricas mal calculadas.
  ADD CONSTRAINT "comanda_item_total_coherente"
    CHECK ("total_linea" = round("cantidad" * "precio_unitario_snap" - "descuento_linea", 4));

-- (2026-11-05) Una comanda puede no tener mesa aunque se consuma en el local:
-- el cliente no está sentado. Lo que no puede es tener mesa sin salón ni
-- plantilla, ni ser para llevar con mesa.
ALTER TABLE "comanda"
  ADD CONSTRAINT "comanda_tipo_coherente" CHECK (
    ("mesa_id" IS NULL OR ("salon_id" IS NOT NULL AND "plantilla_id" IS NOT NULL))
    AND ("tipo" = 'mesa' OR "mesa_id" IS NULL)
  ),
  -- `comanda.total` es sólo la suma de sus líneas vivas. Descuento, impuesto y
  -- propina se negocian sobre la cuenta de la mesa y viven en `cobro`, así que
  -- el viejo `comanda_totales_validos` (que los cubría a los cinco) se partió
  -- en esto y en `cobro_totales_validos`.
  ADD CONSTRAINT "comanda_total_valido" CHECK ("total" >= 0),
  -- ⚠️ `comanda_anulada_no_cobrada` y `comanda_cobro_tras_despacho` eran CHECK
  -- sobre `comanda.cobro_id`. Desde 2026-11-05 la factura vive en la línea y
  -- las dos reglas cruzan tablas: las hacen `comanda_estado` (§8) y
  -- `comanda_item_editable` (§9), que lanzan el error con el MISMO nombre.
  -- La traza de anulación sólo existe si hubo anulación.
  ADD CONSTRAINT "comanda_anulacion_coherente" CHECK (
    "anulada_en" IS NOT NULL OR ("anulada_por_id" IS NULL AND "motivo_anulacion" IS NULL)
  ),
  -- Nombre del cliente normalizado (migración 20260919100000, DECISIONES-DATOS §14).
  -- Sin tope de longitud a propósito: el tope de 120 vive en los DTOs.
  ADD CONSTRAINT "comanda_cliente_nombre_normalizado" CHECK ("cliente_nombre" IS NULL OR (length("cliente_nombre") > 0 AND "cliente_nombre" = btrim("cliente_nombre")));

-- La factura consolidada.
ALTER TABLE "cobro"
  ADD CONSTRAINT "cobro_totales_validos" CHECK (
    "subtotal" >= 0 AND "descuento" >= 0 AND "impuesto" >= 0 AND "propina" >= 0
    AND "total" >= 0 AND "total_bs" >= 0
  ),
  -- Si hay mesa, hay salón. Un cobro sin mesa es una comanda para llevar.
  ADD CONSTRAINT "cobro_tipo_coherente" CHECK (
    ("mesa_id" IS NOT NULL AND "salon_id" IS NOT NULL) OR "mesa_id" IS NULL
  ),
  ADD CONSTRAINT "cobro_anulacion_coherente" CHECK (
    "anulado_en" IS NOT NULL OR ("anulado_por_id" IS NULL AND "motivo_anulacion" IS NULL)
  ),
  ADD CONSTRAINT "cobro_cliente_nombre_normalizado" CHECK ("cliente_nombre" IS NULL OR (length("cliente_nombre") > 0 AND "cliente_nombre" = btrim("cliente_nombre")));

-- Pago móvil y transferencia sin referencia = un pago que no se puede conciliar
-- con el banco. Se bloquea en la base, no en el formulario.
-- (Los tres CHECKs se llamaban `pago_*` cuando la tabla era `comanda_pago`.)
-- (2026-11-05) Negativo = devolución. Nunca 0, y los dos montos con el mismo signo.
ALTER TABLE "cobro_pago"
  ADD CONSTRAINT "cobro_pago_monto_valido" CHECK (
    ("monto" > 0 AND "monto_usd" > 0) OR ("monto" < 0 AND "monto_usd" < 0)
  ),
  ADD CONSTRAINT "cobro_pago_referencia_obligatoria" CHECK (
    "metodo" NOT IN ('pago_movil', 'transferencia') OR (length(btrim(coalesce("referencia", ''))) > 0)
  ),
  -- USD es la moneda base: no lleva tasa. Bs siempre la lleva.
  ADD CONSTRAINT "cobro_pago_tasa_coherente" CHECK (
    ("moneda" = 'USD' AND "tasa_aplicada" IS NULL)
    OR
    ("moneda" = 'BS'  AND "tasa_aplicada" IS NOT NULL AND "tasa_aplicada" > 0)
  );

ALTER TABLE "tasa_cambio"
  ADD CONSTRAINT "tasa_valor_valido" CHECK ("valor" > 0);

-- (2026-11-05) El cliente: nombre normalizado y traza de cierre coherente.
ALTER TABLE "cliente"
  ADD CONSTRAINT "cliente_nombre_normalizado" CHECK (length("nombre") > 0 AND "nombre" = btrim("nombre")),
  ADD CONSTRAINT "cliente_cierre_coherente" CHECK ("cerrado_en" IS NOT NULL OR "cerrado_por_id" IS NULL);


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

-- Fin de un acceso temporal (añadido 2026-09-18, migración
-- 20260918230000_accesos_temporales). Copia de DOCUMENTACIÓN: la fuente es la
-- migración. Los atajos de duración son días OPERATIVOS: el acceso vence en la
-- hora de corte, cuando el local está cerrado, nunca en mitad de una cena.
CREATE OR REPLACE FUNCTION "hayai_fin_acceso"(
  momento  timestamptz,
  zona     text,
  corte    time,
  duracion interval
)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT (("hayai_fecha_operativa"(momento, zona, corte) + duracion)::date + corte)
         AT TIME ZONE zona;
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

-- ⭐⭐ Un cobro sólo congela tasas de la divisa BASE (USD).
-- 'USD' va literal, igual que en `cobro_pago_tasa_coherente`: la moneda base es
-- un invariante del producto, no un parámetro. Si algún día un restaurante
-- opera con otra base, se cambia aquí y en ese CHECK a la vez, a propósito.
--
-- ⚠️ Este trigger vivía en `comanda` y se llamaba `comanda_tasa_base`. Viajó a
-- `cobro` en la migración 20260915183000, que es donde pasó a congelarse la
-- tasa. El invariante es idéntico; si se perdiera en el traslado, el agujero
-- de §10.4 de DECISIONES-DATOS se reabre sin que nada falle.
CREATE OR REPLACE FUNCTION "hayai_cobro_tasa_base"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_divisa "divisa";
BEGIN
  -- Salida temprana: sólo interesa mirar cuando `tasa_id` entra o cambia, así
  -- el SELECT extra ocurre una vez por cobro y no al anular o editar notas.
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
  -- (`cobro_restaurante_id_tasa_id_fkey`, 23503), cuyo mensaje es el correcto
  -- para "esa tasa no existe o es de otro restaurante".
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
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_cobro_tasa_base"();

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


-- ───────────────────────────────────────────────────────────────────────────
-- 8 a 13 · Cliente, factura por líneas y correcciones auditadas   (2026-11-05)
--
-- Copia de DOCUMENTACIÓN: la fuente es la migración
-- 20261105120100_cliente_y_facturacion_por_lineas (§6 y §9, numeración de la
-- migración). Sustituye a los antiguos §8 (comanda_estado sobre cobro_id),
-- §9 (comanda_item_solo_pendiente) y §10 (cobro_no_vacio). El porqué, en
-- docs/DECISIONES-DATOS.md §15.
--
-- ⚠️ Los tres triggers *_cobro_coherente van AL FINAL de cualquier migración
-- que haga UPDATE masivo: diferidos, cada fila tocada deja un evento pendiente
-- que prohíbe los ALTER TABLE siguientes y se verifica entero al COMMIT.
-- ───────────────────────────────────────────────────────────────────────────

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
