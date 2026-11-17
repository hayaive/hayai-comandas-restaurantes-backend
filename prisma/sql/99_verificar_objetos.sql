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
    'reservacion_agenda_idx',
    -- Los que sostienen la operación. Si se pierden nada falla: el KDS, el
    -- plano y las cuentas pasan a escanear la tabla histórica entera cada
    -- pocos segundos. `comanda_cuenta_abierta_idx` murió con `comanda.cobro_id`
    -- (2026-11-05); su sucesor es `comanda_item_deuda_idx`.
    'comanda_cola_despacho_idx',
    'comanda_item_deuda_idx',
    'cliente_abierto_idx',
    -- Un solo cliente abierto por reserva: sin él, el doble toque en "sentar"
    -- abre dos cuentas para la misma mesa.
    'cliente_reservacion_abierta_unica',
    -- Lo declara Prisma, pero es el destino de la FK de tres columnas que ata
    -- cada línea facturada al cliente de su factura.
    'cobro_cliente_key',
    -- Éste SÍ lo declara Prisma (`@unique` sobre `endpoint`), pero se vigila
    -- igual porque su pérdida es silenciosa y cara: es GLOBAL, sin
    -- restaurante_id, y es lo único que hace que el traspaso de un aparato
    -- (logout de uno, login de otro en la misma tablet) sea un UPDATE. Sin él
    -- aparecen dos filas para el mismo endpoint, el dueño anterior sigue
    -- recibiendo y el aparato recibe cada aviso por duplicado.
    'suscripcion_push_endpoint_unico',
    -- Accesos temporales. Lo declara Prisma, pero es EL índice del canje: sin
    -- él, dos invitaciones podrían compartir enlace y un mesero entraría como
    -- otro.
    'invitacion_acceso_enlace_unico'
  ];

  -- Constraints de tabla.
  constraints text[] := ARRAY[
    'reservacion_sin_solape',
    'comanda_tipo_coherente',
    'comanda_total_valido',
    'comanda_anulacion_coherente',
    -- `comanda_anulada_no_cobrada` y `comanda_cobro_tras_despacho` dejaron de
    -- ser CHECK el 2026-11-05: viven en los triggers `comanda_estado` y
    -- `comanda_item_editable` (con el mismo nombre en el error).
    'comanda_cliente_nombre_normalizado',
    -- Cliente y facturación por líneas (migración 20261105120100).
    'cliente_nombre_normalizado',
    'cliente_cierre_coherente',
    'comanda_item_total_coherente',
    -- ⭐ La línea facturada es del cliente de su factura.
    'comanda_item_restaurante_id_cobro_id_cliente_id_fkey',
    'comanda_restaurante_id_cliente_id_fkey',
    'cobro_restaurante_id_cliente_id_fkey',
    'bitacora_restaurante_id_usuario_id_fkey',
    'cobro_pago_monto_valido',
    'cobro_cliente_nombre_normalizado',
    'comanda_item_cancelacion_coherente',
    'cobro_totales_validos',
    'cobro_tipo_coherente',
    'cobro_anulacion_coherente',
    'cobro_pago_referencia_obligatoria',
    'cobro_pago_tasa_coherente',
    -- ⚠️ La FK que el borrador de la migración se dejó: sin ella un pago puede
    -- quedar apuntando a un cobro que no existe.
    'cobro_pago_restaurante_id_cobro_id_fkey',
    'plantilla_mesa_capacidad_valida',
    'reservacion_rango_valido',
    'plantilla_eliminada_no_activa',
    -- Notificaciones push. Si estos CHECK se pierden, nada falla al escribir:
    -- el error aparece después, dentro del bucle de envío, como un 400 del
    -- servicio de push que no dice qué fila lo causó.
    'suscripcion_push_endpoint_valido',
    'suscripcion_push_claves_validas',
    'suscripcion_push_agente_acotado',
    'suscripcion_push_etiqueta_acotada',
    -- La FK compuesta: es lo que hace imposible suscribir a un usuario de otro
    -- restaurante. Sin ella el aislamiento depende de que el servicio no se
    -- equivoque.
    'suscripcion_push_restaurante_id_usuario_id_fkey',
    -- Configuración del restaurante (nombre/logo/vista de precios). Sin
    -- 'restaurante_nombre_acotado' un nombre en blanco sale silenciosamente en
    -- el ticket; sin 'restaurante_logo_url_valida' el PATCH acepta cualquier
    -- cadena como logo (rastreador de terceros, `javascript:`/`data:` URI);
    -- sin 'restaurante_moneda_base_usd' una columna que TODO el sistema da por
    -- sentada (moneda_base = USD) deja de estar garantizada.
    'restaurante_nombre_acotado',
    'restaurante_logo_url_valida',
    'restaurante_moneda_base_usd',
    -- Accesos temporales (migración 20260918230000). Si se pierden, nada
    -- falla al escribir y todo queda abierto en silencio:
    --   · sin 'usuario_credenciales_coherentes' un acceso temporal puede
    --     acabar con PIN, y `POST /auth/pin` pasa a ser la pantalla pública
    --     para probar sus 10.000 códigos;
    --   · sin 'usuario_acceso_temporal_es_mesero' un acceso de 4 dígitos
    --     puede ser administrador y renovarse a sí mismo;
    --   · sin 'usuario_modulos_segun_rol' alguien que no es administrador
    --     puede recibir la pantalla Meseros o Configuración;
    --   · sin los CHECK de hash el token o el código se pueden guardar en
    --     claro;
    --   · sin la FK compuesta una invitación puede colgar de un usuario de
    --     otro restaurante.
    'usuario_credenciales_coherentes',
    'usuario_acceso_temporal_es_mesero',
    'usuario_modulos_segun_rol',
    'invitacion_acceso_enlace_es_hash',
    'invitacion_acceso_codigo_es_argon2',
    'invitacion_acceso_fallos_validos',
    'invitacion_acceso_restaurante_id_usuario_id_fkey'
  ];

  triggers text[] := ARRAY[
    'reservacion_periodo',
    'plantilla_mesa_mismo_salon',
    'mesa_cambio_salon',
    -- Impide que un cobro congele la tasa del EURO en vez de la del dólar.
    -- Si se pierde, el cobro sigue funcionando y cobra mal: nada falla.
    'cobro_tasa_base',
    'tasa_divisa_inmutable',
    -- `comanda.estado` y `comanda.total` son derivados: sin este trigger (y sin
    -- `comanda_item_derivar`, que lo dispara al tocar una línea) se quedan en
    -- el valor que escriba quien sea.
    'comanda_estado',
    'comanda_item_derivar',
    -- Qué se puede escribir en una línea (sustituye a comanda_item_solo_pendiente):
    -- sin él se factura lo que sigue en cocina o se le anota deuda a un
    -- cliente que ya se fue.
    'comanda_item_editable',
    'cliente_cierre_sin_deuda',
    -- ⭐⭐ La factura verificada al COMMIT (sustituye a cobro_no_vacio): no
    -- vacía, totales salidos de sus líneas, pagos que cuadran. Sin estos tres,
    -- una corrección a medias deja la caja descuadrada en silencio.
    'cobro_coherente',
    'comanda_item_cobro_coherente',
    'cobro_pago_cobro_coherente',
    -- Día y número de una factura inmutables, anulada congelada / los pagos no se editan.
    'cobro_guardia',
    'cobro_pago_guardia',
    -- Bitácora: sin estos, una factura se corrige sin dejar rastro.
    'comanda_item_bitacora',
    'cobro_bitacora',
    'cliente_bitacora',
    'bitacora_inmutable',
    -- Impide colgar una invitación (puerta de 4 dígitos sin bloqueo) de un
    -- usuario PERMANENTE. Cruza dos tablas: ningún CHECK lo puede sustituir.
    'invitacion_acceso_solo_temporal'
  ];

  funciones text[] := ARRAY[
    'hayai_reservacion_periodo',
    'hayai_plantilla_mesa_mismo_salon',
    'hayai_mesa_cambio_salon',
    'hayai_fecha_operativa',
    'hayai_turno',
    'hayai_cobro_tasa_base',
    'hayai_tasa_divisa_inmutable',
    'hayai_comanda_estado',
    'hayai_invitacion_acceso_solo_temporal',
    'hayai_fin_acceso',
    'hayai_comanda_item_editable',
    'hayai_comanda_item_derivar',
    'hayai_cliente_cierre',
    'hayai_cobro_guardia',
    'hayai_cobro_pago_guardia',
    'hayai_cobro_verificar',
    'hayai_cobro_coherente',
    'hayai_bitacora',
    'hayai_bitacora_inmutable'
  ];

  vistas text[] := ARRAY[
    'v_mesa_estado',
    'v_cola_despacho',
    'v_cuenta_cliente',
    'v_venta_dia',
    'v_venta_dia_metodo',
    'v_producto_vendido_dia',
    'v_cobro_descuadre',
    'v_reservacion_huerfana'
  ];

  -- Objetos del modelo viejo que NO deben volver. Un `git revert` a medias o un
  -- prisma/sql/ desincronizado los recrearía, y entonces la segunda comanda de
  -- una mesa empezaría a fallar con 23505 en plena cena — o peor, `v_venta_dia`
  -- volvería a contar comandas en vez de cobros y el reporte cambiaría solo.
  difuntos text[] := ARRAY[
    'comanda_mesa_activa_unica',
    'comanda_item_cocina_idx',
    'comanda_por_cobrar_idx',
    'comanda_reservacion_unica'
  ];
  vistas_difuntas text[] := ARRAY[
    'v_comanda_activa',
    'v_comanda_descuadre',
    -- Sustituida por v_cuenta_cliente (2026-11-05): la cuenta es del cliente.
    'v_cuenta_mesa'
  ];
  -- Triggers del modelo "la factura es de la comanda". Si vuelven, rechazan
  -- las correcciones legítimas o verifican contra una columna que ya no existe.
  triggers_difuntos text[] := ARRAY[
    'comanda_item_solo_pendiente',
    'cobro_no_vacio'
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

  -- Lo que resucitó y no debería.
  FOREACH n IN ARRAY difuntos LOOP
    IF EXISTS (SELECT 1 FROM pg_class c
                JOIN pg_namespace ns ON ns.oid = c.relnamespace
               WHERE c.relkind = 'i' AND c.relname = n AND ns.nspname = current_schema())
    THEN faltan := faltan || ('índice REVIVIDO del modelo viejo: ' || n); END IF;
  END LOOP;

  FOREACH n IN ARRAY vistas_difuntas LOOP
    IF EXISTS (SELECT 1 FROM pg_views WHERE viewname = n AND schemaname = current_schema())
    THEN faltan := faltan || ('vista REVIVIDA del modelo viejo: ' || n); END IF;
  END LOOP;

  FOREACH n IN ARRAY triggers_difuntos LOOP
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = n AND NOT tgisinternal)
    THEN faltan := faltan || ('trigger REVIVIDO del modelo viejo: ' || n); END IF;
  END LOOP;

  -- Los tres de la factura TIENEN que ser diferidos: inmediatos, rechazan el
  -- INSERT del cobro antes de que se le apunte ninguna línea.
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname IN ('cobro_coherente', 'comanda_item_cobro_coherente', 'cobro_pago_cobro_coherente')
                AND NOT (tgdeferrable AND tginitdeferred)) THEN
    faltan := faltan || 'algún trigger *_cobro_coherente dejó de ser DEFERRABLE INITIALLY DEFERRED';
  END IF;

  -- No es un objeto perdido, pero conviene verlo: la migración lo deja NOT
  -- VALID si había líneas históricas con total_linea mal calculado.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comanda_item_total_coherente' AND NOT convalidated) THEN
    RAISE NOTICE 'comanda_item_total_coherente está NOT VALID: hay líneas históricas con total_linea incoherente';
  END IF;

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
