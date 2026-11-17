import { Fixture, montar } from './fixture';

/**
 * Nombre del cliente en la factura (docs/DECISIONES-DATOS.md §14 y §15).
 * Desde §15 el nombre vive en el CLIENTE; la factura lo CONGELA al emitirse y
 * el cajero puede mandar otro (facturar a otro nombre) sin cambiar de cliente.
 */
describe('Nombre del cliente en la factura (e2e)', () => {
  let f: Fixture;
  const API = '/api/v1';

  const nuevoCliente = async (nombre: string, mesaId?: string) =>
    (await f.http().post(`${API}/clientes`).set(f.auth).send({ nombre, mesaId }).expect(201)).body;
  /** Un cliente con una comanda ya despachada de 10 USD. */
  const conConsumo = async (nombre: string, mesaId?: string) => {
    const cliente = await nuevoCliente(nombre, mesaId);
    const comanda = await f.http().post(`${API}/comandas`).set(f.auth)
      .send({ clienteId: cliente.id, items: [{ productoId: f.productoId, cantidad: 1 }] }).expect(201);
    await f.http().post(`${API}/comandas/${comanda.body.id}/despachar`).set(f.auth).expect(201);
    return cliente;
  };
  const cobrar = (clienteId: string, extra: Record<string, unknown> = {}) =>
    f.http().post(`${API}/clientes/${clienteId}/cobrar`).set(f.auth)
      .send({ pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: 10 }], ...extra });

  beforeAll(async () => {
    f = await montar('test-cn');
  }, 30_000);

  afterAll(() => f.cerrar());

  it('crear cliente: nombre con trim; vacío, en blanco o de más de 120 = 400', async () => {
    const a = await f.http().post(`${API}/clientes`).set(f.auth).send({ nombre: '  Luis  ' }).expect(201);
    expect(a.body.nombre).toBe('Luis');
    expect(a.body.mesaId).toBeNull();
    await f.http().post(`${API}/clientes`).set(f.auth).send({ nombre: '   ' }).expect(400);
    await f.http().post(`${API}/clientes`).set(f.auth).send({}).expect(400);
    await f.http().post(`${API}/clientes`).set(f.auth).send({ nombre: 'x'.repeat(121) }).expect(400);
  });

  it('(a) sin nombre en el cobro, la factura congela el del cliente; la reimpresión lo conserva aunque el cliente se renombre', async () => {
    const cliente = await conConsumo('Ana Pérez', f.mesas[0]);
    const { body: cobro } = await cobrar(cliente.id).expect(201);
    expect(cobro.clienteNombre).toBe('Ana Pérez');

    await f.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.usuario_id', ${f.usuarioId}, true)`;
      await tx.cliente.update({ where: { id: cliente.id }, data: { nombre: 'Otro nombre' } });
    });

    const { body: reimpreso } = await f.http().get(`${API}/cobros/${cobro.id}`).set(f.auth).expect(200);
    expect(reimpreso.clienteNombre).toBe('Ana Pérez');
    const { body: dia } = await f.http().get(`${API}/cobros`).set(f.auth).expect(200);
    expect(dia.find((c: any) => c.id === cobro.id).clienteNombre).toBe('Ana Pérez');
  });

  it('(b) cliente sentado desde una reserva: la factura lleva el nombre de la reserva', async () => {
    const reserva = await f.http().post(`${API}/reservaciones`).set(f.auth).send({
      salonId: f.salonId,
      mesaId: f.mesas[1],
      clienteNombre: '  Familia Rojas ',
      personas: 2,
      iniciaEn: '2027-03-01T20:00:00.000Z',
      duracionMin: 90,
    }).expect(201);
    const { body: sentada } = await f.http().post(`${API}/reservaciones/${reserva.body.id}/sentar`).set(f.auth).send({}).expect(201);
    expect(sentada.cliente.nombre).toBe('Familia Rojas');

    const comanda = await f.http().post(`${API}/comandas`).set(f.auth)
      .send({ clienteId: sentada.cliente.id, items: [{ productoId: f.productoId, cantidad: 1 }] }).expect(201);
    await f.http().post(`${API}/comandas/${comanda.body.id}/despachar`).set(f.auth).expect(201);
    const { body: cobro } = await cobrar(sentada.cliente.id).expect(201);
    expect(cobro.clienteNombre).toBe('Familia Rojas');
  });

  it('(c) el cajero manda "" o null: NULL aunque el cliente tenga nombre; manda texto: gana con trim (otro nombre, mismo cliente)', async () => {
    for (const [i, envio] of [
      [2, { clienteNombre: '' }],
      [2, { clienteNombre: null }],
      [3, { clienteNombre: '  Pedro  ' }],
    ] as const) {
      const cliente = await conConsumo(`Ana del mesero ${i}`, f.mesas[i]);
      const { body: cobro } = await cobrar(cliente.id, envio).expect(201);
      expect(cobro.clienteNombre).toBe(envio.clienteNombre ? 'Pedro' : null);
      // Facturar a otro nombre no cambia de cliente.
      expect(cobro.clienteId).toBe(cliente.id);
      expect(cobro.cliente.nombre).toBe(`Ana del mesero ${i}`);
    }
    const otro = await conConsumo('Para rechazar', f.mesas[0]);
    await cobrar(otro.id, { clienteNombre: 'x'.repeat(121) }).expect(400);
  });
});
