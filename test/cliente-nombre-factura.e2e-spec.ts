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
 * Nombre del cliente en la factura (docs/DECISIONES-DATOS.md §14).
 * Cada corrida crea su propio restaurante, igual que invariantes.e2e-spec.ts.
 */
describe('Nombre del cliente en la factura (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let restauranteId: string;
  let salonId: string;
  let productoId: string;
  let auth: { Authorization: string };
  const mesas: string[] = [];

  const http = () => request(app.getHttpServer());
  const crearComanda = (mesaId: string, extra: Record<string, unknown> = {}) =>
    http()
      .post('/api/v1/comandas')
      .set(auth)
      .send({ tipo: 'mesa', mesaId, comensales: 2, items: [{ productoId, cantidad: 1 }], ...extra });
  const despachar = (id: string) => http().post(`/api/v1/comandas/${id}/despachar`).set(auth);
  const cobrar = (mesaId: string, extra: Record<string, unknown> = {}) =>
    http()
      .post(`/api/v1/mesas/${mesaId}/cobrar`)
      .set(auth)
      .send({ pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: 10 }], ...extra });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configurarApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const slug = `test-cn-${Date.now()}`;
    restauranteId = nuevoId();
    await prisma.restaurante.create({ data: { id: restauranteId, slug, nombre: 'Restaurante de prueba' } });
    await prisma.usuario.create({
      data: {
        id: nuevoId(),
        restauranteId,
        nombre: 'Admin de prueba',
        usuario: `admin-${slug}`,
        claveHash: await argon2.hash('clave1234'),
        rol: 'administrador',
      },
    });
    salonId = nuevoId();
    await prisma.salon.create({ data: { id: salonId, restauranteId, nombre: 'Salón de prueba' } });
    const plantillaId = nuevoId();
    await prisma.plantilla.create({
      data: { id: plantillaId, restauranteId, salonId, nombre: 'Distribución de prueba', activa: true },
    });
    for (const etiqueta of ['T1', 'T2', 'T3', 'T4']) {
      const id = nuevoId();
      mesas.push(id);
      await prisma.mesa.create({ data: { id, restauranteId, salonId, etiqueta } });
      await prisma.plantillaMesa.create({
        data: { restauranteId, plantillaId, mesaId: id, posX: 0, posY: 0, forma: 'cuadrada', capacidad: 4 },
      });
    }
    const categoriaId = nuevoId();
    await prisma.categoria.create({ data: { id: categoriaId, restauranteId, nombre: 'Cocina' } });
    productoId = nuevoId();
    await prisma.producto.create({ data: { id: productoId, restauranteId, categoriaId, nombre: 'Pabellón', precio: 10 } });
    await prisma.tasaCambio.create({
      data: { id: nuevoId(), restauranteId, fecha: new Date(), divisa: 'USD', valor: 900 },
    });

    const login = await http().post('/api/v1/auth/login').send({ usuario: `admin-${slug}`, clave: 'clave1234' }).expect(200);
    auth = { Authorization: `Bearer ${login.body.token}` };
  }, 30_000);

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "comanda" WHERE "restaurante_id" = ${restauranteId}::uuid`;
    await prisma.$executeRaw`DELETE FROM "cobro"   WHERE "restaurante_id" = ${restauranteId}::uuid`;
    await prisma.restaurante.delete({ where: { id: restauranteId } }).catch(() => undefined);
    await app.close();
  });

  it('crear comanda: guarda con trim, blanco = NULL, más de 120 = 400', async () => {
    const [m] = mesas;
    const a = await crearComanda(m, { clienteNombre: '  Luis  ' }).expect(201);
    expect(a.body.clienteNombre).toBe('Luis');
    const b = await crearComanda(m, { clienteNombre: '   ' }).expect(201);
    expect(b.body.clienteNombre).toBeNull();
    const c = await crearComanda(m).expect(201);
    expect(c.body.clienteNombre).toBeNull();
    await crearComanda(m, { clienteNombre: 'x'.repeat(121) }).expect(400);
    for (const x of [a, b, c]) await prisma.comanda.update({ where: { id: x.body.id }, data: { anuladaEn: new Date() } });
  });

  it('(a) la ronda 2 sin nombre factura con el de la ronda 1; y la reimpresión lo conserva', async () => {
    const m = mesas[0];
    const r1 = await crearComanda(m, { clienteNombre: 'Ana Pérez' }).expect(201);
    const r2 = await crearComanda(m).expect(201);
    await despachar(r1.body.id).expect(201);
    await despachar(r2.body.id).expect(201);

    const { body: cuenta } = await http().get(`/api/v1/mesas/${m}/cuenta`).set(auth).expect(200);
    expect(cuenta.clienteNombreSugerido).toBe('Ana Pérez');

    const { body: cobro } = await cobrar(m, { pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: 20 }] }).expect(201);
    expect(cobro.clienteNombre).toBe('Ana Pérez');

    const { body: reimpreso } = await http().get(`/api/v1/cobros/${cobro.id}`).set(auth).expect(200);
    expect(reimpreso.clienteNombre).toBe('Ana Pérez');
    const { body: dia } = await http().get('/api/v1/cobros').set(auth).expect(200);
    expect(dia.find((c: any) => c.id === cobro.id).clienteNombre).toBe('Ana Pérez');
  });

  it('(b) mesa sentada desde una reserva, comandas sin nombre: usa el de la reserva', async () => {
    const m = mesas[1];
    const reserva = await http()
      .post('/api/v1/reservaciones')
      .set(auth)
      .send({
        salonId,
        mesaId: m,
        clienteNombre: '  Familia Rojas ',
        personas: 2,
        iniciaEn: '2027-03-01T20:00:00.000Z',
        duracionMin: 90,
      })
      .expect(201);
    await http().post(`/api/v1/reservaciones/${reserva.body.id}/sentar`).set(auth).send({}).expect(201);

    // Sin comandas todavía ya se sugiere.
    const { body: vacia } = await http().get(`/api/v1/mesas/${m}/cuenta`).set(auth).expect(200);
    expect(vacia.clienteNombreSugerido).toBe('Familia Rojas');

    const c = await crearComanda(m).expect(201);
    await despachar(c.body.id).expect(201);
    const { body: cobro } = await cobrar(m).expect(201);
    expect(cobro.clienteNombre).toBe('Familia Rojas');
  });

  it('(c) el cajero manda "" o null: NULL aunque haya nombre; manda texto: gana con trim', async () => {
    for (const [i, envio] of [
      [2, { clienteNombre: '' }],
      [2, { clienteNombre: null }],
      [3, { clienteNombre: '  Pedro  ' }],
    ] as const) {
      const m = mesas[i];
      const c = await crearComanda(m, { clienteNombre: 'Ana del mesero' }).expect(201);
      await despachar(c.body.id).expect(201);
      const { body: cobro } = await cobrar(m, envio).expect(201);
      expect(cobro.clienteNombre).toBe(envio.clienteNombre ? 'Pedro' : null);
    }
    await cobrar(mesas[0], { clienteNombre: 'x'.repeat(121) }).expect(400);
  });
});
