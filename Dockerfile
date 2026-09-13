# ── HAYAI Comandas · backend — imagen de producción (Railway) ───────────────
# Prisma 7 con "prisma-client" + driver adapters no usa el motor Rust nativo,
# así que no hace falta libssl ni binarios de plataforma: una imagen node
# "slim" corriente basta.

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Genera el cliente de Prisma (src/generated/prisma) y compila TypeScript.
RUN npx prisma generate --config prisma7.config.ts
RUN npm run build

# ── Etapa final: sólo lo necesario para correr ───────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci

COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./dist/generated
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma7.config.ts ./prisma7.config.ts
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
# TEMP: fuente TS completa sólo para poder correr `db:seed` (ts-node) una vez
# contra produccion. Revertir junto con prestart:prod y `npm ci --omit=dev`.
COPY --from=build /app/src ./src

EXPOSE 3000

# db:deploy (prisma migrate deploy) corre SIEMPRE antes de levantar el server
# (ver "prestart:prod" en package.json) — nunca `migrate dev` en producción.
CMD ["npm", "run", "start:prod"]
