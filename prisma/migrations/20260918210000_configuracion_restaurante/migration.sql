-- CreateEnum
CREATE TYPE "vista_precios" AS ENUM ('usd', 'bs', 'ambas');

-- AlterTable
ALTER TABLE "restaurante" ADD COLUMN     "logo_url" TEXT,
ADD COLUMN     "mostrar_precios_en" "vista_precios" NOT NULL DEFAULT 'ambas';

ALTER TABLE "restaurante"
  -- El nombre deja de venir de una variable de entorno y pasa a ser texto libre
  -- de un formulario que termina en la cabecera del ticket térmico, en la
  -- tarjeta de WhatsApp y en el título de una notificación push. `btrim` no es
  -- decorativo: sin él "   " pasa `length > 0` y el ticket sale sin cabecera.
  ADD CONSTRAINT "restaurante_nombre_acotado" CHECK (
    length(btrim("nombre")) BETWEEN 1 AND 60
  ),
  -- Lista blanca de FORMA, no cota de longitud. Este valor lo escribe el mismo
  -- PATCH que el dueño controla, así que NO está garantizado que venga de
  -- nuestro endpoint de subida: sin esto, cualquiera con token puede poner un
  -- rastreador de terceros en el ticket del cliente.
  ADD CONSTRAINT "restaurante_logo_url_valida" CHECK (
    "logo_url" IS NULL OR
    "logo_url" ~ '^/uploads/restaurante/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
  ),
  -- EL CHECK QUE CONVIERTE UNA SUPOSICIÓN EN UN INVARIANTE. `moneda_base` no la
  -- lee NADIE en src/ (único uso: prisma/seed.ts la escribe), pero TODO el
  -- sistema la da por sentada. Una columna que todos asumen y nada verifica es
  -- una trampa cargada.
  ADD CONSTRAINT "restaurante_moneda_base_usd" CHECK ("moneda_base" = 'USD');
