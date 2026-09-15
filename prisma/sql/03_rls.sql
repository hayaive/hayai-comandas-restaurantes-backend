-- ═══════════════════════════════════════════════════════════════════════════
-- 03 · Row-Level Security por restaurante  (ACTIVACIÓN DIFERIDA — ver abajo)
--
-- ¿CUÁNDO APLICAR ESTE ARCHIVO?
-- No hace falta el día 1 con un solo restaurante y un solo backend. Pasa a ser
-- OBLIGATORIO en cuanto ocurra cualquiera de estas dos cosas:
--   1. Entra un segundo restaurante a la misma base.
--   2. Se publica el enlace público de reservas (/r/<slug>/...), porque ese
--      endpoint atiende peticiones sin sesión y es la superficie de ataque
--      más expuesta del sistema.
-- Lo que NO se puede diferir es la columna `restaurante_id`: esa va desde el
-- primer día en todas las tablas, porque añadirla después obliga a rehacer
-- cada PK, cada índice y cada consulta. RLS encima es un archivo; retrofitear
-- el tenant es reescribir el sistema.
--
-- Cómo lo usa la aplicación (NestJS + Prisma):
--   · La app se conecta con un rol SIN BYPASSRLS y que NO es el dueño de las
--     tablas. Las migraciones corren con otro rol (el dueño).
--   · Cada petición abre `$transaction` y emite
--       SET LOCAL app.restaurante_id = '<uuid>';
--     con el id sacado del TOKEN VERIFICADO, jamás del body ni de un header.
--   · `SET LOCAL`, NUNCA `SET`: con PgBouncer en modo transacción, un `SET`
--     se queda pegado en la conexión y la siguiente petición que la reutilice
--     leerá los datos del restaurante anterior. Es el error clásico y es grave.
-- ═══════════════════════════════════════════════════════════════════════════


-- ⚠️ `nullif(..., '')` NO es decorativo.
-- `current_setting('app.restaurante_id', true)` devuelve NULL sólo en una
-- conexión virgen. En cuanto esa conexión sirvió UNA transacción con SET LOCAL,
-- al terminar el GUC vuelve a CADENA VACÍA, no a NULL — y `''::uuid` lanza
-- 22P02 en vez de devolver cero filas. Con un pool eso se ve como errores 500
-- aleatorios según qué conexión reutilizada atienda la petición.
-- (Lección aprendida en hayai-saas; no quitar el nullif.)
CREATE OR REPLACE FUNCTION "hayai_restaurante_actual"()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.restaurante_id', true), '')::uuid;
$$;


-- Aplica la misma política a todas las tablas de negocio. En bucle y no a mano
-- porque la lista crece: una tabla nueva sin política es una fuga silenciosa.
DO $$
DECLARE
  t text;
  tablas text[] := ARRAY[
    'usuario', 'salon', 'mesa', 'plantilla', 'plantilla_mesa',
    'categoria', 'producto', 'reservacion', 'comanda', 'comanda_item',
    -- `cobro` y `cobro_pago` llevan el dinero cobrado: si se olvidaran aquí,
    -- el día que se active RLS un tenant vería la facturación de otro.
    -- `cobro_pago` y `contador_dia` se llamaban `comanda_pago` y
    -- `contador_comanda` antes de la migración 20260915183000.
    'cobro', 'cobro_pago', 'tasa_cambio', 'contador_dia', 'resumen_dia'
  ];
BEGIN
  FOREACH t IN ARRAY tablas LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE: la política aplica también al dueño de la tabla. Sin esto, el rol
    -- que corre las migraciones (y cualquier script que lo use) ve todo.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "restaurante_aislado" ON %I', t);
    EXECUTE format($f$
      CREATE POLICY "restaurante_aislado" ON %I
        USING      ("restaurante_id" = "hayai_restaurante_actual"())
        WITH CHECK ("restaurante_id" = "hayai_restaurante_actual"())
    $f$, t);
  END LOOP;
END;
$$;

-- La raíz se filtra por su propio id.
ALTER TABLE "restaurante" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurante" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "restaurante_aislado" ON "restaurante";
CREATE POLICY "restaurante_aislado" ON "restaurante"
  USING      ("id" = "hayai_restaurante_actual"())
  WITH CHECK ("id" = "hayai_restaurante_actual"());


-- ───────────────────────────────────────────────────────────────────────────
-- Rol de aplicación
-- Ajustar el nombre y la clave al entorno; la clave NO se versiona.
-- ───────────────────────────────────────────────────────────────────────────
-- CREATE ROLE hayai_app LOGIN PASSWORD '<en el gestor de secretos>';
-- GRANT USAGE ON SCHEMA public TO hayai_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hayai_app;
-- GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hayai_app;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public
--   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hayai_app;
-- -- hayai_app NO debe ser SUPERUSER ni tener BYPASSRLS ni ser dueño de las tablas.


-- ───────────────────────────────────────────────────────────────────────────
-- Prueba de humo (correr a mano tras activar; debe dar 0 filas y luego error)
-- ───────────────────────────────────────────────────────────────────────────
-- BEGIN;
--   SET LOCAL ROLE hayai_app;
--   SELECT count(*) FROM mesa;                       -- 0: sin contexto, falla cerrado
--   SET LOCAL app.restaurante_id = '<uuid restaurante A>';
--   SELECT count(*) FROM mesa;                       -- sólo las de A
--   INSERT INTO mesa (id, restaurante_id, salon_id, etiqueta)
--     VALUES (gen_random_uuid(), '<uuid restaurante B>', '<salon B>', 'X');
--                                                    -- debe fallar por WITH CHECK
-- ROLLBACK;
