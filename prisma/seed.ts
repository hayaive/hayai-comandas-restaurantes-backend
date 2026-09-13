/**
 * Seed mínimo para desarrollo local y smoke tests: un restaurante, un
 * administrador, un salón con una plantilla activa y dos mesas, una
 * categoría y dos productos. No se corre en producción.
 *
 * Uso: npm run db:seed
 */
import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { nuevoId } from '../src/comun/id';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Falta DATABASE_URL');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  const restauranteId = nuevoId();
  const restaurante = await prisma.restaurante.upsert({
    where: { slug: 'demo' },
    update: {},
    create: {
      id: restauranteId,
      slug: 'demo',
      nombre: 'Restaurante Demo HAYAI',
      monedaBase: 'USD',
      zonaHoraria: 'America/Caracas',
      duracionReservaMin: 90,
      permiteAutoseleccion: true,
    },
  });

  const claveHash = await argon2.hash('admin1234');
  const pinHash = await argon2.hash('1234');
  await prisma.usuario.upsert({
    where: { restauranteId_usuario: { restauranteId: restaurante.id, usuario: 'admin' } },
    update: {},
    create: {
      id: nuevoId(),
      restauranteId: restaurante.id,
      nombre: 'Administrador Demo',
      usuario: 'admin',
      claveHash,
      pinHash,
      rol: 'administrador',
    },
  });

  let salon = await prisma.salon.findFirst({ where: { restauranteId: restaurante.id, nombre: 'Salón principal' } });
  if (!salon) {
    salon = await prisma.salon.create({
      data: { id: nuevoId(), restauranteId: restaurante.id, nombre: 'Salón principal', orden: 0 },
    });
  }

  let plantilla = await prisma.plantilla.findFirst({ where: { restauranteId: restaurante.id, salonId: salon.id } });
  if (!plantilla) {
    plantilla = await prisma.plantilla.create({
      data: {
        id: nuevoId(),
        restauranteId: restaurante.id,
        salonId: salon.id,
        nombre: 'Distribución normal',
        activa: true,
      },
    });

    const mesa1 = await prisma.mesa.create({
      data: { id: nuevoId(), restauranteId: restaurante.id, salonId: salon.id, etiqueta: '1', capacidadDefault: 4 },
    });
    const mesa2 = await prisma.mesa.create({
      data: { id: nuevoId(), restauranteId: restaurante.id, salonId: salon.id, etiqueta: '2', capacidadDefault: 2 },
    });

    await prisma.plantillaMesa.createMany({
      data: [
        {
          restauranteId: restaurante.id,
          plantillaId: plantilla.id,
          mesaId: mesa1.id,
          posX: 40,
          posY: 40,
          forma: 'cuadrada',
          capacidad: 4,
        },
        {
          restauranteId: restaurante.id,
          plantillaId: plantilla.id,
          mesaId: mesa2.id,
          posX: 200,
          posY: 40,
          forma: 'redonda',
          capacidad: 2,
        },
      ],
    });
  }

  let categoria = await prisma.categoria.findFirst({ where: { restauranteId: restaurante.id, nombre: 'Platos fuertes' } });
  if (!categoria) {
    categoria = await prisma.categoria.create({
      data: { id: nuevoId(), restauranteId: restaurante.id, nombre: 'Platos fuertes' },
    });
    await prisma.producto.createMany({
      data: [
        {
          id: nuevoId(),
          restauranteId: restaurante.id,
          categoriaId: categoria.id,
          nombre: 'Pabellón criollo',
          precio: '12.5000',
          destino: 'cocina',
        },
        {
          id: nuevoId(),
          restauranteId: restaurante.id,
          categoriaId: categoria.id,
          nombre: 'Empanada de queso',
          precio: '1.5000',
          destino: 'cocina',
        },
      ],
    });
  }

  console.log('Seed listo:');
  console.log(`  restaurante: ${restaurante.slug} (${restaurante.id})`);
  console.log('  usuario: admin / clave: admin1234 / pin: 1234');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
