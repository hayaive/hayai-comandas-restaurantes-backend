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
 * `GET /reportes/ventas` — el apartado de ventas con filtro día / mes / año
 * (CONTRACT.md §5 · Reportes).
 *
 * Lo que estos tests protegen, en una línea: **que el mes y el año se agreguen
 * por día OPERATIVO y no por fecha de calendario**. Es un error que no rompe
 * nada visible — los números salen, sólo que mal — y que sólo se nota cuando
 * el cierre de un mes no cuadra con la suma de sus días.
 *
 * Por eso el seed usa fechas fijas de 2025 (no relativas a "hoy"): el
 * resultado esperado es el mismo hoy y dentro de dos años. Los tres momentos
 * que importan están construidos a mano:
 *   · 2025-05-11 02:00 Caracas → día operativo 2025-05-10 (madrugada)
 *   · 2025-06-01 03:00 Caracas → día operativo 2025-05-31, o sea MAYO
 *   · un cobro anulado y una comanda sin cobrar, que no entran en ningún total
 *
 * La fecha y el turno NO se escriben a mano: se calculan con
 * `hayai_fecha_operativa` / `hayai_turno`, las mismas funciones que usa el
 * cobro. Si el test las replicara en TypeScript, verificaría su propia copia de
 * la regla en vez de la del sistema.
 *
 * ⚠️ Desde el rediseño de comandas múltiples la unidad de venta es el COBRO, y
 * el día operativo que cuenta es el del cobro, no el del pedido. Por eso el
 * seed siembra facturas (cada una con su comanda detrás) en vez de comandas
 * cobradas, y el resumen devuelve `cobros` donde antes decía `comandas`.
 */
describe('Reportes de ventas por período (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let restauranteId: string;
  let token: string;
  let auth: { Authorization: string };
  let productoEmpanadaId: string;
  let productoPabellonId: string;
  let tasaId: string;

  const ZONA = 'America/Caracas';
  const CORTE = '05:00';

  /**
   * Una venta completa: la comanda despachada y la factura que la cubre, con el
   * día operativo y el turno resueltos por la base.
   *
   * Va todo en UNA transacción por obligación del esquema: `cobro_no_vacio` es
   * un constraint trigger diferido que se evalúa en el COMMIT, así que un cobro
   * insertado suelto —sin la comanda apuntándolo— revienta. Es el mismo
   * invariante que protege de la factura fantasma en producción.
   *
   * El orden dentro de la transacción tampoco es libre:
   *   1. comanda (nace `pendiente`)
   *   2. sus líneas — `comanda_item_solo_pendiente` las rechaza si la comanda
   *      ya está despachada
   *   3. `despachada_en` — `comanda_cobro_tras_despacho` exige que lo esté
   *      antes de cobrarla
   *   4. el cobro, y las comandas apuntándolo
   */
  async function sembrarVenta(opciones: {
    momento: string;
    total: number;
    propina?: number;
    anulado?: boolean;
    /** Sin cobrar: la comanda se queda viva y no puede entrar en ningún total. */
    sinCobrar?: boolean;
    numero: number;
    items?: { productoId: string; nombre: string; cantidad: number; total: number }[];
  }): Promise<void> {
    const { momento, total, propina = 0, anulado = false, sinCobrar = false, numero, items = [] } = opciones;
    const comandaId = nuevoId();
    const cobroId = nuevoId();
    const subtotal = total - propina;
    // `comanda.total` es sólo la suma de sus líneas: sin propina ni descuento.
    const totalLineas = subtotal;

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "comanda" (
          "id", "restaurante_id", "tipo", "numero_dia", "fecha_operativa", "turno",
          "comensales", "total", "creada_en", "actualizada_en"
        ) VALUES (
          ${comandaId}::uuid, ${restauranteId}::uuid, 'para_llevar', ${numero},
          hayai_fecha_operativa(${momento}::timestamptz, ${ZONA}, ${CORTE}::time),
          hayai_turno(${momento}::timestamptz, ${ZONA}),
          2, ${totalLineas}, ${momento}::timestamptz, now()
        )
      `;

      for (const [i, it] of items.entries()) {
        await tx.comandaItem.create({
          data: {
            id: nuevoId(),
            restauranteId,
            comandaId,
            productoId: it.productoId,
            orden: i,
            nombreSnap: it.nombre,
            precioUnitarioSnap: it.total / it.cantidad,
            destinoSnap: 'cocina',
            cantidad: it.cantidad,
            totalLinea: it.total,
          },
        });
      }

      if (sinCobrar) return;

      await tx.comanda.update({
        where: { id: comandaId },
        data: { despachadaEn: new Date(momento) },
      });

      await tx.$executeRaw`
        INSERT INTO "cobro" (
          "id", "restaurante_id", "numero_dia", "fecha_operativa", "turno",
          "comensales", "subtotal", "propina", "total",
          "tasa_id", "tasa_valor", "total_bs", "cobrado_en", "anulado_en",
          "motivo_anulacion", "actualizado_en"
        ) VALUES (
          ${cobroId}::uuid, ${restauranteId}::uuid, ${numero},
          hayai_fecha_operativa(${momento}::timestamptz, ${ZONA}, ${CORTE}::time),
          hayai_turno(${momento}::timestamptz, ${ZONA}),
          2, ${subtotal}, ${propina}, ${total},
          ${tasaId}::uuid, 900, ${total * 900}, ${momento}::timestamptz,
          ${anulado ? momento : null}::timestamptz,
          ${anulado ? 'prueba' : null}, now()
        )
      `;

      await tx.comanda.update({ where: { id: comandaId }, data: { cobroId } });
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configurarApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    const slug = `test-reportes-${Date.now()}`;
    restauranteId = nuevoId();
    await prisma.restaurante.create({
      data: { id: restauranteId, slug, nombre: 'Restaurante de reportes', zonaHoraria: ZONA },
    });

    const claveHash = await argon2.hash('clave1234');
    await prisma.usuario.create({
      data: {
        id: nuevoId(),
        restauranteId,
        nombre: 'Admin de reportes',
        usuario: `admin-${slug}`,
        claveHash,
        rol: 'administrador',
      },
    });

    const categoriaId = nuevoId();
    await prisma.categoria.create({ data: { id: categoriaId, restauranteId, nombre: 'Cocina' } });
    productoEmpanadaId = nuevoId();
    productoPabellonId = nuevoId();
    await prisma.producto.create({
      data: { id: productoEmpanadaId, restauranteId, categoriaId, nombre: 'Empanada', precio: 1.5 },
    });
    await prisma.producto.create({
      data: { id: productoPabellonId, restauranteId, categoriaId, nombre: 'Pabellón', precio: 12.5 },
    });

    // `cobro.tasa_id` es NOT NULL y el trigger `cobro_tasa_base` sólo admite
    // USD: sin esta fila no se puede emitir ninguna factura.
    tasaId = nuevoId();
    await prisma.tasaCambio.create({
      data: { id: tasaId, restauranteId, fecha: new Date('2025-05-01'), divisa: 'USD', valor: 900 },
    });

    // ── Mayo 2025 ────────────────────────────────────────────────────────────
    // Día operativo 2025-05-10: almuerzo 100 (+10 de propina), cena 200 y una
    // madrugada de 50 que el calendario fecharía el 11.
    // La empanada sólo se vendió en mayo, el pabellón sólo en junio.
    await sembrarVenta({
      momento: '2025-05-10T13:00:00-04:00',
      total: 100,
      propina: 10,
      numero: 1,
      items: [{ productoId: productoEmpanadaId, nombre: 'Empanada', cantidad: 6, total: 9 }],
    });
    await sembrarVenta({ momento: '2025-05-10T20:00:00-04:00', total: 200, numero: 2 });
    await sembrarVenta({ momento: '2025-05-11T02:00:00-04:00', total: 50, propina: 5, numero: 3 });

    // Día operativo 2025-05-31: una cena del 31 y una madrugada que el
    // calendario fecharía en JUNIO. Las dos tienen que sumar en mayo.
    await sembrarVenta({ momento: '2025-05-31T22:00:00-04:00', total: 40, numero: 4 });
    await sembrarVenta({ momento: '2025-06-01T03:00:00-04:00', total: 60, numero: 5 });

    // Ruido que no puede contar en ningún total: una factura anulada y una
    // comanda que nunca se cobró.
    await sembrarVenta({ momento: '2025-05-12T13:00:00-04:00', total: 999, anulado: true, numero: 6 });
    await sembrarVenta({ momento: '2025-05-13T13:00:00-04:00', total: 888, sinCobrar: true, numero: 7 });

    // ── Junio 2025 ───────────────────────────────────────────────────────────
    await sembrarVenta({
      momento: '2025-06-05T13:00:00-04:00',
      total: 500,
      numero: 8,
      items: [{ productoId: productoPabellonId, nombre: 'Pabellón', cantidad: 2, total: 25 }],
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ usuario: `admin-${slug}`, clave: 'clave1234' })
      .expect(200);
    token = login.body.token;
    auth = { Authorization: `Bearer ${token}` };
  }, 60_000);

  afterAll(async () => {
    await prisma.restaurante.delete({ where: { id: restauranteId } }).catch(() => undefined);
    await app.close();
  });

  const ventas = (query: string) =>
    request(app.getHttpServer()).get(`/api/v1/reportes/ventas${query}`).set(auth).expect(200);

  it('periodo=dia agrupa por día operativo: la madrugada del 11 factura el 10', async () => {
    const { body } = await ventas('?periodo=dia&fecha=2025-05-10');

    expect(body.desde).toBe('2025-05-10');
    expect(body.hasta).toBe('2025-05-10');
    expect(body.enCurso).toBe(false);
    expect(body.total.cobros).toBe(3);
    expect(body.total.totalUsd).toBe('350.0000');
    // La propina no es ingreso del restaurante (v_venta_dia, CONTRACT.md §6).
    expect(body.total.propinasUsd).toBe('15.0000');
    expect(body.total.ventasUsd).toBe('335.0000');

    // El desglose del día es por turno, y viene denso: desayuno sin ventas
    // aparece en cero en vez de faltar.
    expect(body.granularidad).toBe('turno');
    expect(body.serie.map((p: any) => p.clave)).toEqual(['desayuno', 'almuerzo', 'cena', 'madrugada']);
    expect(body.serie.map((p: any) => p.totalUsd)).toEqual(['0.0000', '100.0000', '200.0000', '50.0000']);

    // El día siguiente NO hereda la madrugada.
    const { body: dia11 } = await ventas('?periodo=dia&fecha=2025-05-11');
    expect(dia11.total.cobros).toBe(0);
    expect(dia11.total.totalUsd).toBe('0.0000');
  });

  it('periodo=mes suma los días operativos del mes, incluida la madrugada del 1 de junio', async () => {
    const { body } = await ventas('?periodo=mes&fecha=2025-05-20');

    expect(body.desde).toBe('2025-05-01');
    expect(body.hasta).toBe('2025-05-31');
    expect(body.total.cobros).toBe(5);
    // 100 + 200 + 50 + 40 + 60. El cobro anulado y la comanda sin cobrar no entran.
    expect(body.total.totalUsd).toBe('450.0000');
    expect(body.total.propinasUsd).toBe('15.0000');
    // Ticket promedio ponderado (450/5), no el promedio de los promedios
    // diarios (que daría 83,33 y no es el ticket de nadie).
    expect(body.total.ticketPromedioUsd).toBe('90.0000');

    expect(body.granularidad).toBe('dia');
    expect(body.serie).toHaveLength(31);
    const porDia = Object.fromEntries(body.serie.map((p: any) => [p.clave, p.totalUsd]));
    expect(porDia['2025-05-10']).toBe('350.0000');
    expect(porDia['2025-05-11']).toBe('0.0000');
    expect(porDia['2025-05-31']).toBe('100.0000'); // 40 del 31 + 60 de la madrugada del 1-jun
    expect(porDia['2025-05-12']).toBe('0.0000'); // la factura anulada no cuenta

    // Invariante: la serie tiene que sumar exactamente el total del período.
    const sumaSerie = body.serie.reduce((a: number, p: any) => a + Number(p.totalUsd), 0);
    expect(sumaSerie.toFixed(4)).toBe(body.total.totalUsd);
  });

  it('junio no hereda la comanda de su madrugada del día 1', async () => {
    const { body } = await ventas('?periodo=mes&fecha=2025-06-15');
    expect(body.desde).toBe('2025-06-01');
    expect(body.hasta).toBe('2025-06-30');
    expect(body.total.cobros).toBe(1);
    expect(body.total.totalUsd).toBe('500.0000');
  });

  it('periodo=anio acumula el año y lo desglosa por mes', async () => {
    const { body } = await ventas('?periodo=anio&fecha=2025-07-15');

    expect(body.desde).toBe('2025-01-01');
    expect(body.hasta).toBe('2025-12-31');
    expect(body.total.cobros).toBe(6);
    expect(body.total.totalUsd).toBe('950.0000');

    expect(body.granularidad).toBe('mes');
    expect(body.serie).toHaveLength(12);
    const porMes = Object.fromEntries(body.serie.map((p: any) => [p.clave, p.totalUsd]));
    expect(porMes['2025-05']).toBe('450.0000');
    expect(porMes['2025-06']).toBe('500.0000');
    expect(porMes['2025-01']).toBe('0.0000');

    const sumaSerie = body.serie.reduce((a: number, p: any) => a + Number(p.totalUsd), 0);
    expect(sumaSerie.toFixed(4)).toBe(body.total.totalUsd);
  });

  it('un período cerrado se compara contra el período anterior COMPLETO', async () => {
    const dia = await ventas('?periodo=dia&fecha=2025-05-10');
    expect(dia.body.comparacion).toMatchObject({ desde: '2025-05-09', hasta: '2025-05-09' });

    // Junio tiene 30 días y mayo 31: la comparación es mayo entero, no sus
    // primeros 30 días. (Restar un mes a "30 de junio" da el 30 de mayo, y
    // ahí se perdía el día que más factura del mes.)
    const mes = await ventas('?periodo=mes&fecha=2025-06-15');
    expect(mes.body.comparacion).toMatchObject({ desde: '2025-05-01', hasta: '2025-05-31' });
    expect(mes.body.comparacion.total.totalUsd).toBe('450.0000');

    const anio = await ventas('?periodo=anio&fecha=2025-07-15');
    expect(anio.body.comparacion).toMatchObject({ desde: '2024-01-01', hasta: '2024-12-31' });
    expect(anio.body.comparacion.total.cobros).toBe(0);
  });

  it('un período en curso se compara contra el mismo tramo, no contra el mes entero', async () => {
    const dias = (desde: string, hasta: string) =>
      Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);

    for (const periodo of ['dia', 'mes', 'anio']) {
      const { body } = await ventas(`?periodo=${periodo}`);
      expect(body.enCurso).toBe(true);
      // El tramo de comparación termina antes de que empiece el actual...
      expect(body.comparacion.hasta < body.desde).toBe(true);
      // ...y nunca es más largo que lo que va del período en curso.
      expect(dias(body.comparacion.desde, body.comparacion.hasta)).toBeLessThanOrEqual(dias(body.desde, body.hasta));
    }
  });

  it('el mes anterior a un 31 es el último día del mes anterior, no un 31 inexistente', async () => {
    // 2025-03-31 - 1 mes = 2025-02-28. Si el cálculo se hiciera en JavaScript
    // con setMonth(), daría el 3 de marzo.
    const { body } = await ventas('?periodo=mes&fecha=2025-03-31');
    expect(body.hasta).toBe('2025-03-31');
    expect(body.comparacion).toMatchObject({ desde: '2025-02-01', hasta: '2025-02-28' });
  });

  it('sin parámetros responde el día operativo en curso, resuelto por el backend', async () => {
    const [{ hoy }] = await prisma.$queryRaw<{ hoy: string }[]>`
      SELECT to_char(hayai_fecha_operativa(now(), ${ZONA}, ${CORTE}::time), 'YYYY-MM-DD') AS "hoy"
    `;

    const { body } = await ventas('');
    expect(body.periodo).toBe('dia');
    expect(body.fecha).toBe(hoy);
    expect(body.desde).toBe(hoy);
    expect(body.enCurso).toBe(true);
  });

  it('el período en curso se recorta al día de hoy y se marca como parcial', async () => {
    const [{ hoy }] = await prisma.$queryRaw<{ hoy: string }[]>`
      SELECT to_char(hayai_fecha_operativa(now(), ${ZONA}, ${CORTE}::time), 'YYYY-MM-DD') AS "hoy"
    `;

    const { body } = await ventas('?periodo=anio');
    expect(body.desde).toBe(`${hoy.substring(0, 4)}-01-01`);
    expect(body.hasta).toBe(hoy);
    expect(body.enCurso).toBe(true);
    // Un año cerrado no está en curso.
    const { body: cerrado } = await ventas('?periodo=anio&fecha=2025-07-15');
    expect(cerrado.enCurso).toBe(false);
  });

  it('un período desconocido se rechaza en vez de responder el año en silencio', async () => {
    await request(app.getHttpServer()).get('/api/v1/reportes/ventas?periodo=semana').set(auth).expect(400);
    await request(app.getHttpServer()).get('/api/v1/reportes/ventas?fecha=20-05-2025').set(auth).expect(400);
    await request(app.getHttpServer()).get('/api/v1/reportes/ventas?fecha=2025-02-31').set(auth).expect(422);
  });

  it('el ranking de productos acepta el mismo período', async () => {
    const mayo = await request(app.getHttpServer())
      .get('/api/v1/reportes/productos?periodo=mes&fecha=2025-05-20')
      .set(auth)
      .expect(200);
    expect(mayo.body).toHaveLength(1);
    expect(mayo.body[0].producto_nombre).toBe('Empanada');
    expect(Number(mayo.body[0].cantidad)).toBe(6);

    const anio = await request(app.getHttpServer())
      .get('/api/v1/reportes/productos?periodo=anio&fecha=2025-07-15&orden=ingreso')
      .set(auth)
      .expect(200);
    expect(anio.body.map((p: any) => p.producto_nombre)).toEqual(['Pabellón', 'Empanada']);
  });

  it('GET /reportes/dia sigue respondiendo con la misma forma de siempre', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/api/v1/reportes/dia?fecha=2025-05-10')
      .set(auth)
      .expect(200);

    expect(body.porTurno).toHaveLength(3); // almuerzo, cena, madrugada
    expect(body.total.cobros).toBe(3);
    expect(Number(body.total.total_usd)).toBe(350);
  });
});
