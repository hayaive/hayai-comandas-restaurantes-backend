-- ═══════════════════════════════════════════════════════════════════════════
-- NOTIFICACIONES WEB PUSH · suscripcion_push
--
-- Diseño de datos: J.O.R.B.I (data-engineer), verificado contra PostgreSQL 17
-- real antes de escribirse aquí. La justificación completa está en
-- docs/DECISIONES-DATOS.md §12.
--
-- QUÉ RESUELVE
-- El aviso de "entró una comanda" era puro frontend y moría con la pestaña.
-- Esta tabla guarda a qué navegadores hay que empujar el aviso y qué quiere
-- recibir cada uno, para que llegue con la app cerrada.
--
-- LAS DOS CONVENCIONES QUE ROMPE A PROPÓSITO
--   1. `endpoint` es único GLOBAL, sin `restaurante_id` delante: es la
--      identidad física de una instalación de navegador, no un dato del
--      tenant. Con unicidad por restaurante, un aparato que cambia de manos
--      queda registrado en los dos y sigue recibiendo los pedidos del anterior.
--   2. No hay `eliminada_en`. Es la única tabla del esquema que hace DELETE
--      real: de esta fila no cuelga histórico y conservarla sólo guardaría
--      "esta persona usaba este aparato".
--
-- LO QUE NO TRAE, Y ES DELIBERADO
--   · Ningún índice parcial, trigger ni vista. Todo lo que hay aquí salvo los
--     CHECK lo modela Prisma, así que esta tabla NO entra en la lista de
--     objetos que `migrate dev` propone borrar (docs/DECISIONES-DATOS.md §8).
--   · Ninguna columna de estado ni de error (`activa`, `fallos_consecutivos`,
--     `ultimo_error_en`): ver §12.4 del doc. Muerta = borrada.
--
-- ⚠️ ESTA MIGRACIÓN DEJA DOS ARCHIVOS DE prisma/sql/ COJOS si no se tocan en el
--    mismo commit. Están listados en §5, al final. No son opcionales: el de
--    RLS es una fuga de seguridad y el de verificación es el que convierte en
--    build roto la pérdida silenciosa de los CHECK.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1 · Enum de temas
--
-- Los cuatro valores se declaran de una vez aunque hoy sólo se emitan los dos
-- primeros: un valor de enum sin emisor no cuesta nada, y añadirlo después
-- exige `ALTER TYPE ... ADD VALUE` y desplegar el backend antes que el
-- frontend que lo emite. Cuando se pidan las "cuentas por cobrar" no habrá que
-- tocar el esquema: se emite el tema y los aparatos se suscriben.
-- ───────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "tema_notificacion" AS ENUM ('comanda_cocina', 'comanda_barra', 'cuenta_por_cobrar', 'reservacion_nueva');


-- ───────────────────────────────────────────────────────────────────────────
-- 2 · Tabla
-- ───────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "suscripcion_push" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "expira_en" TIMESTAMPTZ(6),
    -- ⚠️ Prisma emite las listas escalares SIN NOT NULL y lee NULL como [].
    -- Se deja tal cual a propósito: añadir NOT NULL a mano crearía deriva con
    -- el diff, y el comportamiento es idéntico — `temas @> ARRAY[...]` sobre
    -- NULL da NULL, la fila no entra en el abanico. Falla cerrado.
    "temas" "tema_notificacion"[] DEFAULT ARRAY[]::"tema_notificacion"[],
    "vapid_kid" TEXT NOT NULL,
    "etiqueta" TEXT,
    "agente_usuario" TEXT,
    "creada_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renovada_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- ⚠️ `@updatedAt` lo escribe el cliente Prisma, NO la base: no tiene
    -- DEFAULT. Todo INSERT por SQL crudo (incluido el upsert de registro) tiene
    -- que dar valor a esta columna o muere con un 23502 que no explica nada.
    "actualizada_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "suscripcion_push_pkey" PRIMARY KEY ("id")
);


-- ───────────────────────────────────────────────────────────────────────────
-- 3 · Índices y claves foráneas
-- ───────────────────────────────────────────────────────────────────────────

-- ⭐ LA CLAVE NATURAL. Global, sin `restaurante_id`: el mismo navegador sólo
-- puede estar registrado en un sitio. Es lo que convierte el traspaso de un
-- aparato (logout de A, login de B en la misma tablet) en un UPDATE, y no en
-- una segunda fila que sigue avisando al dueño anterior.
-- El registro es siempre `INSERT ... ON CONFLICT ("endpoint") DO UPDATE`.
-- CreateIndex
CREATE UNIQUE INDEX "suscripcion_push_endpoint_unico" ON "suscripcion_push"("endpoint");

-- El índice de la consulta caliente: el abanico de envío escanea por el
-- prefijo `restaurante_id`, y las dos columnas juntas sirven a la lista de
-- dispositivos de un usuario y al borrado al cerrar sesión.
-- Es además el índice de la FK compuesta, que Postgres no crea solo: sin él,
-- desactivar un usuario escanearía esta tabla entera.
-- CreateIndex
CREATE INDEX "suscripcion_push_envio_idx" ON "suscripcion_push"("restaurante_id", "usuario_id");

-- Habilita la FK compuesta desde cualquier tabla futura y sostiene la
-- convención del esquema.
-- CreateIndex
CREATE UNIQUE INDEX "suscripcion_push_restaurante_id_key" ON "suscripcion_push"("restaurante_id", "id");

-- AddForeignKey
ALTER TABLE "suscripcion_push" ADD CONSTRAINT "suscripcion_push_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ⭐ La FK COMPUESTA que hace imposible suscribir a un usuario de otro
-- restaurante. `CASCADE` y no `RESTRICT`: `RESTRICT` está en el resto del
-- esquema para que no se borre a quien firmó comandas, y una suscripción no es
-- historia. Bloquear el borrado de un usuario porque tiene un teléfono
-- registrado sería absurdo.
-- AddForeignKey
ALTER TABLE "suscripcion_push" ADD CONSTRAINT "suscripcion_push_restaurante_id_usuario_id_fkey" FOREIGN KEY ("restaurante_id", "usuario_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────────────────────────────────────────────────────────────────────
-- 4 · DDL A MANO · CHECKs
--
-- Prisma no los modela, así que sobreviven al diff. Su trabajo es que una fila
-- imposible falle en el INSERT y no dentro del bucle de envío, donde el error
-- llega como un 400 del servicio de push un sábado a las tres de la tarde.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE "suscripcion_push"
  -- Un endpoint de push es SIEMPRE https. El techo de 2048 no es estético: el
  -- índice único de arriba es un btree y una entrada de más de ~2704 bytes lo
  -- revienta con "index row size exceeds maximum". Mejor un 23514 legible que
  -- un fallo del índice.
  -- (Longitudes reales: FCM ~185, Mozilla ~250, Apple ~700-1000, WNS ~600.)
  ADD CONSTRAINT "suscripcion_push_endpoint_valido" CHECK (
    "endpoint" ~ '^https://' AND length("endpoint") BETWEEN 30 AND 2048
  ),
  -- base64 en cualquiera de sus dos alfabetos (estándar y url-safe): los
  -- navegadores devuelven un ArrayBuffer y cada frontend lo codifica a su
  -- manera; `web-push` acepta las dos. En la práctica p256dh mide 87-88 y auth
  -- 22-24. El rango va holgado para no rechazar a un navegador raro, pero
  -- corta el caso real: que llegue un "[object ArrayBuffer]" o un JSON entero.
  ADD CONSTRAINT "suscripcion_push_claves_validas" CHECK (
    "p256dh" ~ '^[A-Za-z0-9+/_-]{80,200}={0,2}$' AND
    "auth"   ~ '^[A-Za-z0-9+/_-]{16,40}={0,2}$'
  ),
  -- El User-Agent lo elige el cliente: sin techo es una columna de texto libre
  -- de tamaño arbitrario escrita por quien sea.
  ADD CONSTRAINT "suscripcion_push_agente_acotado" CHECK (
    "agente_usuario" IS NULL OR length("agente_usuario") <= 300
  ),
  ADD CONSTRAINT "suscripcion_push_etiqueta_acotada" CHECK (
    "etiqueta" IS NULL OR length(btrim("etiqueta")) BETWEEN 1 AND 60
  );


-- ───────────────────────────────────────────────────────────────────────────
-- 5 · Lo que esta migración NO puede hacer sola
--
-- Estas dos ediciones viven en archivos versionados aparte y van en el MISMO
-- commit. Ya están aplicadas si este archivo llegó por el commit original;
-- quedan escritas aquí para que una revisión futura pueda comprobarlo.
--
--   a) prisma/sql/03_rls.sql — 'suscripcion_push' añadido al array `tablas`.
--      El propio archivo lo advierte: "una tabla nueva sin política es una
--      fuga silenciosa". Aquí la fuga sería un canal de escritura hacia el
--      teléfono de un empleado de otro restaurante.
--
--   b) prisma/sql/99_verificar_objetos.sql — añadidos a `constraints` los
--      cuatro CHECK de §4 y la FK compuesta, y a `indices` el único global del
--      endpoint. Si ese índice se pierde, nada falla: simplemente aparecen dos
--      filas para el mismo endpoint, el traspaso de aparatos deja de funcionar
--      y el aparato recibe la notificación por duplicado.
--
-- Y una advertencia operativa que no cabe en ningún archivo de DDL:
-- el barrido de suscripciones caducadas
--     DELETE FROM suscripcion_push WHERE renovada_en < now() - interval '90 days';
-- ⚠️ ve CERO FILAS cuando RLS esté activo y corra sin contexto de tenant, y no
-- falla: simplemente no borra nada y nadie se entera en meses. Tiene que
-- iterar restaurantes con SET LOCAL app.restaurante_id, o correr con un rol
-- BYPASSRLS reservado a mantenimiento.
-- ───────────────────────────────────────────────────────────────────────────
