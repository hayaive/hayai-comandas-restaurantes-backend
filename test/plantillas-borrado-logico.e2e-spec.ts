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
 * Borrado lógico de Plantilla (CONTRACT.md §3.6, §4, §7):
 *   - `DELETE /plantillas/:id` sobre una plantilla con histórico (comandas y
 *     reservaciones) tiene éxito y preserva ese histórico y `plantilla_mesa`.
 *   - `DELETE /plantillas/:id` sobre la plantilla activa del salón es 409.
 *   - `v_mesa_estado` deja de listar mesas de una plantilla borrada.
 */
describe('Plantillas — borrado lógico (e2e)', () => {
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

    const slug = `test-plantilla-borrado-${Date.now()}`;
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
    await prisma.mesa.create({ data: { id: mesaId, restauranteId, salonId, etiqueta: 'B1' } });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ usuario: `admin-${slug}`, clave: 'clave1234' })
      .expect(200);
    token = login.body.token;
    expect(token).toBeDefined();
  }, 30_000);

  afterAll(async () => {
    await prisma.restaurante.delete({ where: { id: restauranteId } }).catch(() => undefined);
    await app.close();
  });

  it('eliminar una plantilla con comandas y reservaciones asociadas tiene éxito y preserva el histórico', async () => {
    const auth = { Authorization: `Bearer ${token}` };

    // 1. Crea y activa la primera distribución, con la mesa dibujada en ella.
    const plantilla1 = await request(app.getHttpServer())
      .post(`/api/v1/salones/${salonId}/plantillas`)
      .set(auth)
      .send({ nombre: 'Distribución histórica' })
      .expect(201);
    const plantilla1Id: string = plantilla1.body.id;

    await request(app.getHttpServer())
      .put(`/api/v1/plantillas/${plantilla1Id}/mesas`)
      .set(auth)
      .send({ mesas: [{ mesaId, posX: 0, posY: 0, forma: 'cuadrada', capacidad: 4 }] })
      .expect(200);

    await request(app.getHttpServer()).post(`/api/v1/plantillas/${plantilla1Id}/activar`).set(auth).expect(201);

    // 2. Con plantilla1 activa, genera histórico que apunta a ella.
    const comanda = await request(app.getHttpServer())
      .post('/api/v1/comandas')
      .set(auth)
      .send({ tipo: 'mesa', mesaId, comensales: 2 })
      .expect(201);
    expect(comanda.body.plantillaId).toBe(plantilla1Id);
    // Cierra la comanda para no interferir con el resto del test (la
    // plantilla_id ya quedó grabada; no se toca al cerrar).
    await prisma.comanda.update({ where: { id: comanda.body.id }, data: { estado: 'anulada', cerradaEn: new Date() } });

    const reservacion = await request(app.getHttpServer())
      .post('/api/v1/reservaciones')
      .set(auth)
      .send({
        salonId,
        mesaId,
        clienteNombre: 'Cliente histórico',
        personas: 2,
        iniciaEn: '2027-02-01T20:00:00.000Z',
        duracionMin: 60,
      })
      .expect(201);
    expect(reservacion.body.plantillaId).toBe(plantilla1Id);

    // 3. Activa una segunda distribución: plantilla1 deja de ser la activa.
    const plantilla2 = await request(app.getHttpServer())
      .post(`/api/v1/salones/${salonId}/plantillas`)
      .set(auth)
      .send({ nombre: 'Distribución nueva' })
      .expect(201);
    const plantilla2Id: string = plantilla2.body.id;
    await request(app.getHttpServer()).post(`/api/v1/plantillas/${plantilla2Id}/activar`).set(auth).expect(201);

    // 4. Borrar la plantilla1 (ya no activa, con histórico) tiene éxito.
    await request(app.getHttpServer()).delete(`/api/v1/plantillas/${plantilla1Id}`).set(auth).expect(204);

    const plantilla1Db = await prisma.plantilla.findUniqueOrThrow({ where: { id: plantilla1Id } });
    expect(plantilla1Db.eliminadaEn).not.toBeNull();
    expect(plantilla1Db.activa).toBe(false);

    // El histórico conserva su plantillaId intacto.
    const comandaDb = await prisma.comanda.findUniqueOrThrow({ where: { id: comanda.body.id } });
    expect(comandaDb.plantillaId).toBe(plantilla1Id);
    const reservacionDb = await prisma.reservacion.findUniqueOrThrow({ where: { id: reservacion.body.id } });
    expect(reservacionDb.plantillaId).toBe(plantilla1Id);

    // plantilla_mesa de la plantilla borrada sigue existiendo.
    const mesasEnPlantilla1 = await prisma.plantillaMesa.findMany({ where: { restauranteId, plantillaId: plantilla1Id } });
    expect(mesasEnPlantilla1.length).toBe(1);

    // La plantilla borrada ya no aparece en /plantillas ni en GET /plantillas/:id.
    const listado = await request(app.getHttpServer())
      .get(`/api/v1/salones/${salonId}/plantillas`)
      .set(auth)
      .expect(200);
    expect(listado.body.some((p: any) => p.id === plantilla1Id)).toBe(false);
    await request(app.getHttpServer()).get(`/api/v1/plantillas/${plantilla1Id}`).set(auth).expect(404);

    // v_mesa_estado ya no devuelve filas de la plantilla borrada.
    const plano = await request(app.getHttpServer())
      .get(`/api/v1/plano?plantillaId=${plantilla1Id}`)
      .set(auth)
      .expect(200);
    expect(plano.body).toHaveLength(0);
  });

  it('no se puede eliminar la distribución activa del salón (409)', async () => {
    const auth = { Authorization: `Bearer ${token}` };

    const activa = await prisma.plantilla.findFirstOrThrow({ where: { restauranteId, salonId, activa: true } });

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/plantillas/${activa.id}`)
      .set(auth)
      .expect(409);
    expect(res.body.message).toMatch(/distribución activa/i);
  });
});
