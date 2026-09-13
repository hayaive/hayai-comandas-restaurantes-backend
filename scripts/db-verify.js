#!/usr/bin/env node
/**
 * Corre prisma/sql/99_verificar_objetos.sql contra DATABASE_URL.
 *
 * Por qué existe: Prisma modela tablas/columnas/índices pero no los índices
 * parciales, EXCLUDE, triggers, funciones ni vistas de prisma/sql/. Si una
 * migración generada trae un `DROP INDEX` sobre alguno de esos objetos y se
 * aplica sin revisar, el sistema pierde EN SILENCIO la prohibición de doble
 * reserva o de doble comanda. Este script convierte ese fallo silencioso en
 * un build roto — pensado para CI y para correr después de cada
 * `prisma migrate deploy`.
 *
 * Uso: node scripts/db-verify.js   (o `npm run db:verify`)
 */
require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Falta DATABASE_URL en el entorno.');
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, '..', 'prisma', 'sql', '99_verificar_objetos.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const client = new Client({ connectionString });
  client.on('notice', (msg) => console.log(`[postgres] ${msg.message}`));

  await client.connect();
  try {
    await client.query(sql);
    console.log('db:verify OK — todos los objetos de prisma/sql están presentes.');
  } catch (err) {
    console.error('db:verify FALLÓ:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
