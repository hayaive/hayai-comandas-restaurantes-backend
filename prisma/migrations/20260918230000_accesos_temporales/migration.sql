-- ═══════════════════════════════════════════════════════════════════════════
-- ACCESOS TEMPORALES · menú "Meseros"
--
-- Diseño de datos: J.O.R.B.I (data-engineer), verificado contra PostgreSQL
-- 17.10 real antes de escribirse aquí. La justificación completa está en
-- docs/DECISIONES-DATOS.md §13.
--
-- QUÉ RESUELVE
-- El dueño da acceso temporal a alguien: nombre, duración (hoy / 2 días /
-- 1 semana / 1 mes) y qué pantallas ve. Le manda por WhatsApp un enlace único
-- y un código de 4 dígitos; el mesero abre ESE enlace, teclea el código y
-- entra. Al vencer deja de entrar y desaparece de la lista, pero sus comandas
-- y cobros siguen a su nombre para cuadrar caja.
--
-- EL MODELO EN TRES FRASES
--   1. La persona es un `usuario` más, con `acceso_hasta`. Todo lo que haga
--      queda atribuido por las FK de siempre, y "desaparecer de la lista" es
--      un filtro por fecha: ni borrado, ni job, ni columna de estado.
--   2. La credencial (enlace + código) vive aparte, en `invitacion_acceso`, y
--      sólo como hash.
--   3. `usuario.modulos` es la ÚNICA autoridad sobre qué pantallas ve quien no
--      es administrador. `rol` sólo decide si lo es.
--
-- LAS DECISIONES DEL DUEÑO QUE ESTA MIGRACIÓN CONVIERTE EN INVARIANTES
--   · "El código sólo existe dentro de su enlace": un acceso temporal no puede
--     tener PIN ni clave (`usuario_credenciales_coherentes`). Si el código
--     acabara en `pin_hash`, `POST /auth/pin` sería justo la pantalla pública
--     para probar 10.000 códigos que el dueño descartó.
--   · "Sin bloqueo por intentos": aquí los intentos sólo se CUENTAN
--     (`fallos_consecutivos`) para avisarle al dueño. Ningún constraint impide
--     entrar por haber fallado.
--   · "Desaparece de la lista, su historial no": no se borra ninguna fila de
--     `usuario` (las FK RESTRICT de comanda/cobro lo impedirían igual).
--
-- ⚠️ CONVIVENCIA CON LA OTRA MIGRACIÓN PENDIENTE DEL 2026-09-18
--   Va después de 20260918210000_configuracion_restaurante. La del orden de la
--   grilla (`plantilla_mesa.orden_grilla`) no comparte tabla con ésta: si entra
--   después, un timestamp mayor que éste.
--
-- ⚠️ DEJA COJOS prisma/sql/03_rls.sql y prisma/sql/99_verificar_objetos.sql si
--    no se tocan en el mismo commit (§6, al final). Y `clave_hash` pasa a ser
--    nullable: el compilador va a señalar `auth.service.ts`, a propósito.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1 · Enums
--
-- `modulo_app` = una entrada del menú del frontend. `configuracion` y
-- `meseros` existen para que el menú del administrador se pinte con la misma
-- regla que el de todos, pero nadie más puede tenerlos (§2, CHECK).
--
-- `acceso_sospechoso` es el aviso push al dueño cuando alguien prueba códigos
-- en un enlace. PG >= 12 acepta `ADD VALUE` dentro de una transacción mientras
-- el valor no se USE en ella, y aquí no se usa.
-- ───────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "modulo_app" AS ENUM ('mesas', 'mesero', 'despacho', 'por_cobrar', 'reservaciones', 'checkin', 'escanear', 'productos', 'ventas', 'configuracion', 'meseros');

-- AlterEnum
ALTER TYPE "tema_notificacion" ADD VALUE 'acceso_sospechoso';


-- ───────────────────────────────────────────────────────────────────────────
-- 2 · usuario: la persona
-- ───────────────────────────────────────────────────────────────────────────

-- ⚠️ Prisma emite las listas escalares SIN NOT NULL y lee NULL como [] (igual
-- que `suscripcion_push.temas`). No se añade NOT NULL a la columna para no
-- crear deriva con el diff: el NOT NULL lo pone el CHECK de abajo.
-- AlterTable
ALTER TABLE "usuario" ADD COLUMN     "acceso_hasta" TIMESTAMPTZ(6),
ADD COLUMN     "modulos" "modulo_app"[] DEFAULT ARRAY[]::"modulo_app"[],
ALTER COLUMN "clave_hash" DROP NOT NULL;

-- Backfill: nadie pierde una pantalla que hoy usa.
--   · administrador: vacío. Para él `modulos` no aplica, ve todo por rol.
--   · el resto: todo menos `configuracion` y `meseros`. Configuración hoy ya
--     les responde 403 al guardar (PATCH /restaurante es sólo de administrador
--     desde 30366ba): sólo desaparece un botón que no servía.
UPDATE "usuario"
   SET "modulos" = ARRAY['mesas', 'mesero', 'despacho', 'por_cobrar', 'reservaciones',
                         'checkin', 'escanear', 'productos', 'ventas']::"modulo_app"[]
 WHERE "rol" <> 'administrador';

ALTER TABLE "usuario"
  -- ⭐ La decisión del dueño hecha invariante. Personal permanente: tiene
  -- clave. Acceso temporal: NI clave NI PIN, sólo entra por su enlace.
  -- Efecto colateral buscado: si algún día `hayai_fin_acceso` devolviera NULL
  -- por un bug, el acceso no se volvería PERMANENTE en silencio. Este CHECK lo
  -- rechaza, porque un usuario sin clave no puede ser permanente.
  ADD CONSTRAINT "usuario_credenciales_coherentes" CHECK (
    CASE WHEN "acceso_hasta" IS NULL
         THEN "clave_hash" IS NOT NULL
         ELSE "clave_hash" IS NULL AND "pin_hash" IS NULL
    END
  ),
  -- Un acceso temporal nunca es administrador ni encargado. Es lo que cierra
  -- la escalada: todo lo que está detrás de `@Roles('administrador')`, crear
  -- accesos incluido, queda fuera de su alcance aunque alguien le marque mal
  -- los módulos. Sin esto, un acceso de 4 dígitos podría renovarse a sí mismo.
  ADD CONSTRAINT "usuario_acceso_temporal_es_mesero" CHECK (
    "acceso_hasta" IS NULL OR "rol" = 'mesero'
  ),
  -- `rol` y `modulos` no pueden contradecirse:
  --   · el administrador ve todo por rol, así que su lista va VACÍA (si no, la
  --     base diría "sólo mesas" mientras la app le enseña todo);
  --   · nadie más puede tener los módulos de administración.
  -- `modulos IS NOT NULL` va aquí porque la columna no lo lleva (ver arriba):
  -- con NULL, `cardinality` y `<> ALL` dan NULL y el CHECK dejaría pasar la fila.
  ADD CONSTRAINT "usuario_modulos_segun_rol" CHECK (
    "modulos" IS NOT NULL AND
    CASE WHEN "rol" = 'administrador'
         THEN cardinality("modulos") = 0
         ELSE 'configuracion' <> ALL ("modulos") AND 'meseros' <> ALL ("modulos")
    END
  );

-- La lista de meseros: `acceso_hasta > now()` dentro del restaurante. Rango
-- sobre un btree normal (no parcial: `now()` no puede ir en el WHERE de un
-- índice). Devuelve sólo los vivos sin recorrer el histórico de vencidos.
-- CreateIndex
CREATE INDEX "usuario_acceso_vigente_idx" ON "usuario"("restaurante_id", "acceso_hasta");


-- ───────────────────────────────────────────────────────────────────────────
-- 3 · invitacion_acceso: la credencial
--
-- 1:1 con el usuario temporal. Tabla aparte porque `sanitizar()` quita
-- secretos de `usuario` por LISTA NEGRA: un hash nuevo en esa tabla se
-- filtraría por /auth/yo el día que alguien olvidara añadirlo.
-- ───────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "invitacion_acceso" (
    "restaurante_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "enlace_hash" TEXT NOT NULL,
    "codigo_hash" TEXT NOT NULL,
    "fallos_consecutivos" INTEGER NOT NULL DEFAULT 0,
    "ultimo_fallo_en" TIMESTAMPTZ(6),
    "otorgada_por_id" UUID NOT NULL,
    "emitida_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitacion_acceso_pkey" PRIMARY KEY ("restaurante_id","usuario_id")
);

-- ⭐ EL índice del canje. Global, sin `restaurante_id` delante, como
-- `suscripcion_push.endpoint`: un token de 160 bits es una identidad global.
-- El canje igual filtra por el restaurante del slug de la URL.
-- CreateIndex
CREATE UNIQUE INDEX "invitacion_acceso_enlace_unico" ON "invitacion_acceso"("enlace_hash");

-- AddForeignKey
ALTER TABLE "invitacion_acceso" ADD CONSTRAINT "invitacion_acceso_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ⭐ FK COMPUESTA: imposible colgar una invitación de un usuario de otro
-- restaurante. CASCADE, no RESTRICT: la credencial no es historia.
-- AddForeignKey
ALTER TABLE "invitacion_acceso" ADD CONSTRAINT "invitacion_acceso_restaurante_id_usuario_id_fkey" FOREIGN KEY ("restaurante_id", "usuario_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitacion_acceso" ADD CONSTRAINT "invitacion_acceso_restaurante_id_otorgada_por_id_fkey" FOREIGN KEY ("restaurante_id", "otorgada_por_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invitacion_acceso"
  -- Lo que se guarda es el SHA-256 en hex, nunca el token. El token son 32
  -- caracteres base32 Crockford EN MAYÚSCULA: por forma y por longitud jamás
  -- pasa este patrón, así que guardarlo en claro por error revienta aquí.
  -- (Por eso el token NO debe generarse en hex: 64 hex en claro sí pasarían.)
  ADD CONSTRAINT "invitacion_acceso_enlace_es_hash" CHECK (
    "enlace_hash" ~ '^[0-9a-f]{64}$'
  ),
  -- El código de 4 dígitos no se guarda en claro: cuatro cifras sueltas no
  -- empiezan por el prefijo de Argon2id.
  ADD CONSTRAINT "invitacion_acceso_codigo_es_argon2" CHECK (
    "codigo_hash" LIKE '$argon2id$%'
  ),
  ADD CONSTRAINT "invitacion_acceso_fallos_validos" CHECK (
    "fallos_consecutivos" >= 0
  );

-- ⭐⭐ Una invitación sólo puede colgar de un acceso temporal VIGENTE.
-- Cierra el agujero más caro del diseño: una invitación sobre un usuario
-- PERMANENTE sería una puerta de 4 dígitos, sin bloqueo y sin caducidad, a la
-- cuenta del dueño. El bug que la abre es trivial (un
-- `POST /accesos/:id/regenerar` que no compruebe que `:id` es temporal) y
-- ningún CHECK puede verlo, porque cruza dos tablas.
-- Vigente (`> now()`) y no sólo temporal: regenerar el enlace de un acceso
-- vencido tampoco tiene sentido; se crea uno nuevo.
-- `UPDATE OF` deja fuera a propósito `fallos_consecutivos`/`ultimo_fallo_en`:
-- el canje los escribe en cada intento y no debe pagar esta consulta.
CREATE OR REPLACE FUNCTION "hayai_invitacion_acceso_solo_temporal"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "usuario" u
     WHERE u."restaurante_id" = NEW."restaurante_id"
       AND u."id"             = NEW."usuario_id"
       AND u."acceso_hasta"   > now()
  ) THEN
    RAISE EXCEPTION 'La invitación % no cuelga de un acceso temporal vigente', NEW."usuario_id"
      USING ERRCODE = '23514', CONSTRAINT = 'invitacion_acceso_solo_temporal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "invitacion_acceso_solo_temporal"
  BEFORE INSERT OR UPDATE OF "restaurante_id", "usuario_id", "enlace_hash", "codigo_hash"
  ON "invitacion_acceso"
  FOR EACH ROW
  EXECUTE FUNCTION "hayai_invitacion_acceso_solo_temporal"();


-- ───────────────────────────────────────────────────────────────────────────
-- 4 · hayai_fin_acceso: cuándo vence un acceso
--
-- Los atajos son días OPERATIVOS, no bloques de 24 h. El acceso vence en la
-- hora de corte del restaurante (05:00 por defecto), cuando el local está
-- cerrado:
--   hoy      -> '1 day'    · hasta el corte que cierra el día operativo actual
--   2 días   -> '2 days'   · hasta el corte de pasado mañana
--   1 semana -> '7 days'
--   1 mes    -> '1 month'
-- Con now()+48h, un mesero invitado un viernes a las 20:00 quedaría fuera el
-- domingo a las 20:00, en plena cena y con comandas abiertas a su nombre.
--
-- Reutiliza `hayai_fecha_operativa`: el día operativo tiene UNA sola
-- definición en todo el sistema (docs/DECISIONES-DATOS.md §5). Uso:
--   SELECT hayai_fin_acceso(now(), r.zona_horaria, r.hora_corte_dia, $1::interval)
--     FROM restaurante r WHERE r.id = $2;
-- ───────────────────────────────────────────────────────────────────────────
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
-- 5 · Lo que NO trae, y es deliberado
--   · Ningún job ni columna `vencido`/`estado`: vencer es pasar la hora, y la
--     comparación con now() la hace quien lee. Un job se retrasa o se cae; el
--     reloj no.
--   · Ningún bloqueo por intentos (decisión del dueño). `fallos_consecutivos`
--     sólo cuenta; si algún día se decide frenar, la columna ya está.
--   · Ningún índice parcial: `now()` no puede ir en el predicado de un índice.
--
-- 6 · ⚠️ ARCHIVOS DE prisma/sql/ QUE HAY QUE TOCAR EN EL MISMO COMMIT
--   · 03_rls.sql: añadir 'invitacion_acceso' al array de tablas.
--   · 99_verificar_objetos.sql: los 3 CHECK de usuario, los 3 de
--     invitacion_acceso, su FK compuesta, el índice único del enlace, el
--     trigger y las dos funciones nuevas.
-- ───────────────────────────────────────────────────────────────────────────
