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
 * Invariantes críticos del modelo de comandas múltiples + cobro consolidado,
 * garantizados por Postgres (prisma/sql/01_constraints_y_triggers.sql).
 *
 * Es la traducción a e2e de la batería con la que J.O.R.B.I verificó la
 * migración `20260915183000_comandas_multiples_y_cobro`: allí se probaron
 * contra SQL crudo, aquí contra la API real, que es donde tienen que seguir
 * cumpliéndose.
 *
 *   B · una mesa acepta VARIAS comandas vivas (antes: 23505)
 *   C · la cola de despacho es FIFO GLOBAL, con las líneas embebidas
 *   D · despachar saca de la cola, no borra
 *   E · los ítems sólo se tocan mientras la comanda esté pendiente
 *   G · el cobro consolida la mesa y deja lo pendiente en cocina
 *   H · ⭐ dos cajeros cobrando la misma mesa: uno gana, el otro 409
 *
 * Más el EXCLUDE de reservaciones, que el rediseño no tocó.
 *
 * Cada corrida crea su propio restaurante (slug único) para no interferir con
 * otras corridas ni con el seed de desarrollo.
 */
describe('Invariantes críticos (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let restauranteId: string;
  let salonId: string;
  let mesaId: string;
  let mesaDosId: string;
  let mesaTresId: string;
  let productoId: string;
  let token: string;
  let auth: { Authorization: string };

  /** Crea una comanda ya en la cola, con una línea del producto de prueba. */
  const crearComanda = (mesa: string, cantidad = 1) =>
    request(app.getHttpServer())
      .post('/api/v1/comandas')
      .set(auth)
      .send({ tipo: 'mesa', mesaId: mesa, comensales: 2, items: [{ productoId, cantidad }] });

  const despachar = (comandaId: string) =>
    request(app.getHttpServer()).post(`/api/v1/comandas/${comandaId}/despachar`).set(auth);

  /** Saca una comanda de la cuenta viva de la mesa sin pasar por la API. */
  const anularEnBase = (id: string) =>
    prisma.comanda.update({ where: { id }, data: { anuladaEn: new Date() } });

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
    mesaDosId = nuevoId();
    await prisma.mesa.create({ data: { id: mesaDosId, restauranteId, salonId, etiqueta: 'T2' } });
    mesaTresId = nuevoId();
    await prisma.mesa.create({ data: { id: mesaTresId, restauranteId, salonId, etiqueta: 'T3' } });

    const plantillaId = nuevoId();
    await prisma.plantilla.create({
      data: { id: plantillaId, restauranteId, salonId, nombre: 'Distribución de prueba', activa: true },
    });
    for (const m of [mesaId, mesaDosId, mesaTresId]) {
      await prisma.plantillaMesa.create({
        data: { restauranteId, plantillaId, mesaId: m, posX: 0, posY: 0, forma: 'cuadrada', capacidad: 4 },
      });
    }

    const categoriaId = nuevoId();
    await prisma.categoria.create({ data: { id: categoriaId, restauranteId, nombre: 'Cocina' } });
    productoId = nuevoId();
    await prisma.producto.create({
      data: { id: productoId, restauranteId, categoriaId, nombre: 'Pabellón', precio: 10 },
    });

    // Sin tasa del dólar no se puede emitir ninguna factura: `cobro.tasa_id` es
    // NOT NULL y el trigger `cobro_tasa_base` sólo admite USD.
    await prisma.tasaCambio.create({
      data: { id: nuevoId(), restauranteId, fecha: new Date(), divisa: 'USD', valor: 900 },
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ usuario: `admin-${slug}`, clave: 'clave1234' })
      .expect(200);
    token = login.body.token;
    auth = { Authorization: `Bearer ${token}` };
    expect(token).toBeDefined();
  }, 30_000);

  afterAll(async () => {
    // El restaurante en cascada se lleva usuario/salon/mesa/plantilla/etc., pero
    // `cobro` apunta a mesa y tasa con RESTRICT: hay que vaciarlo antes.
    await prisma.$executeRaw`DELETE FROM "comanda" WHERE "restaurante_id" = ${restauranteId}::uuid`;
    await prisma.$executeRaw`DELETE FROM "cobro"   WHERE "restaurante_id" = ${restauranteId}::uuid`;
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

  it('una comanda nace ya en la cola de despacho, con sus líneas y su total', async () => {
    const { body } = await crearComanda(mesaId, 2).expect(201);

    expect(body.estado).toBe('pendiente');
    expect(body.despachadaEn).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(Number(body.total)).toBe(20);

    // Sin líneas no hay comanda: sería un ticket en blanco en la pantalla de cocina.
    await request(app.getHttpServer())
      .post('/api/v1/comandas')
      .set(auth)
      .send({ tipo: 'mesa', mesaId, comensales: 2, items: [] })
      .expect(400);

    await anularEnBase(body.id);
  });

  it('B · una mesa acepta VARIAS comandas vivas a la vez (murió comanda_mesa_activa_unica)', async () => {
    const a = await crearComanda(mesaId).expect(201);
    const b = await crearComanda(mesaId).expect(201);

    expect(a.body.id).not.toBe(b.body.id);

    const { body: cuenta } = await request(app.getHttpServer())
      .get(`/api/v1/mesas/${mesaId}/cuenta`)
      .set(auth)
      .expect(200);
    expect(cuenta.cuenta.comandas).toBe(2);
    expect(cuenta.cuenta.comandas_en_cocina).toBe(2);
    expect(Number(cuenta.cuenta.cuenta_total)).toBe(20);

    // La mesa con comandas vivas se pinta ocupada en el plano.
    const { body: plano } = await request(app.getHttpServer()).get('/api/v1/plano').set(auth).expect(200);
    const fila = plano.find((m: any) => m.mesa_id === mesaId);
    expect(fila.estado).toBe('ocupada');
    expect(fila.comandas).toBe(2);

    await anularEnBase(a.body.id);
    await anularEnBase(b.body.id);
  });

  it('C/D · la cola es FIFO global entre mesas, y despachar saca de la cola sin borrar', async () => {
    const primera = await crearComanda(mesaId).expect(201);
    const segunda = await crearComanda(mesaDosId).expect(201);
    const tercera = await crearComanda(mesaId).expect(201);

    const { body: cola } = await request(app.getHttpServer())
      .get('/api/v1/despacho/cola')
      .set(auth)
      .expect(200);

    // Orden de llegada, sin agrupar por mesa: mesa1 → mesa2 → mesa1.
    expect(cola.map((c: any) => c.comanda_id)).toEqual([primera.body.id, segunda.body.id, tercera.body.id]);
    // Las líneas viajan embebidas: el KDS no hace un N+1.
    expect(cola[0].items).toHaveLength(1);
    expect(cola[0].items[0].nombre).toBe('Pabellón');

    await despachar(primera.body.id).expect(201);

    const { body: colaDespues } = await request(app.getHttpServer())
      .get('/api/v1/despacho/cola')
      .set(auth)
      .expect(200);
    expect(colaDespues.map((c: any) => c.comanda_id)).not.toContain(primera.body.id);

    // Sale de la cola, NO de la base.
    const enBase = await prisma.comanda.findUniqueOrThrow({ where: { id: primera.body.id } });
    expect(enBase.estado).toBe('despachada');
    expect(enBase.despachadaEn).not.toBeNull();

    // Despacharla otra vez (dos pantallas de cocina) no repisa la fecha.
    await despachar(primera.body.id).expect(409);

    for (const id of [primera.body.id, segunda.body.id, tercera.body.id]) {
      await anularEnBase(id);
    }
  });

  it('E · los ítems sólo se tocan mientras la comanda esté pendiente', async () => {
    const comanda = await crearComanda(mesaId, 3).expect(201);
    const itemId = comanda.body.items[0].id;

    // Pendiente: se puede anular la línea, y el total se recalcula.
    await request(app.getHttpServer())
      .delete(`/api/v1/comandas/${comanda.body.id}/items/${itemId}`)
      .set(auth)
      .send({ motivo: 'se arrepintió' })
      .expect(204);

    const trasAnular = await prisma.comanda.findUniqueOrThrow({ where: { id: comanda.body.id } });
    expect(Number(trasAnular.total)).toBe(0);
    const item = await prisma.comandaItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.canceladoEn).not.toBeNull();
    expect(item.motivoCancelacion).toBe('se arrepintió');

    // Despachada: ya no se le agregan líneas ni se le anulan. Protege el FIFO
    // (entró a la cola con un contenido y saldría con otro) y el monto.
    const otra = await crearComanda(mesaId).expect(201);
    await despachar(otra.body.id).expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/comandas/${otra.body.id}/items`)
      .set(auth)
      .send({ items: [{ productoId, cantidad: 1 }] })
      .expect(409);

    await request(app.getHttpServer())
      .delete(`/api/v1/comandas/${otra.body.id}/items/${otra.body.items[0].id}`)
      .set(auth)
      .send({ motivo: 'tarde' })
      .expect(409);

    await anularEnBase(comanda.body.id);
    await anularEnBase(otra.body.id);
  });

  it('G · el cobro consolida lo despachado y deja lo pendiente en cocina', async () => {
    const despachada = await crearComanda(mesaId).expect(201);
    await despachar(despachada.body.id).expect(201);
    const enCocina = await crearComanda(mesaId).expect(201);

    const { body: antes } = await request(app.getHttpServer())
      .get(`/api/v1/mesas/${mesaId}/cuenta`)
      .set(auth)
      .expect(200);
    expect(antes.cuenta.comandas_por_cobrar).toBe(1);
    expect(antes.cuenta.comandas_en_cocina).toBe(1);

    const { body: cobro } = await request(app.getHttpServer())
      .post(`/api/v1/mesas/${mesaId}/cobrar`)
      .set(auth)
      .send({ propina: 2, pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: 12 }] })
      .expect(201);

    expect(Number(cobro.subtotal)).toBe(10);
    expect(Number(cobro.propina)).toBe(2);
    expect(Number(cobro.total)).toBe(12);
    // La factura sabe exactamente qué comandas cubrió: lo pendiente no entró.
    expect(cobro.comandas.map((c: any) => c.id)).toEqual([despachada.body.id]);

    // La comanda que sigue en cocina arranca la cuenta nueva de la mesa.
    const { body: despues } = await request(app.getHttpServer())
      .get(`/api/v1/mesas/${mesaId}/cuenta`)
      .set(auth)
      .expect(200);
    expect(despues.cuenta.comandas_por_cobrar).toBe(0);
    expect(despues.cuenta.comandas_en_cocina).toBe(1);

    // Los pagos cuadran: v_cobro_descuadre tiene que seguir vacía.
    const descuadres = await prisma.$queryRaw<any[]>`
      SELECT * FROM v_cobro_descuadre WHERE restaurante_id = ${restauranteId}::uuid
    `;
    expect(descuadres).toHaveLength(0);

    // Reimprimir la factura.
    const { body: reimpresa } = await request(app.getHttpServer())
      .get(`/api/v1/cobros/${cobro.id}`)
      .set(auth)
      .expect(200);
    expect(reimpresa.pagos).toHaveLength(1);
    expect(reimpresa.comandas[0].items).toHaveLength(1);

    await anularEnBase(enCocina.body.id);
  });

  it('no se puede cobrar una mesa que no tiene nada despachado (409)', async () => {
    const enCocina = await crearComanda(mesaDosId).expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/mesas/${mesaDosId}/cobrar`)
      .set(auth)
      .send({ pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: 10 }] })
      .expect(409);

    await anularEnBase(enCocina.body.id);
  });

  it('los pagos tienen que cuadrar con el total de la cuenta', async () => {
    const comanda = await crearComanda(mesaDosId).expect(201);
    await despachar(comanda.body.id).expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/mesas/${mesaDosId}/cobrar`)
      .set(auth)
      .send({ pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: 3 }] })
      .expect(400);

    // Pago móvil sin referencia: no se puede conciliar con el banco.
    await request(app.getHttpServer())
      .post(`/api/v1/mesas/${mesaDosId}/cobrar`)
      .set(auth)
      .send({ pagos: [{ metodo: 'pago_movil', moneda: 'USD', monto: 10 }] })
      .expect(400);

    // Y tras los dos rechazos la cuenta sigue viva, sin factura a medias.
    const cobros = await prisma.cobro.findMany({ where: { restauranteId, mesaId: mesaDosId } });
    expect(cobros).toHaveLength(0);

    await anularEnBase(comanda.body.id);
  });

  it('H · ⭐ dos cajeros cobrando la misma mesa a la vez: uno cobra, el otro recibe 409', async () => {
    const a = await crearComanda(mesaDosId).expect(201);
    const b = await crearComanda(mesaDosId).expect(201);
    await despachar(a.body.id).expect(201);
    await despachar(b.body.id).expect(201);

    const cobrar = () =>
      request(app.getHttpServer())
        .post(`/api/v1/mesas/${mesaDosId}/cobrar`)
        .set(auth)
        .send({ pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: 20 }] });

    // Las dos peticiones salen a la vez. El `SELECT ... FOR UPDATE` del
    // servicio serializa: la segunda espera el lock y, al reevaluar el
    // predicado tras el COMMIT de la primera, encuentra 0 comandas cobrables.
    const [uno, dos] = await Promise.all([cobrar(), cobrar()]);

    expect([uno.status, dos.status].sort()).toEqual([201, 409]);

    // Lo que de verdad importa: UNA sola factura, y cubre las DOS comandas. Sin
    // el FOR UPDATE saldrían dos facturas parciales y la caja no cuadraría.
    const cobros = await prisma.cobro.findMany({ where: { restauranteId, mesaId: mesaDosId } });
    expect(cobros).toHaveLength(1);
    expect(Number(cobros[0].total)).toBe(20);

    const cubiertas = await prisma.comanda.findMany({ where: { restauranteId, cobroId: cobros[0].id } });
    expect(cubiertas.map((c) => c.id).sort()).toEqual([a.body.id, b.body.id].sort());

    // Y ninguna factura fantasma: el cobro perdedor no dejó rastro.
    const descuadres = await prisma.$queryRaw<any[]>`
      SELECT * FROM v_cobro_descuadre WHERE restaurante_id = ${restauranteId}::uuid
    `;
    expect(descuadres).toHaveLength(0);
  });

  it('⭐ sentar una reservación ocupa la mesa YA, sin ningún pedido, y la libera el cobro', async () => {
    // El dueño lo pidió explícitamente: al escanear el QR la mesa pasa a
    // ocupada en el acto, no cuando el mesero toma la nota. Desde que `sentar`
    // dejó de abrir comanda, quien sostiene eso es `v_mesa_estado`: una reserva
    // en estado 'sentada' ocupa la mesa por sí sola. Sin esa rama el plano
    // devolvería 'libre' y pisaría el estado optimista del frontend.
    const reserva = await request(app.getHttpServer())
      .post('/api/v1/reservaciones')
      .set(auth)
      .send({
        salonId,
        mesaId: mesaTresId,
        clienteNombre: 'Cliente que llega',
        personas: 2,
        iniciaEn: '2027-03-01T20:00:00.000Z',
        duracionMin: 90,
      })
      .expect(201);

    const filaDeMesaTres = async () => {
      const { body } = await request(app.getHttpServer()).get('/api/v1/plano').set(auth).expect(200);
      return body.find((m: any) => m.mesa_id === mesaTresId);
    };

    // Antes de sentar: libre. La reserva es de 2027, fuera de la ventana de
    // 'reservada', así que no hay nada más que pueda pintarla.
    expect((await filaDeMesaTres()).estado).toBe('libre');

    await request(app.getHttpServer())
      .post(`/api/v1/reservaciones/${reserva.body.id}/sentar`)
      .set(auth)
      .send({})
      .expect(201);

    // Ocupada YA, con cero comandas.
    const sentada = await filaDeMesaTres();
    expect(sentada.estado).toBe('ocupada');
    expect(sentada.comandas).toBe(0);
    expect(sentada.sentada_reservacion_id).toBe(reserva.body.id);
    expect(sentada.sentada_cliente).toBe('Cliente que llega');
    // "Ocupada desde" sale del momento en que se sentó, no del primer pedido.
    expect(sentada.ocupada_desde).not.toBeNull();

    // Sigue ocupada mientras come. La comanda va SIN `reservacionId`: es el caso
    // que dejaría la mesa colgada si el cobro sólo mirara las reservas atadas a
    // la comanda.
    const comanda = await crearComanda(mesaTresId).expect(201);
    expect((await filaDeMesaTres()).estado).toBe('ocupada');
    await despachar(comanda.body.id).expect(201);
    expect((await filaDeMesaTres()).estado).toBe('ocupada');

    // Al cobrar se libera: la reserva pasa a 'completada' y la mesa a 'libre'.
    await request(app.getHttpServer())
      .post(`/api/v1/mesas/${mesaTresId}/cobrar`)
      .set(auth)
      .send({ pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: 10 }] })
      .expect(201);

    const reservaDb = await prisma.reservacion.findUniqueOrThrow({ where: { id: reserva.body.id } });
    expect(reservaDb.estado).toBe('completada');
    expect((await filaDeMesaTres()).estado).toBe('libre');
  });

  it('una reserva sentada que nunca pidió nada se libera cancelándola', async () => {
    const reserva = await request(app.getHttpServer())
      .post('/api/v1/reservaciones')
      .set(auth)
      .send({
        salonId,
        mesaId: mesaTresId,
        clienteNombre: 'Se fue sin pedir',
        personas: 2,
        iniciaEn: '2027-04-01T20:00:00.000Z',
        duracionMin: 90,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/reservaciones/${reserva.body.id}/sentar`)
      .set(auth)
      .send({})
      .expect(201);

    const estadoDeMesaTres = async () => {
      const { body } = await request(app.getHttpServer()).get('/api/v1/plano').set(auth).expect(200);
      return body.find((m: any) => m.mesa_id === mesaTresId).estado;
    };
    expect(await estadoDeMesaTres()).toBe('ocupada');

    await request(app.getHttpServer())
      .post(`/api/v1/reservaciones/${reserva.body.id}/cancelar`)
      .set(auth)
      .send({ motivo: 'se fue' })
      .expect(201);

    expect(await estadoDeMesaTres()).toBe('libre');
  });

  it('no se puede reservar dos veces la misma mesa en horarios que se solapan (reservacion_sin_solape → 409)', async () => {
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
