// Configuración del CLI de Prisma 7. La URL de la base NO va en schema.prisma:
// se lee de aquí, y aquí de las variables de entorno.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Rol DUEÑO de las tablas: es el que corre las migraciones.
    // La aplicación se conecta con otro rol, sin BYPASSRLS (ver prisma/sql/03_rls.sql).
    url: process.env["DATABASE_URL"],
    // Necesaria sólo para `prisma migrate dev` (crea y destruye la shadow DB).
    // `prisma migrate deploy`, que es lo que corre en producción, no la usa.
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
