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
 * Smoke tests de los invariantes críticos garantizados por Postgres
 * (CONTRACT.md §2.8, §4; docs/DECISIONES-DATOS.md §3-4):
 *   - una comanda viva por mesa (índice único parcial `comanda_mesa_activa_unica`)
 *   - ninguna doble reserva de la misma mesa (EXCLUDE `reservacion_sin_solape`)
 * más un smoke test de autenticación y de un endpoint principal por dominio.
 *
 * Cada corrida crea su propio restaurante (slug único) para no interferir
 * con datos de otras corridas ni con el seed de desarrollo.
 */
describe('Invariantes críticos (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let restauranteId: string;
  let salonId: string;
  let mesaId: string;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configurarApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    const slug = `test-${Date.now()}`;
    restauranteId = nuevoId();
    await prisma.restaurante.create({
      data: { id: restauranteId, slug, nombre: 'Restaurante de prueba' },
    });

    const claveHash = await argon2.hash('clave1234');
    await prisma.usuario.create({
      data: {
        id: nuevoId(),
        restauranteId,
        nombre: 'Admin de prueba',
        usuario: `admin-${slug}`,
        claveHash,
        rol: 'administrador',
      },
    });

    salonId = nuevoId();
    await prisma.salon.create({ data: { id: salonId, restauranteId, nombre: 'Salón de prueba' } });

    mesaId = nuevoId();
    await prisma.mesa.create({ data: { id: mesaId, restauranteId, salonId, etiqueta: 'T1' } });

    const plantillaId = nuevoId();
    await prisma.plantilla.create({
      data: { id: plantillaId, restauranteId, salonId, nombre: 'Distribución de prueba', activa: true },
    });
    await prisma.plantillaMesa.create({
      data: { restauranteId, plantillaId, mesaId, posX: 0, posY: 0, forma: 'cuadrada', capacidad: 4 },
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ usuario: `admin-${slug}`, clave: 'clave1234' })
      .expect(200);
    token = login.body.token;
    expect(token).toBeDefined();
  }, 30_000);

  afterAll(async () => {
    // El restaurante en cascada se lleva usuario/salon/mesa/plantilla/etc.
    await prisma.restaurante.delete({ where: { id: restauranteId } }).catch(() => undefined);
    await app.close();
  });

  it('GET /auth/yo devuelve el usuario autenticado', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/yo')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.restauranteId).toBe(restauranteId);
  });

  it('GET /salones devuelve el salón recién creado', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/salones')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.some((s: any) => s.id === salonId)).toBe(true);
  });

  it('una mesa no puede tener dos comandas vivas a la vez (comanda_mesa_activa_unica → 409)', async () => {
    const auth = { Authorization: `Bearer ${token}` };

    const primera = await request(app.getHttpServer())
      .post('/api/v1/comandas')
      .set(auth)
      .send({ tipo: 'mesa', mesaId, comensales: 2 })
      .expect(201);
    expect(primera.body.estado).toBe('abierta');

    const segunda = await request(app.getHttpServer())
      .post('/api/v1/comandas')
      .set(auth)
      .send({ tipo: 'mesa', mesaId, comensales: 2 })
      .expect(409);
    expect(segunda.body.message).toMatch(/ya tiene una comanda abierta/i);

    // Libera la mesa (anulando la comanda directamente) para no interferir
    // con el resto de los tests de este archivo.
    await prisma.comanda.update({
      where: { id: primera.body.id },
      data: { estado: 'anulada', cerradaEn: new Date() },
    });
  });

  it('no se puede reservar dos veces la misma mesa en horarios que se solapan (reservacion_sin_solape → 409)', async () => {
    const auth = { Authorization: `Bearer ${token}` };

    const base = await request(app.getHttpServer())
      .post('/api/v1/reservaciones')
      .set(auth)
      .send({
        salonId,
        mesaId,
        clienteNombre: 'Cliente A',
        personas: 2,
        iniciaEn: '2027-01-10T20:00:00.000Z',
        duracionMin: 90,
      })
      .expect(201);
    expect(base.body.estado).toBe('pendiente');

    const solapada = await request(app.getHttpServer())
      .post('/api/v1/reservaciones')
      .set(auth)
      .send({
        salonId,
        mesaId,
        clienteNombre: 'Cliente B',
        personas: 2,
        iniciaEn: '2027-01-10T20:30:00.000Z',
        duracionMin: 90,
      })
      .expect(409);
    expect(solapada.body.message).toMatch(/ya está reservada/i);

    const adyacente = await request(app.getHttpServer())
      .post('/api/v1/reservaciones')
      .set(auth)
      .send({
        salonId,
        mesaId,
        clienteNombre: 'Cliente C',
        personas: 2,
        iniciaEn: '2027-01-10T21:30:00.000Z',
        duracionMin: 60,
      })
      .expect(201);
    expect(adyacente.body.estado).toBe('pendiente');
  });
});
