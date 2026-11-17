import 'dotenv/config';
import * as argon2 from 'argon2';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configurarApp } from '../src/configurar-app';
import { PrismaService } from '../src/comun/prisma/prisma.service';
import { nuevoId } from '../src/comun/id';

/**
 * Un restaurante de prueba completo (admin, salón con distribución activa,
 * mesas, un producto de 10 USD y la tasa del dólar), con la app Nest levantada
 * y la sesión iniciada. Cada corrida crea el suyo (slug único): no interfiere
 * con otras corridas ni con el seed de desarrollo.
 */
export interface Fixture {
  app: INestApplication;
  prisma: PrismaService;
  restauranteId: string;
  salonId: string;
  plantillaId: string;
  mesas: string[];
  productoId: string;
  categoriaId: string;
  usuarioId: string;
  auth: { Authorization: string };
  token: string;
  http: () => ReturnType<typeof request>;
  /** Borra el restaurante y cierra la app. */
  cerrar: () => Promise<void>;
}

export async function montar(prefijo: string, etiquetasMesas: string[] = ['T1', 'T2', 'T3', 'T4']): Promise<Fixture> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configurarApp(app);
  await app.init();
  const prisma = app.get(PrismaService);

  const slug = `${prefijo}-${Date.now()}`;
  const restauranteId = nuevoId();
  await prisma.restaurante.create({ data: { id: restauranteId, slug, nombre: 'Restaurante de prueba' } });

  const usuarioId = nuevoId();
  await prisma.usuario.create({
    data: {
      id: usuarioId,
      restauranteId,
      nombre: 'Admin de prueba',
      usuario: `admin-${slug}`,
      claveHash: await argon2.hash('clave1234'),
      rol: 'administrador',
    },
  });

  const salonId = nuevoId();
  await prisma.salon.create({ data: { id: salonId, restauranteId, nombre: 'Salón de prueba' } });
  const plantillaId = nuevoId();
  await prisma.plantilla.create({
    data: { id: plantillaId, restauranteId, salonId, nombre: 'Distribución de prueba', activa: true },
  });
  const mesas: string[] = [];
  for (const etiqueta of etiquetasMesas) {
    const id = nuevoId();
    mesas.push(id);
    await prisma.mesa.create({ data: { id, restauranteId, salonId, etiqueta } });
    await prisma.plantillaMesa.create({
      data: { restauranteId, plantillaId, mesaId: id, posX: 0, posY: 0, forma: 'cuadrada', capacidad: 4 },
    });
  }

  const categoriaId = nuevoId();
  await prisma.categoria.create({ data: { id: categoriaId, restauranteId, nombre: 'Cocina' } });
  const productoId = nuevoId();
  await prisma.producto.create({ data: { id: productoId, restauranteId, categoriaId, nombre: 'Pabellón', precio: 10 } });

  // Sin tasa del dólar no se puede emitir ninguna factura.
  await prisma.tasaCambio.create({
    data: { id: nuevoId(), restauranteId, fecha: new Date(), divisa: 'USD', valor: 900 },
  });

  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ usuario: `admin-${slug}`, clave: 'clave1234' })
    .expect(200);
  const token = login.body.token as string;

  return {
    app,
    prisma,
    restauranteId,
    salonId,
    plantillaId,
    mesas,
    productoId,
    categoriaId,
    usuarioId,
    auth: { Authorization: `Bearer ${token}` },
    token,
    http: () => request(app.getHttpServer()),
    cerrar: async () => {
      await borrarRestaurante(prisma, restauranteId);
      await app.close();
    },
  };
}

/**
 * Borra el restaurante en el orden que piden las FK RESTRICT y en UNA sola
 * transacción: el constraint trigger diferido `cobro_coherente` verifica al
 * COMMIT, y para entonces la factura ya no existe.
 */
export async function borrarRestaurante(prisma: PrismaService, restauranteId: string) {
  const id = restauranteId;
  await prisma
    .$transaction([
      prisma.$executeRaw`DELETE FROM "comanda" WHERE "restaurante_id" = ${id}::uuid`,
      prisma.$executeRaw`DELETE FROM "cobro" WHERE "restaurante_id" = ${id}::uuid`,
      prisma.$executeRaw`DELETE FROM "cliente" WHERE "restaurante_id" = ${id}::uuid`,
      prisma.$executeRaw`DELETE FROM "bitacora" WHERE "restaurante_id" = ${id}::uuid`,
    ])
    .then(() => prisma.restaurante.delete({ where: { id } }))
    .catch(() => undefined);
}
