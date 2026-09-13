-- ═══════════════════════════════════════════════════════════════════════════
-- 99 · Guardia de integridad — correr en CI después de `prisma migrate deploy`
--
-- POR QUÉ EXISTE
-- Prisma modela los índices. Un índice que está en la base y no en
-- schema.prisma le parece basura y en la siguiente migración emite un
-- `DROP INDEX`. Si alguien aplica ese SQL sin leerlo, el sistema pierde —en
-- silencio— la prohibición de doble reserva o la de doble comanda por mesa.
-- No falla nada: simplemente, semanas después, una mesa aparece reservada dos
-- veces un sábado por la noche.
--
-- Este script convierte ese fallo silencioso en un build roto.
-- Uso:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/sql/99_verificar_objetos.sql
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  faltan text[] := ARRAY[]::text[];

  -- Índices (parciales o por expresión) que Prisma no sabe declarar.
  indices text[] := ARRAY[
    'mesa_etiqueta_unica',
    'salon_nombre_unico',
    'categoria_nombre_unica',
    'producto_nombre_unico',
    'producto_codigo_unico',
    'plantilla_activa_unica',
    'comanda_mesa_activa_unica',
    'comanda_item_cocina_idx',
    'reservacion_agenda_idx',
    'comanda_por_cobrar_idx'
  ];

  -- Constraints de tabla.
  constraints text[] := ARRAY[
    'reservacion_sin_solape',
    'comanda_tipo_coherente',
    'comanda_cierre_coherente',
    'comanda_tasa_congelada',
    'pago_referencia_obligatoria',
    'pago_tasa_coherente',
    'plantilla_mesa_capacidad_valida',
    'reservacion_rango_valido'
  ];

  triggers text[] := ARRAY[
    'reservacion_periodo',
    'plantilla_mesa_mismo_salon',
    'mesa_cambio_salon'
  ];

  funciones text[] := ARRAY[
    'hayai_reservacion_periodo',
    'hayai_plantilla_mesa_mismo_salon',
    'hayai_mesa_cambio_salon',
    'hayai_fecha_operativa',
    'hayai_turno'
  ];

  vistas text[] := ARRAY[
    'v_mesa_estado',
    'v_comanda_activa',
    'v_venta_dia',
    'v_venta_dia_metodo',
    'v_producto_vendido_dia',
    'v_comanda_descuadre',
    'v_reservacion_huerfana'
  ];

  n text;
BEGIN
  FOREACH n IN ARRAY indices LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c
                    JOIN pg_namespace ns ON ns.oid = c.relnamespace
                   WHERE c.relkind = 'i' AND c.relname = n AND ns.nspname = current_schema())
    THEN faltan := faltan || ('índice ' || n); END IF;
  END LOOP;

  FOREACH n IN ARRAY constraints LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = n)
    THEN faltan := faltan || ('constraint ' || n); END IF;
  END LOOP;

  FOREACH n IN ARRAY triggers LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = n AND NOT tgisinternal)
    THEN faltan := faltan || ('trigger ' || n); END IF;
  END LOOP;

  FOREACH n IN ARRAY funciones LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    JOIN pg_namespace ns ON ns.oid = p.pronamespace
                   WHERE p.proname = n AND ns.nspname = current_schema())
    THEN faltan := faltan || ('función ' || n); END IF;
  END LOOP;

  FOREACH n IN ARRAY vistas LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_views WHERE viewname = n AND schemaname = current_schema())
    THEN faltan := faltan || ('vista ' || n); END IF;
  END LOOP;

  -- Las vistas deben ser security_invoker, o RLS no las filtra.
  IF EXISTS (
      SELECT 1 FROM pg_class c
       JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE c.relkind = 'v'
        AND ns.nspname = current_schema()
        AND c.relname LIKE 'v\_%'
        AND coalesce(array_to_string(c.reloptions, ','), '') NOT LIKE '%security_invoker=true%'
  ) THEN
    faltan := faltan || 'alguna vista v_* perdió security_invoker=true';
  END IF;

  IF array_length(faltan, 1) > 0 THEN
    RAISE EXCEPTION E'Objetos de base de datos perdidos (revisa el último migration.sql, probablemente traía un DROP INDEX):\n  - %',
      array_to_string(faltan, E'\n  - ');
  END IF;

  RAISE NOTICE 'OK: todos los objetos de prisma/sql están presentes.';
END;
$$;
