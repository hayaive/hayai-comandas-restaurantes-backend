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
