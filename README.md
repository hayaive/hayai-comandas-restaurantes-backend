# hayai-comandas-restaurantes-backend

Backend de comandas y gestión de salón para restaurantes (NestJS 10 + Prisma 7 + PostgreSQL 17).

## Estado

Diseño de datos verificado (J.O.R.B.I) e implementación de la API completa según
`CONTRACT.md` (D.A.N.I): salones/plantillas/mesas, reservaciones (staff + enlace
público + QR + check-in), comandas/pedidos, catálogo de productos y reportes.

| Documento | Qué contiene |
|---|---|
| [`CONTRACT.md`](CONTRACT.md) | Entidades, campos, relaciones, flujos y firmas de endpoints. |
| [`docs/DECISIONES-DATOS.md`](docs/DECISIONES-DATOS.md) | Por qué el modelo es así, índices, trampas de Prisma y decisiones abiertas |
| [`prisma/schema.prisma`](prisma/schema.prisma) | Esquema (fuente de verdad de tablas y columnas) |
| [`prisma/sql/`](prisma/sql/) | DDL que Prisma no sabe generar: índices parciales, EXCLUDE, triggers, vistas y RLS |

## Puesta en marcha local

```bash
npm install
cp .env.example .env          # y ajustar las credenciales (DATABASE_URL, JWT_SECRET, ...)

npx prisma migrate dev --create-only --name fundacion
#  1. pegar prisma/sql/00_extensiones.sql AL PRINCIPIO del migration.sql generado
#  2. pegar 01_constraints_y_triggers.sql y 02_vistas.sql AL FINAL
#     (03_rls.sql se aplica más tarde: ver su propio encabezado)
npx prisma migrate dev
npm run db:verify              # corre prisma/sql/99_verificar_objetos.sql

npm run db:seed                # restaurante + admin de prueba: admin / admin1234 (pin 1234)
npm run start:dev              # http://localhost:3000/api/v1
```

> Esta migración de fundación ya está generada y aplicada en este repo
> (`prisma/migrations/20260912235352_fundacion/`), con las tres secciones de
> `prisma/sql/` insertadas a mano. Para un entorno nuevo, sólo hace falta
> `npx prisma migrate deploy` (o `npm run db:deploy`) + `npm run db:verify`.

**Regla permanente para migraciones futuras:** generarlas con
`npx prisma migrate dev --create-only`, leer el SQL y borrar cualquier
`DROP INDEX` que apunte a un índice de `prisma/sql/`. Prisma no conoce los
índices parciales y los considera basura; perderlos desactiva en silencio la
prohibición de doble reserva y de doble comanda por mesa. `npm run db:verify`
(usa `99_verificar_objetos.sql`) convierte ese fallo silencioso en un build roto
— correrlo tras cada `migrate deploy`, también en CI.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run start:dev` | Servidor con recarga en caliente |
| `npm run build` | Compila a `dist/` |
| `npm run start:prod` | Corre `db:deploy` (migrate deploy) y luego `dist/main.js` — pensado para Railway |
| `npm run db:migrate:new` | `prisma migrate dev --create-only` |
| `npm run db:deploy` | `prisma migrate deploy` (producción, no interactivo) |
| `npm run db:verify` | Corre la guardia `99_verificar_objetos.sql` |
| `npm run db:seed` | Restaurante + usuario admin de prueba |
| `npm run test:e2e` | Smoke tests de los invariantes críticos (doble reserva, doble comanda) contra una base real |

## Notas de implementación

- Multi-restaurante: todos los endpoints ya resuelven `restauranteId` desde el
  token verificado (nunca del body/query/header). RLS (`prisma/sql/03_rls.sql`)
  sigue diferido, tal como lo decidió J.O.R.B.I.
- `POST /auth/login` busca el usuario por nombre sin desambiguar por
  restaurante (es único hoy porque sólo hay un restaurante activo). El día que
  entre un segundo restaurante, ese endpoint necesita un dato extra (p.ej. el
  slug) — abrir ese cambio de contrato junto con la activación de RLS.
- Errores de Postgres (constraints a mano, EXCLUDE, CHECK) se traducen a HTTP
  en `src/comun/filtros/pg-error.filter.ts`, por nombre de constraint —
  verificado contra los mensajes reales que devuelve `@prisma/adapter-pg`.
