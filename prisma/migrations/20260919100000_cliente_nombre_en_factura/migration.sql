-- El nombre del cliente que escribe el mesero al tomar el pedido no tenía dónde
-- guardarse, y la factura salía siempre "Consumidor final".
--
-- Aditiva: dos columnas NULL (sin default, sin reescritura de tabla) y dos CHECK
-- que sólo miran la fila nueva. Las filas existentes quedan en NULL, que el
-- ticket ya imprime como "Consumidor final".
--
--   comanda.cliente_nombre  lo que escribió el mesero (puede no venir).
--   cobro.cliente_nombre    el nombre CONGELADO en la factura; lo que se imprime
--                           y se reimprime. Lo resuelve el servidor al cobrar.
--
-- El tope de longitud (120) vive en los DTOs, no aquí: un CHECK de longitud
-- bloquearía un cobro cuyo nombre se copió de una reserva sin tope.
-- Detalle en docs/DECISIONES-DATOS.md §14.

ALTER TABLE "comanda" ADD COLUMN "cliente_nombre" TEXT;
ALTER TABLE "cobro"   ADD COLUMN "cliente_nombre" TEXT;

ALTER TABLE "comanda" ADD CONSTRAINT "comanda_cliente_nombre_normalizado" CHECK ("cliente_nombre" IS NULL OR (length("cliente_nombre") > 0 AND "cliente_nombre" = btrim("cliente_nombre")));
ALTER TABLE "cobro"   ADD CONSTRAINT "cobro_cliente_nombre_normalizado" CHECK ("cliente_nombre" IS NULL OR (length("cliente_nombre") > 0 AND "cliente_nombre" = btrim("cliente_nombre")));
