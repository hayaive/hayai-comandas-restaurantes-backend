-- ═══════════════════════════════════════════════════════════════════════════
-- 00 · Extensiones
--
-- ⚠️ Va AL PRINCIPIO de la primera migración, ANTES de los CREATE TABLE:
--    el esquema usa CITEXT en columnas y el EXCLUDE de reservaciones necesita
--    btree_gist. Sin esto, `prisma migrate deploy` falla en la línea 43.
--
-- Uso: pegar este bloque arriba del `migration.sql` generado por
--      `prisma migrate dev --create-only --name fundacion`.
-- ═══════════════════════════════════════════════════════════════════════════

-- Texto case-insensitive: slug del restaurante y nombre de usuario.
CREATE EXTENSION IF NOT EXISTS citext;

-- Permite combinar tipos escalares (uuid) con operadores de rango (&&) dentro
-- de un mismo índice GiST. Es lo que hace posible el constraint que impide la
-- doble reserva de una mesa.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "rol_usuario" AS ENUM ('administrador', 'encargado', 'mesero', 'cocina', 'caja');

-- CreateEnum
CREATE TYPE "forma_mesa" AS ENUM ('redonda', 'cuadrada', 'rectangular', 'barra');

-- CreateEnum
CREATE TYPE "estado_reservacion" AS ENUM ('pendiente', 'confirmada', 'sentada', 'completada', 'cancelada', 'no_show');

-- CreateEnum
CREATE TYPE "origen_reservacion" AS ENUM ('personal', 'enlace_publico');

-- CreateEnum
CREATE TYPE "estado_comanda" AS ENUM ('abierta', 'por_cobrar', 'cobrada', 'anulada');

-- CreateEnum
CREATE TYPE "tipo_comanda" AS ENUM ('mesa', 'para_llevar');

-- CreateEnum
CREATE TYPE "estado_comanda_item" AS ENUM ('pendiente', 'en_preparacion', 'servido', 'cancelado');

-- CreateEnum
CREATE TYPE "destino_preparacion" AS ENUM ('cocina', 'barra', 'ninguno');

-- CreateEnum
CREATE TYPE "turno_servicio" AS ENUM ('desayuno', 'almuerzo', 'cena', 'madrugada');

-- CreateEnum
CREATE TYPE "metodo_pago" AS ENUM ('efectivo_usd', 'efectivo_bs', 'pago_movil', 'transferencia', 'punto', 'binance', 'otro');

-- CreateEnum
CREATE TYPE "moneda" AS ENUM ('USD', 'BS');

-- CreateEnum
CREATE TYPE "fuente_tasa" AS ENUM ('bcv', 'manual', 'binance');

-- CreateTable
CREATE TABLE "restaurante" (
    "id" UUID NOT NULL,
    "slug" CITEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "rif" TEXT,
    "moneda_base" "moneda" NOT NULL DEFAULT 'USD',
    "zona_horaria" TEXT NOT NULL DEFAULT 'America/Caracas',
    "hora_corte_dia" TIME(0) NOT NULL DEFAULT '05:00'::time,
    "duracion_reserva_min" INTEGER NOT NULL DEFAULT 90,
    "permite_autoseleccion" BOOLEAN NOT NULL DEFAULT true,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "restaurante_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuario" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "usuario" CITEXT NOT NULL,
    "clave_hash" TEXT NOT NULL,
    "pin_hash" TEXT,
    "rol" "rol_usuario" NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "ultimo_acceso_en" TIMESTAMPTZ(6),
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "eliminado_en" TIMESTAMPTZ(6),
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "salon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mesa" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "salon_id" UUID NOT NULL,
    "etiqueta" TEXT NOT NULL,
    "capacidad_default" INTEGER NOT NULL DEFAULT 4,
    "forma_default" "forma_mesa" NOT NULL DEFAULT 'cuadrada',
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "eliminada_en" TIMESTAMPTZ(6),
    "creada_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizada_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mesa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plantilla" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "salon_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "ancho_plano" DECIMAL(10,2) NOT NULL DEFAULT 1200,
    "alto_plano" DECIMAL(10,2) NOT NULL DEFAULT 800,
    "activa" BOOLEAN NOT NULL DEFAULT false,
    "clonada_de_id" UUID,
    "creada_por_id" UUID,
    "creada_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizada_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plantilla_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plantilla_mesa" (
    "restaurante_id" UUID NOT NULL,
    "plantilla_id" UUID NOT NULL,
    "mesa_id" UUID NOT NULL,
    "pos_x" DECIMAL(10,2) NOT NULL,
    "pos_y" DECIMAL(10,2) NOT NULL,
    "ancho" DECIMAL(10,2) NOT NULL DEFAULT 80,
    "alto" DECIMAL(10,2) NOT NULL DEFAULT 80,
    "rotacion" SMALLINT NOT NULL DEFAULT 0,
    "forma" "forma_mesa" NOT NULL,
    "capacidad" INTEGER NOT NULL,
    "bloqueada" BOOLEAN NOT NULL DEFAULT false,
    "creada_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizada_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plantilla_mesa_pkey" PRIMARY KEY ("plantilla_id","mesa_id")
);

-- CreateTable
CREATE TABLE "categoria" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "eliminada_en" TIMESTAMPTZ(6),
    "creada_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizada_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "categoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "producto" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "categoria_id" UUID NOT NULL,
    "codigo" TEXT,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "precio" DECIMAL(14,4) NOT NULL,
    "costo" DECIMAL(14,4),
    "destino" "destino_preparacion" NOT NULL DEFAULT 'cocina',
    "disponible" BOOLEAN NOT NULL DEFAULT true,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "imagen_url" TEXT,
    "tiempo_prep_min" INTEGER,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "producto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservacion" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "salon_id" UUID NOT NULL,
    "plantilla_id" UUID NOT NULL,
    "mesa_id" UUID,
    "cliente_nombre" TEXT NOT NULL,
    "cliente_telefono" TEXT,
    "cliente_documento" TEXT,
    "personas" INTEGER NOT NULL,
    "inicia_en" TIMESTAMPTZ(6) NOT NULL,
    "termina_en" TIMESTAMPTZ(6) NOT NULL,
    "periodo" tstzrange,
    "estado" "estado_reservacion" NOT NULL DEFAULT 'pendiente',
    "origen" "origen_reservacion" NOT NULL DEFAULT 'personal',
    "codigo_publico" TEXT NOT NULL,
    "codigo_corto" TEXT NOT NULL,
    "notas" TEXT,
    "creada_por_id" UUID,
    "confirmada_en" TIMESTAMPTZ(6),
    "sentada_en" TIMESTAMPTZ(6),
    "cancelada_en" TIMESTAMPTZ(6),
    "motivo_cancelacion" TEXT,
    "creada_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizada_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reservacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comanda" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "tipo" "tipo_comanda" NOT NULL DEFAULT 'mesa',
    "salon_id" UUID,
    "mesa_id" UUID,
    "plantilla_id" UUID,
    "reservacion_id" UUID,
    "numero_dia" INTEGER NOT NULL,
    "fecha_operativa" DATE NOT NULL,
    "turno" "turno_servicio" NOT NULL,
    "comensales" INTEGER NOT NULL DEFAULT 1,
    "mesero_id" UUID,
    "estado" "estado_comanda" NOT NULL DEFAULT 'abierta',
    "abierta_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cerrada_en" TIMESTAMPTZ(6),
    "subtotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "descuento" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "impuesto" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "propina" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "tasa_id" UUID,
    "tasa_valor" DECIMAL(18,8),
    "total_bs" DECIMAL(18,4),
    "anulada_por_id" UUID,
    "motivo_anulacion" TEXT,
    "notas" TEXT,
    "creada_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizada_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "comanda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comanda_item" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "comanda_id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "ronda" INTEGER NOT NULL DEFAULT 1,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "nombre_snap" TEXT NOT NULL,
    "precio_unitario_snap" DECIMAL(14,4) NOT NULL,
    "destino_snap" "destino_preparacion" NOT NULL,
    "cantidad" DECIMAL(14,3) NOT NULL,
    "descuento_linea" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "total_linea" DECIMAL(14,4) NOT NULL,
    "estado" "estado_comanda_item" NOT NULL DEFAULT 'pendiente',
    "nota" TEXT,
    "enviado_en" TIMESTAMPTZ(6),
    "servido_en" TIMESTAMPTZ(6),
    "cancelado_por_id" UUID,
    "motivo_cancelacion" TEXT,
    "creado_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "comanda_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comanda_pago" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "comanda_id" UUID NOT NULL,
    "metodo" "metodo_pago" NOT NULL,
    "moneda" "moneda" NOT NULL,
    "monto" DECIMAL(18,4) NOT NULL,
    "tasa_aplicada" DECIMAL(18,8),
    "monto_usd" DECIMAL(14,4) NOT NULL,
    "referencia" TEXT,
    "recibido_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registrado_por_id" UUID,

    CONSTRAINT "comanda_pago_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasa_cambio" (
    "id" UUID NOT NULL,
    "restaurante_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "valor" DECIMAL(18,8) NOT NULL,
    "fuente" "fuente_tasa" NOT NULL DEFAULT 'bcv',
    "registrada_por_id" UUID,
    "creada_en" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tasa_cambio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contador_comanda" (
    "restaurante_id" UUID NOT NULL,
    "fecha_operativa" DATE NOT NULL,
    "ultimo" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "contador_comanda_pkey" PRIMARY KEY ("restaurante_id","fecha_operativa")
);

-- CreateTable
CREATE TABLE "resumen_dia" (
    "restaurante_id" UUID NOT NULL,
    "fecha_operativa" DATE NOT NULL,
    "turno" "turno_servicio" NOT NULL,
    "comandas" INTEGER NOT NULL DEFAULT 0,
    "comensales" INTEGER NOT NULL DEFAULT 0,
    "total_usd" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "propinas_usd" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "descuentos_usd" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "por_metodo" JSONB NOT NULL DEFAULT '{}',
    "producto_top_id" UUID,
    "producto_top_cantidad" DECIMAL(14,3),
    "actualizado_en" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "resumen_dia_pkey" PRIMARY KEY ("restaurante_id","fecha_operativa","turno")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurante_slug_key" ON "restaurante"("slug");

-- CreateIndex
CREATE INDEX "usuario_restaurante_id_rol_activo_idx" ON "usuario"("restaurante_id", "rol", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_restaurante_id_key" ON "usuario"("restaurante_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_unico_por_restaurante" ON "usuario"("restaurante_id", "usuario");

-- CreateIndex
CREATE INDEX "salon_restaurante_id_orden_idx" ON "salon"("restaurante_id", "orden");

-- CreateIndex
CREATE UNIQUE INDEX "salon_restaurante_id_key" ON "salon"("restaurante_id", "id");

-- CreateIndex
CREATE INDEX "mesa_restaurante_id_salon_id_idx" ON "mesa"("restaurante_id", "salon_id");

-- CreateIndex
CREATE UNIQUE INDEX "mesa_restaurante_id_key" ON "mesa"("restaurante_id", "id");

-- CreateIndex
CREATE INDEX "plantilla_restaurante_id_salon_id_idx" ON "plantilla"("restaurante_id", "salon_id");

-- CreateIndex
CREATE UNIQUE INDEX "plantilla_restaurante_id_key" ON "plantilla"("restaurante_id", "id");

-- CreateIndex
CREATE INDEX "plantilla_mesa_restaurante_id_mesa_id_idx" ON "plantilla_mesa"("restaurante_id", "mesa_id");

-- CreateIndex
CREATE UNIQUE INDEX "plantilla_mesa_restaurante_key" ON "plantilla_mesa"("restaurante_id", "plantilla_id", "mesa_id");

-- CreateIndex
CREATE INDEX "categoria_restaurante_id_orden_idx" ON "categoria"("restaurante_id", "orden");

-- CreateIndex
CREATE UNIQUE INDEX "categoria_restaurante_id_key" ON "categoria"("restaurante_id", "id");

-- CreateIndex
CREATE INDEX "producto_restaurante_id_categoria_id_orden_idx" ON "producto"("restaurante_id", "categoria_id", "orden");

-- CreateIndex
CREATE INDEX "producto_restaurante_id_destino_idx" ON "producto"("restaurante_id", "destino");

-- CreateIndex
CREATE UNIQUE INDEX "producto_restaurante_id_key" ON "producto"("restaurante_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reservacion_codigo_publico_key" ON "reservacion"("codigo_publico");

-- CreateIndex
CREATE INDEX "reservacion_restaurante_id_inicia_en_idx" ON "reservacion"("restaurante_id", "inicia_en");

-- CreateIndex
CREATE INDEX "reservacion_restaurante_id_estado_inicia_en_idx" ON "reservacion"("restaurante_id", "estado", "inicia_en");

-- CreateIndex
CREATE INDEX "reservacion_restaurante_id_mesa_id_inicia_en_idx" ON "reservacion"("restaurante_id", "mesa_id", "inicia_en");

-- CreateIndex
CREATE UNIQUE INDEX "reservacion_restaurante_id_key" ON "reservacion"("restaurante_id", "id");

-- CreateIndex
CREATE INDEX "comanda_restaurante_id_fecha_operativa_estado_idx" ON "comanda"("restaurante_id", "fecha_operativa", "estado");

-- CreateIndex
CREATE INDEX "comanda_restaurante_id_estado_abierta_en_idx" ON "comanda"("restaurante_id", "estado", "abierta_en");

-- CreateIndex
CREATE INDEX "comanda_restaurante_id_mesero_id_fecha_operativa_idx" ON "comanda"("restaurante_id", "mesero_id", "fecha_operativa");

-- CreateIndex
CREATE UNIQUE INDEX "comanda_restaurante_id_key" ON "comanda"("restaurante_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "comanda_numero_dia_unico" ON "comanda"("restaurante_id", "fecha_operativa", "numero_dia");

-- CreateIndex
CREATE UNIQUE INDEX "comanda_reservacion_unica" ON "comanda"("restaurante_id", "reservacion_id");

-- CreateIndex
CREATE INDEX "comanda_item_comanda_id_ronda_orden_idx" ON "comanda_item"("comanda_id", "ronda", "orden");

-- CreateIndex
CREATE INDEX "comanda_item_restaurante_id_producto_id_idx" ON "comanda_item"("restaurante_id", "producto_id");

-- CreateIndex
CREATE INDEX "comanda_item_restaurante_id_destino_snap_estado_enviado_en_idx" ON "comanda_item"("restaurante_id", "destino_snap", "estado", "enviado_en");

-- CreateIndex
CREATE UNIQUE INDEX "comanda_item_restaurante_id_key" ON "comanda_item"("restaurante_id", "id");

-- CreateIndex
CREATE INDEX "comanda_pago_comanda_id_idx" ON "comanda_pago"("comanda_id");

-- CreateIndex
CREATE INDEX "comanda_pago_restaurante_id_recibido_en_idx" ON "comanda_pago"("restaurante_id", "recibido_en");

-- CreateIndex
CREATE UNIQUE INDEX "comanda_pago_restaurante_id_key" ON "comanda_pago"("restaurante_id", "id");

-- CreateIndex
CREATE INDEX "tasa_cambio_restaurante_id_fecha_idx" ON "tasa_cambio"("restaurante_id", "fecha" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tasa_cambio_restaurante_id_key" ON "tasa_cambio"("restaurante_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tasa_cambio_dia_unica" ON "tasa_cambio"("restaurante_id", "fecha", "fuente");

-- AddForeignKey
ALTER TABLE "usuario" ADD CONSTRAINT "usuario_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon" ADD CONSTRAINT "salon_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mesa" ADD CONSTRAINT "mesa_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mesa" ADD CONSTRAINT "mesa_restaurante_id_salon_id_fkey" FOREIGN KEY ("restaurante_id", "salon_id") REFERENCES "salon"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plantilla" ADD CONSTRAINT "plantilla_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plantilla" ADD CONSTRAINT "plantilla_restaurante_id_salon_id_fkey" FOREIGN KEY ("restaurante_id", "salon_id") REFERENCES "salon"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plantilla" ADD CONSTRAINT "plantilla_restaurante_id_clonada_de_id_fkey" FOREIGN KEY ("restaurante_id", "clonada_de_id") REFERENCES "plantilla"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plantilla" ADD CONSTRAINT "plantilla_restaurante_id_creada_por_id_fkey" FOREIGN KEY ("restaurante_id", "creada_por_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plantilla_mesa" ADD CONSTRAINT "plantilla_mesa_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plantilla_mesa" ADD CONSTRAINT "plantilla_mesa_restaurante_id_plantilla_id_fkey" FOREIGN KEY ("restaurante_id", "plantilla_id") REFERENCES "plantilla"("restaurante_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plantilla_mesa" ADD CONSTRAINT "plantilla_mesa_restaurante_id_mesa_id_fkey" FOREIGN KEY ("restaurante_id", "mesa_id") REFERENCES "mesa"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categoria" ADD CONSTRAINT "categoria_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_restaurante_id_categoria_id_fkey" FOREIGN KEY ("restaurante_id", "categoria_id") REFERENCES "categoria"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservacion" ADD CONSTRAINT "reservacion_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservacion" ADD CONSTRAINT "reservacion_restaurante_id_salon_id_fkey" FOREIGN KEY ("restaurante_id", "salon_id") REFERENCES "salon"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservacion" ADD CONSTRAINT "reservacion_restaurante_id_plantilla_id_fkey" FOREIGN KEY ("restaurante_id", "plantilla_id") REFERENCES "plantilla"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservacion" ADD CONSTRAINT "reservacion_restaurante_id_mesa_id_fkey" FOREIGN KEY ("restaurante_id", "mesa_id") REFERENCES "mesa"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservacion" ADD CONSTRAINT "reservacion_restaurante_id_creada_por_id_fkey" FOREIGN KEY ("restaurante_id", "creada_por_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda" ADD CONSTRAINT "comanda_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda" ADD CONSTRAINT "comanda_restaurante_id_salon_id_fkey" FOREIGN KEY ("restaurante_id", "salon_id") REFERENCES "salon"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda" ADD CONSTRAINT "comanda_restaurante_id_mesa_id_fkey" FOREIGN KEY ("restaurante_id", "mesa_id") REFERENCES "mesa"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda" ADD CONSTRAINT "comanda_restaurante_id_plantilla_id_fkey" FOREIGN KEY ("restaurante_id", "plantilla_id") REFERENCES "plantilla"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda" ADD CONSTRAINT "comanda_restaurante_id_reservacion_id_fkey" FOREIGN KEY ("restaurante_id", "reservacion_id") REFERENCES "reservacion"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda" ADD CONSTRAINT "comanda_restaurante_id_mesero_id_fkey" FOREIGN KEY ("restaurante_id", "mesero_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda" ADD CONSTRAINT "comanda_restaurante_id_anulada_por_id_fkey" FOREIGN KEY ("restaurante_id", "anulada_por_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda" ADD CONSTRAINT "comanda_restaurante_id_tasa_id_fkey" FOREIGN KEY ("restaurante_id", "tasa_id") REFERENCES "tasa_cambio"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda_item" ADD CONSTRAINT "comanda_item_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda_item" ADD CONSTRAINT "comanda_item_restaurante_id_comanda_id_fkey" FOREIGN KEY ("restaurante_id", "comanda_id") REFERENCES "comanda"("restaurante_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda_item" ADD CONSTRAINT "comanda_item_restaurante_id_producto_id_fkey" FOREIGN KEY ("restaurante_id", "producto_id") REFERENCES "producto"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda_item" ADD CONSTRAINT "comanda_item_restaurante_id_cancelado_por_id_fkey" FOREIGN KEY ("restaurante_id", "cancelado_por_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda_pago" ADD CONSTRAINT "comanda_pago_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda_pago" ADD CONSTRAINT "comanda_pago_restaurante_id_comanda_id_fkey" FOREIGN KEY ("restaurante_id", "comanda_id") REFERENCES "comanda"("restaurante_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comanda_pago" ADD CONSTRAINT "comanda_pago_restaurante_id_registrado_por_id_fkey" FOREIGN KEY ("restaurante_id", "registrado_por_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasa_cambio" ADD CONSTRAINT "tasa_cambio_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasa_cambio" ADD CONSTRAINT "tasa_cambio_restaurante_id_registrada_por_id_fkey" FOREIGN KEY ("restaurante_id", "registrada_por_id") REFERENCES "usuario"("restaurante_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contador_comanda" ADD CONSTRAINT "contador_comanda_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resumen_dia" ADD CONSTRAINT "resumen_dia_restaurante_id_fkey" FOREIGN KEY ("restaurante_id") REFERENCES "restaurante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
  ADD CONSTRAINT "plantilla_plano_valido" CHECK ("ancho_plano" > 0 AND "alto_plano" > 0);

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

-- ═══════════════════════════════════════════════════════════════════════════
-- 02 · Vistas de operación y reporte
--
-- Requiere PostgreSQL 15+ por `security_invoker`.
--
-- ⚠️ `WITH (security_invoker = true)` NO es cosmético. Por defecto una vista se
-- ejecuta con los permisos de SU DUEÑO, lo que significa que una vista creada
-- por el rol de migraciones SALTARÍA las políticas RLS del día que se activen
-- (03_rls.sql) y devolvería mesas de otros restaurantes. Con security_invoker
-- la vista se evalúa con el rol que consulta y RLS se aplica igual.
--
-- Prisma no modela vistas: sobreviven a `migrate dev` sin tocarlas. La
-- contrapartida es que una vista bloquea el ALTER de las columnas que usa; si
-- hay que cambiar una, la migración hace DROP VIEW → ALTER → CREATE VIEW.
-- Se leen con `$queryRaw`.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- v_mesa_estado · el plano, ya resuelto
--
-- Una fila por mesa dibujada en una plantilla, con su geometría y su estado
-- real AHORA. Sirve a las dos pantallas a la vez:
--   · editor de plano   → WHERE plantilla_id = $1
--   · vista operativa   → WHERE plantilla_id = $1 AND plantilla_activa
-- Evita que el frontend haga tres consultas y cruce estados a mano.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_mesa_estado" WITH (security_invoker = true) AS
SELECT
    pm."restaurante_id",
    pl."salon_id",
    pm."plantilla_id",
    pl."activa"       AS "plantilla_activa",
    pm."mesa_id",
    m."etiqueta",
    pm."pos_x", pm."pos_y", pm."ancho", pm."alto", pm."rotacion",
    pm."forma", pm."capacidad", pm."bloqueada",

    cmd."id"          AS "comanda_id",
    cmd."numero_dia"  AS "comanda_numero_dia",
    cmd."estado"      AS "comanda_estado",
    cmd."total"       AS "comanda_total",
    cmd."abierta_en"  AS "comanda_abierta_en",
    cmd."comensales"  AS "comanda_comensales",
    cmd."mesero_id"   AS "comanda_mesero_id",

    rsv."id"             AS "reservacion_id",
    rsv."inicia_en"      AS "reservacion_inicia_en",
    rsv."cliente_nombre" AS "reservacion_cliente",
    rsv."personas"       AS "reservacion_personas",

    CASE
      WHEN pm."bloqueada"     THEN 'bloqueada'
      WHEN cmd."id" IS NOT NULL THEN 'ocupada'
      WHEN rsv."id" IS NOT NULL THEN 'reservada'
      ELSE 'libre'
    END AS "estado"
FROM "plantilla_mesa" pm
JOIN "plantilla" pl
  ON pl."restaurante_id" = pm."restaurante_id" AND pl."id" = pm."plantilla_id"
JOIN "mesa" m
  ON m."restaurante_id" = pm."restaurante_id" AND m."id" = pm."mesa_id"
-- Comanda viva de esa mesa. El índice único parcial garantiza que hay 0 o 1,
-- y hace que este LATERAL sea una lectura de índice, no un escaneo.
LEFT JOIN LATERAL (
    SELECT c."id", c."numero_dia", c."estado", c."total",
           c."abierta_en", c."comensales", c."mesero_id"
      FROM "comanda" c
     WHERE c."restaurante_id" = pm."restaurante_id"
       AND c."mesa_id"        = pm."mesa_id"
       AND c."estado" IN ('abierta', 'por_cobrar')
     LIMIT 1
) cmd ON TRUE
-- Próxima reserva que ya "pesa" sobre la mesa: desde 30 min antes de la hora
-- hasta 2 h después (una reserva de las 8pm bloquea la mesa desde las 7:30).
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
) rsv ON TRUE;


-- ───────────────────────────────────────────────────────────────────────────
-- v_comanda_activa · el panel lateral
--
-- "Las comandas de las mesas ocupadas ahora", con lo que el panel muestra sin
-- pedir los ítems: cuántas líneas van, cuántas faltan por servir y hace cuánto
-- está sentada la mesa.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_comanda_activa" WITH (security_invoker = true) AS
SELECT
    c."id"            AS "comanda_id",
    c."restaurante_id",
    c."tipo",
    c."salon_id",
    c."mesa_id",
    m."etiqueta"      AS "mesa_etiqueta",
    c."numero_dia",
    c."estado",
    c."comensales",
    c."mesero_id",
    u."nombre"        AS "mesero_nombre",
    c."abierta_en",
    round(extract(epoch FROM (now() - c."abierta_en")) / 60)::int AS "minutos_abierta",
    c."subtotal", c."descuento", c."impuesto", c."propina", c."total",
    it."items",
    it."items_pendientes",
    it."ultimo_envio_en"
FROM "comanda" c
LEFT JOIN "mesa" m
  ON m."restaurante_id" = c."restaurante_id" AND m."id" = c."mesa_id"
LEFT JOIN "usuario" u
  ON u."restaurante_id" = c."restaurante_id" AND u."id" = c."mesero_id"
LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE ci."estado" <> 'cancelado')                         AS "items",
           count(*) FILTER (WHERE ci."estado" IN ('pendiente', 'en_preparacion'))      AS "items_pendientes",
           max(ci."enviado_en")                                                        AS "ultimo_envio_en"
      FROM "comanda_item" ci
     WHERE ci."comanda_id" = c."id"
) it ON TRUE
WHERE c."estado" IN ('abierta', 'por_cobrar');


-- ───────────────────────────────────────────────────────────────────────────
-- v_venta_dia · ventas por día operativo y turno
--
-- Fuente del "resumen de ventas del día". Sólo comandas cobradas.
-- `ventas_usd` excluye la propina a propósito: la propina es del mesero, no
-- ingreso del restaurante, y mezclarlas infla el reporte.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_venta_dia" WITH (security_invoker = true) AS
SELECT
    c."restaurante_id",
    c."fecha_operativa",
    c."turno",
    count(*)                                   AS "comandas",
    sum(c."comensales")                        AS "comensales",
    sum(c."total")                             AS "total_usd",
    sum(c."total" - c."propina")               AS "ventas_usd",
    sum(c."propina")                           AS "propinas_usd",
    sum(c."descuento")                         AS "descuentos_usd",
    sum(c."impuesto")                          AS "impuestos_usd",
    round(avg(c."total"), 4)                   AS "ticket_promedio_usd",
    round(avg(NULLIF(c."comensales", 0)), 2)   AS "comensales_promedio"
FROM "comanda" c
WHERE c."estado" = 'cobrada'
GROUP BY c."restaurante_id", c."fecha_operativa", c."turno";


-- ───────────────────────────────────────────────────────────────────────────
-- v_venta_dia_metodo · desglose por método de pago (cuadre de caja)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_venta_dia_metodo" WITH (security_invoker = true) AS
SELECT
    c."restaurante_id",
    c."fecha_operativa",
    p."metodo",
    p."moneda",
    count(*)           AS "pagos",
    sum(p."monto")     AS "monto_moneda",
    sum(p."monto_usd") AS "monto_usd"
FROM "comanda_pago" p
JOIN "comanda" c
  ON c."restaurante_id" = p."restaurante_id" AND c."id" = p."comanda_id"
WHERE c."estado" = 'cobrada'
GROUP BY c."restaurante_id", c."fecha_operativa", p."metodo", p."moneda";


-- ───────────────────────────────────────────────────────────────────────────
-- v_producto_vendido_dia · base del "producto más vendido"
--
-- Una fila por producto y día. El ranking se saca encima con ORDER BY:
--   · por cantidad → ORDER BY cantidad DESC
--   · por ingreso  → ORDER BY ingreso_usd DESC
-- (son respuestas distintas: la empanada gana por unidades, el solomo por
-- ingreso; por eso la vista devuelve las dos y no decide por el negocio).
-- Los ítems cancelados no cuentan: se pidieron, no se vendieron.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_producto_vendido_dia" WITH (security_invoker = true) AS
SELECT
    c."restaurante_id",
    c."fecha_operativa",
    c."turno",
    ci."producto_id",
    ci."nombre_snap"       AS "producto_nombre",
    sum(ci."cantidad")     AS "cantidad",
    sum(ci."total_linea")  AS "ingreso_usd",
    count(DISTINCT ci."comanda_id") AS "comandas"
FROM "comanda_item" ci
JOIN "comanda" c
  ON c."restaurante_id" = ci."restaurante_id" AND c."id" = ci."comanda_id"
WHERE c."estado" = 'cobrada'
  AND ci."estado" <> 'cancelado'
GROUP BY c."restaurante_id", c."fecha_operativa", c."turno",
         ci."producto_id", ci."nombre_snap";


-- ───────────────────────────────────────────────────────────────────────────
-- v_comanda_descuadre · auditoría de caja
--
-- Comandas cobradas donde la suma de los pagos no coincide con el total.
-- No se puede expresar como CHECK (cruza dos tablas) y no debería ocurrir
-- nunca: si aparece una fila aquí, hay un bug de cobro o un cobro a medias.
-- Consultarla en el cierre de caja.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_comanda_descuadre" WITH (security_invoker = true) AS
SELECT
    c."restaurante_id",
    c."fecha_operativa",
    c."id" AS "comanda_id",
    c."numero_dia",
    c."total"                        AS "total_comanda",
    coalesce(sum(p."monto_usd"), 0)  AS "total_pagado",
    c."total" - coalesce(sum(p."monto_usd"), 0) AS "diferencia"
FROM "comanda" c
LEFT JOIN "comanda_pago" p
  ON p."restaurante_id" = c."restaurante_id" AND p."comanda_id" = c."id"
WHERE c."estado" = 'cobrada'
GROUP BY c."restaurante_id", c."fecha_operativa", c."id", c."numero_dia", c."total"
HAVING abs(c."total" - coalesce(sum(p."monto_usd"), 0)) > 0.01;


-- ───────────────────────────────────────────────────────────────────────────
-- v_reservacion_huerfana · reservas que quedaron fuera del plano
--
-- Se reservó la mesa 12 contra la plantilla "Normal" y para el sábado se
-- activó "Evento boda", donde esa mesa no existe. La reserva sigue viva pero
-- apunta a una mesa que ya no está dibujada. El anfitrión tiene que verlo
-- ANTES del sábado, no cuando llegue el cliente.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "v_reservacion_huerfana" WITH (security_invoker = true) AS
SELECT
    r."restaurante_id",
    r."id" AS "reservacion_id",
    r."inicia_en",
    r."cliente_nombre",
    r."personas",
    r."mesa_id",
    m."etiqueta" AS "mesa_etiqueta",
    r."plantilla_id" AS "plantilla_reservada_id",
    act."id"         AS "plantilla_activa_id",
    act."nombre"     AS "plantilla_activa_nombre"
FROM "reservacion" r
JOIN "mesa" m
  ON m."restaurante_id" = r."restaurante_id" AND m."id" = r."mesa_id"
-- LEFT y no JOIN: un salón sin plantilla activa deja a TODAS sus reservas
-- huérfanas, que es precisamente el caso que hay que ver.
LEFT JOIN LATERAL (
    SELECT pl."id", pl."nombre"
      FROM "plantilla" pl
     WHERE pl."restaurante_id" = r."restaurante_id"
       AND pl."salon_id"       = r."salon_id"
       AND pl."activa"
     LIMIT 1
) act ON TRUE
WHERE r."mesa_id" IS NOT NULL
  AND r."estado" IN ('pendiente', 'confirmada')
  AND r."inicia_en" >= now()
  AND NOT EXISTS (
        SELECT 1
          FROM "plantilla_mesa" pm
         WHERE pm."restaurante_id" = r."restaurante_id"
           AND pm."plantilla_id"   = act."id"
           AND pm."mesa_id"        = r."mesa_id"
           AND NOT pm."bloqueada"
      );
