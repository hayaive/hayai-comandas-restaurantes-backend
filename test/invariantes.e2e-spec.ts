import { Fixture, montar } from './fixture';

/**
 * Invariantes críticos del modelo cliente + comandas + cobro por líneas,
 * garantizados por Postgres (prisma/sql/01_constraints_y_triggers.sql) y
 * ejercitados contra la API real, que es donde tienen que seguir cumpliéndose.
 *
 *   B · un cliente (o una mesa con varios) acepta VARIAS comandas vivas
 *   C · la cola de despacho es FIFO GLOBAL, con las líneas embebidas
 *   D · despachar saca de la cola, no borra
 *   E · las líneas se editan también DESPUÉS de despachar; las facturadas, sólo
 *       corrigiendo su factura
 *   G · el cobro es del cliente, por líneas, y deja lo pendiente en cocina
 *   H · ⭐ dos cajeros cobrando al mismo cliente: uno gana, el otro 409
 *
 * Más la ocupación de mesa por cliente (reserva sentada, check-in por QR) y el
 * EXCLUDE de reservaciones.
 */
describe('Invariantes críticos (e2e)', () => {
  let f: Fixture;
  let mesaId: string;
  let mesaDosId: string;
  let mesaTresId: string;

  const API = '/api/v1';
  const crearCliente = (nombre: string, mesa?: string) =>
    f.http().post(`${API}/clientes`).set(f.auth).send({ nombre, mesaId: mesa });
  /** Un cliente nuevo, ya creado (201). */
  const nuevoCliente = async (nombre: string, mesa?: string) => (await crearCliente(nombre, mesa).expect(201)).body;
  const pedir = (clienteId: string, cantidad = 1) =>
    f.http().post(`${API}/comandas`).set(f.auth).send({
      clienteId,
      comensales: 2,
      items: [{ productoId: f.productoId, cantidad }],
    });
  const despachar = (comandaId: string) => f.http().post(`${API}/comandas/${comandaId}/despachar`).set(f.auth);
  const cobrar = (clienteId: string, body: Record<string, unknown>) =>
    f.http().post(`${API}/clientes/${clienteId}/cobrar`).set(f.auth).send(body);
  const efectivo = (monto: number) => [{ metodo: 'efectivo_usd', moneda: 'USD', monto }];
  const cuenta = async (clienteId: string) => (await f.http().get(`${API}/clientes/${clienteId}`).set(f.auth).expect(200)).body;
  const filaDePlano = async (mesa: string) => {
    const { body } = await f.http().get(`${API}/plano`).set(f.auth).expect(200);
    return body.find((m: any) => m.mesa_id === mesa);
  };

  beforeAll(async () => {
    f = await montar('test');
    [mesaId, mesaDosId, mesaTresId] = f.mesas;
  }, 30_000);

  afterAll(() => f.cerrar());

  it('GET /auth/yo devuelve el usuario autenticado', async () => {
    const res = await f.http().get(`${API}/auth/yo`).set(f.auth).expect(200);
    expect(res.body.restauranteId).toBe(f.restauranteId);
  });

  it('GET /salones devuelve el salón recién creado', async () => {
    const res = await f.http().get(`${API}/salones`).set(f.auth).expect(200);
    expect(res.body.some((s: any) => s.id === f.salonId)).toBe(true);
  });

  it('una comanda nace ya en la cola de despacho, con sus líneas, su total y su cliente', async () => {
    const cliente = await nuevoCliente('Ana');
    const { body } = await pedir(cliente.id, 2).expect(201);

    expect(body.estado).toBe('pendiente');
    expect(body.despachadaEn).toBeNull();
    expect(body.clienteId).toBe(cliente.id);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].clienteId).toBe(cliente.id);
    expect(Number(body.total)).toBe(20);

    // Sin líneas no hay comanda (sería un ticket en blanco en cocina); sin cliente tampoco.
    await f.http().post(`${API}/comandas`).set(f.auth).send({ clienteId: cliente.id, items: [] }).expect(400);
    await f.http().post(`${API}/comandas`).set(f.auth).send({ items: [{ productoId: f.productoId, cantidad: 1 }] }).expect(400);
  });

  it('B · un cliente acepta varias comandas vivas, y una mesa varios clientes con cuentas separadas', async () => {
    const a = await nuevoCliente('Cliente A', mesaId);
    const b = await nuevoCliente('Cliente B', mesaId);
    const a1 = await pedir(a.id).expect(201);
    const a2 = await pedir(a.id).expect(201);
    await pedir(b.id).expect(201);
    expect(a1.body.id).not.toBe(a2.body.id);
    // La comanda congela la mesa donde estaba sentado.
    expect(a1.body.mesaId).toBe(mesaId);

    const cuentaA = await cuenta(a.id);
    expect(cuentaA.cuenta.comandas).toBe(2);
    expect(cuentaA.cuenta.comandas_en_cocina).toBe(2);
    expect(Number(cuentaA.cuenta.cuenta_total)).toBe(20);

    const { body: deMesa } = await f.http().get(`${API}/mesas/${mesaId}/cuenta`).set(f.auth).expect(200);
    expect(deMesa.clientes.map((c: any) => c.cliente_nombre).sort()).toEqual(['Cliente A', 'Cliente B']);

    // El plano mantiene sus columnas y suma los dos clientes.
    const fila = await filaDePlano(mesaId);
    expect(fila.estado).toBe('ocupada');
    expect(fila.clientes).toBe(2);
    expect(fila.clientes_detalle.map((c: any) => c.nombre)).toEqual(['Cliente A', 'Cliente B']);
    expect(fila.comandas).toBe(3);
    expect(Number(fila.cuenta_total)).toBe(30);
  });

  it('C/D · la cola es FIFO global entre mesas, y despachar saca de la cola sin borrar', async () => {
    const x = await nuevoCliente('Cola X', mesaDosId);
    const y = await nuevoCliente('Cola Y', mesaTresId);
    const primera = await pedir(x.id).expect(201);
    const segunda = await pedir(y.id).expect(201);
    const tercera = await pedir(x.id).expect(201);

    const { body: cola } = await f.http().get(`${API}/despacho/cola`).set(f.auth).expect(200);
    const ids = [primera.body.id, segunda.body.id, tercera.body.id];
    // Orden de llegada, sin agrupar por cliente ni por mesa (hay comandas de otros tests antes).
    expect(cola.map((c: any) => c.comanda_id).filter((id: string) => ids.includes(id))).toEqual(ids);
    const fila = cola.find((c: any) => c.comanda_id === primera.body.id);
    expect(fila.items).toHaveLength(1);
    expect(fila.cliente_nombre).toBe('Cola X');

    await despachar(primera.body.id).expect(201);
    const { body: despues } = await f.http().get(`${API}/despacho/cola`).set(f.auth).expect(200);
    expect(despues.map((c: any) => c.comanda_id)).not.toContain(primera.body.id);

    const enBase = await f.prisma.comanda.findUniqueOrThrow({ where: { id: primera.body.id } });
    expect(enBase.estado).toBe('despachada');
    await despachar(primera.body.id).expect(409);
  });

  it('E · las líneas se editan después de despachar; una línea nueva NO vuelve a cocina; las facturadas se corrigen con su factura', async () => {
    const cliente = await nuevoCliente('Edita', mesaId);

    // Pendiente: anular la línea recalcula el total.
    const pendiente = await pedir(cliente.id, 3).expect(201);
    await f.http()
      .delete(`${API}/comandas/${pendiente.body.id}/items/${pendiente.body.items[0].id}`)
      .set(f.auth)
      .send({ motivo: 'se arrepintió' })
      .expect(204);
    const trasAnular = await f.prisma.comanda.findUniqueOrThrow({ where: { id: pendiente.body.id } });
    expect(Number(trasAnular.total)).toBe(0);

    // Despachada: agregar, cambiar cantidad y anular, todo permitido (y auditado).
    const comanda = await pedir(cliente.id).expect(201);
    await despachar(comanda.body.id).expect(201);
    const itemId = comanda.body.items[0].id;

    await f.http()
      .post(`${API}/comandas/${comanda.body.id}/items`)
      .set(f.auth)
      .send({ items: [{ productoId: f.productoId, cantidad: 2, nota: 'sin picante' }] })
      .expect(201);
    const { body: trasAgregar } = await f.http().get(`${API}/comandas/${comanda.body.id}`).set(f.auth).expect(200);
    expect(trasAgregar.estado).toBe('despachada');
    expect(trasAgregar.items).toHaveLength(2);
    expect(Number(trasAgregar.total)).toBe(30);
    // No vuelve a cocina: la comanda sigue fuera de la cola.
    const { body: cola } = await f.http().get(`${API}/despacho/cola`).set(f.auth).expect(200);
    expect(cola.map((c: any) => c.comanda_id)).not.toContain(comanda.body.id);

    await f.http().patch(`${API}/comandas/${comanda.body.id}/items/${itemId}`).set(f.auth).send({ cantidad: 2 }).expect(200);
    const lineaNueva = trasAgregar.items.find((i: any) => i.id !== itemId);
    await f.http()
      .delete(`${API}/comandas/${comanda.body.id}/items/${lineaNueva.id}`)
      .set(f.auth)
      .send({ motivo: 'se devolvió' })
      .expect(204);
    const { body: trasEditar } = await f.http().get(`${API}/comandas/${comanda.body.id}`).set(f.auth).expect(200);
    expect(Number(trasEditar.total)).toBe(20);

    // Todo cambio posterior al despacho quedó en la bitácora, con autor.
    const bitacora = await f.prisma.bitacora.findMany({ where: { restauranteId: f.restauranteId, tabla: 'comanda_item' } });
    expect(bitacora.length).toBeGreaterThanOrEqual(3);
    expect(bitacora.every((b) => b.usuarioId === f.usuarioId)).toBe(true);

    // Facturada: sus líneas ya no se tocan desde la comanda.
    await cobrar(cliente.id, { pagos: efectivo(20) }).expect(201);
    await f.http().patch(`${API}/comandas/${comanda.body.id}/items/${itemId}`).set(f.auth).send({ cantidad: 1 }).expect(409);
    await f.http()
      .delete(`${API}/comandas/${comanda.body.id}/items/${itemId}`)
      .set(f.auth)
      .send({ motivo: 'tarde' })
      .expect(409);
    const { body: cobrada } = await f.http().get(`${API}/comandas/${comanda.body.id}`).set(f.auth).expect(200);
    expect(cobrada.estado).toBe('cobrada');

    // Agregarle una línea a una comanda cobrada la deja `cobrada_parcial` y le suma deuda al cliente.
    await f.http()
      .post(`${API}/comandas/${comanda.body.id}/items`)
      .set(f.auth)
      .send({ items: [{ productoId: f.productoId, cantidad: 1 }] })
      .expect(201);
    const { body: parcial } = await f.http().get(`${API}/comandas/${comanda.body.id}`).set(f.auth).expect(200);
    expect(parcial.estado).toBe('cobrada_parcial');
    expect(Number((await cuenta(cliente.id)).cuenta.total_por_cobrar)).toBe(10);
  });

  it('G · el cobro es del cliente: cubre lo despachado y deja lo pendiente en cocina', async () => {
    const cliente = await nuevoCliente('Gaby', mesaId);
    const despachada = await pedir(cliente.id).expect(201);
    await despachar(despachada.body.id).expect(201);
    const enCocina = await pedir(cliente.id).expect(201);

    const antes = await cuenta(cliente.id);
    expect(antes.cuenta.comandas_por_cobrar).toBe(1);
    expect(antes.cuenta.comandas_en_cocina).toBe(1);

    const { body: cobro } = await cobrar(cliente.id, { propina: 2, pagos: efectivo(12) }).expect(201);
    expect(Number(cobro.subtotal)).toBe(10);
    expect(Number(cobro.propina)).toBe(2);
    expect(Number(cobro.total)).toBe(12);
    expect(cobro.clienteId).toBe(cliente.id);
    // La factura sabe exactamente qué líneas cubrió: lo que sigue en cocina no entró.
    expect(cobro.lineas.map((l: any) => l.comandaId)).toEqual([despachada.body.id]);
    expect(cobro.lineas[0].comanda.numeroDia).toBe(despachada.body.numeroDia);

    const despues = await cuenta(cliente.id);
    expect(despues.cuenta.comandas_por_cobrar).toBe(0);
    expect(despues.cuenta.comandas_en_cocina).toBe(1);
    expect(despues.lineas.map((l: any) => l.comandaId)).toEqual([enCocina.body.id]);

    const descuadres = await f.prisma.$queryRaw<any[]>`SELECT * FROM v_cobro_descuadre WHERE restaurante_id = ${f.restauranteId}::uuid`;
    expect(descuadres).toHaveLength(0);

    const { body: reimpresa } = await f.http().get(`${API}/cobros/${cobro.id}`).set(f.auth).expect(200);
    expect(reimpresa.pagos).toHaveLength(1);
    expect(reimpresa.lineas).toHaveLength(1);
  });

  it('no se puede cobrar a un cliente que no tiene nada despachado (409)', async () => {
    const cliente = await nuevoCliente('Sin despachar', mesaDosId);
    await pedir(cliente.id).expect(201);
    await cobrar(cliente.id, { pagos: efectivo(10) }).expect(409);
  });

  it('los pagos tienen que cuadrar con el total de la cuenta', async () => {
    const cliente = await nuevoCliente('Paga mal', mesaDosId);
    const comanda = await pedir(cliente.id).expect(201);
    await despachar(comanda.body.id).expect(201);

    await cobrar(cliente.id, { pagos: efectivo(3) }).expect(400);
    // Pago móvil sin referencia: no se puede conciliar con el banco.
    await cobrar(cliente.id, { pagos: [{ metodo: 'pago_movil', moneda: 'USD', monto: 10 }] }).expect(400);

    // Tras los dos rechazos la cuenta sigue viva, sin factura a medias.
    expect(await f.prisma.cobro.count({ where: { restauranteId: f.restauranteId, clienteId: cliente.id } })).toBe(0);
  });

  it('H · ⭐ dos cajeros cobrando al mismo cliente a la vez: uno cobra, el otro recibe 409', async () => {
    const cliente = await nuevoCliente('Carrera', mesaTresId);
    const a = await pedir(cliente.id).expect(201);
    const b = await pedir(cliente.id).expect(201);
    await despachar(a.body.id).expect(201);
    await despachar(b.body.id).expect(201);

    // El `SELECT ... FOR UPDATE` sobre las líneas serializa: la segunda espera
    // el lock y, tras el COMMIT de la primera, encuentra 0 líneas cobrables.
    const [uno, dos] = await Promise.all([
      cobrar(cliente.id, { pagos: efectivo(20) }),
      cobrar(cliente.id, { pagos: efectivo(20) }),
    ]);
    expect([uno.status, dos.status].sort()).toEqual([201, 409]);

    // UNA sola factura, y cubre las líneas de las DOS comandas.
    const cobros = await f.prisma.cobro.findMany({ where: { restauranteId: f.restauranteId, clienteId: cliente.id } });
    expect(cobros).toHaveLength(1);
    expect(Number(cobros[0].total)).toBe(20);
    const cubiertas = await f.prisma.comandaItem.findMany({ where: { restauranteId: f.restauranteId, cobroId: cobros[0].id } });
    expect(cubiertas.map((l) => l.comandaId).sort()).toEqual([a.body.id, b.body.id].sort());
  });

  it('⭐ sentar una reservación abre el cliente y ocupa la mesa YA; cobrar y cerrar la libera', async () => {
    const mesa = f.mesas[3];
    const reserva = await f.http().post(`${API}/reservaciones`).set(f.auth).send({
      salonId: f.salonId,
      mesaId: mesa,
      clienteNombre: 'Cliente que llega',
      personas: 2,
      iniciaEn: '2027-03-01T20:00:00.000Z',
      duracionMin: 90,
    }).expect(201);

    // La reserva es de 2027, fuera de la ventana de 'reservada': nada pinta la mesa.
    expect((await filaDePlano(mesa)).estado).toBe('libre');

    const { body: sentada } = await f.http().post(`${API}/reservaciones/${reserva.body.id}/sentar`).set(f.auth).send({}).expect(201);
    expect(sentada.reservacion.estado).toBe('sentada');
    expect(sentada.cliente.nombre).toBe('Cliente que llega');
    expect(sentada.cliente.mesaId).toBe(mesa);
    expect(sentada.cliente.reservacionId).toBe(reserva.body.id);
    // El doble toque no abre otro cliente.
    await f.http().post(`${API}/reservaciones/${reserva.body.id}/sentar`).set(f.auth).send({}).expect(409);

    const ocupada = await filaDePlano(mesa);
    expect(ocupada.estado).toBe('ocupada');
    expect(ocupada.comandas).toBe(0);
    expect(ocupada.sentada_reservacion_id).toBe(reserva.body.id);
    expect(ocupada.sentada_cliente).toBe('Cliente que llega');
    expect(ocupada.ocupada_desde).not.toBeNull();

    const comanda = await pedir(sentada.cliente.id).expect(201);
    await despachar(comanda.body.id).expect(201);
    expect((await filaDePlano(mesa)).estado).toBe('ocupada');

    // Cobrar NO libera la mesa por sí solo: libera cerrar al cliente (aquí, con la bandera).
    await cobrar(sentada.cliente.id, { pagos: efectivo(10), cerrarCliente: true }).expect(201);
    expect((await f.prisma.reservacion.findUniqueOrThrow({ where: { id: reserva.body.id } })).estado).toBe('completada');
    expect((await filaDePlano(mesa)).estado).toBe('libre');
  });

  it('el check-in público por QR también abre el cliente y ocupa la mesa', async () => {
    const mesa = f.mesas[3];
    const reserva = await f.http().post(`${API}/reservaciones`).set(f.auth).send({
      salonId: f.salonId,
      mesaId: mesa,
      clienteNombre: 'Llega por QR',
      personas: 2,
      iniciaEn: '2027-05-01T20:00:00.000Z',
      duracionMin: 90,
    }).expect(201);

    await f.http().post(`${API}/publico/reserva/${reserva.body.codigoPublico}/checkin`).expect(201);
    const abiertos = await f.prisma.cliente.findMany({ where: { restauranteId: f.restauranteId, reservacionId: reserva.body.id } });
    expect(abiertos).toHaveLength(1);
    expect(abiertos[0].mesaId).toBe(mesa);
    expect(abiertos[0].cerradoEn).toBeNull();
    expect((await filaDePlano(mesa)).estado).toBe('ocupada');

    // Y se libera cancelando la reserva (el cliente se cierra solo si no debe nada).
    await f.http().post(`${API}/reservaciones/${reserva.body.id}/cancelar`).set(f.auth).send({ motivo: 'se fue' }).expect(201);
    expect((await filaDePlano(mesa)).estado).toBe('libre');
  });

  it('no se puede reservar dos veces la misma mesa en horarios que se solapan (reservacion_sin_solape → 409)', async () => {
    const reservar = (clienteNombre: string, iniciaEn: string, duracionMin: number) =>
      f.http().post(`${API}/reservaciones`).set(f.auth).send({ salonId: f.salonId, mesaId, clienteNombre, personas: 2, iniciaEn, duracionMin });

    const base = await reservar('Cliente A', '2027-01-10T20:00:00.000Z', 90).expect(201);
    expect(base.body.estado).toBe('pendiente');

    const solapada = await reservar('Cliente B', '2027-01-10T20:30:00.000Z', 90).expect(409);
    expect(solapada.body.message).toMatch(/ya está reservada/i);

    const adyacente = await reservar('Cliente C', '2027-01-10T21:30:00.000Z', 60).expect(201);
    expect(adyacente.body.estado).toBe('pendiente');
  });
});
