import { Fixture, montar } from './fixture';

/**
 * El modelo nuevo de punta a punta (docs/DECISIONES-DATOS.md §15): el cliente
 * como unidad de cobro, la factura por LÍNEAS (con partición de cantidades) y
 * las correcciones de facturas con su cobro adicional o devolución.
 *
 * Cada escenario crea sus propios clientes; la tasa del dólar es 900.
 */
describe('Cliente, cobro por líneas y correcciones (e2e)', () => {
  let f: Fixture;
  const API = '/api/v1';

  const nuevoCliente = async (nombre: string, mesaId?: string) =>
    (await f.http().post(`${API}/clientes`).set(f.auth).send({ nombre, mesaId }).expect(201)).body;
  /** Pide y despacha una comanda con `cantidad` del producto de 10 USD. */
  const consumo = async (clienteId: string, cantidad = 1, despachada = true) => {
    const { body } = await f.http().post(`${API}/comandas`).set(f.auth)
      .send({ clienteId, comensales: 2, items: [{ productoId: f.productoId, cantidad }] }).expect(201);
    if (despachada) await f.http().post(`${API}/comandas/${body.id}/despachar`).set(f.auth).expect(201);
    return body;
  };
  const cobrar = (clienteId: string, body: Record<string, unknown>) =>
    f.http().post(`${API}/clientes/${clienteId}/cobrar`).set(f.auth).send(body);
  const efectivo = (monto: number) => ({ metodo: 'efectivo_usd', moneda: 'USD', monto });
  const cuenta = async (clienteId: string) => (await f.http().get(`${API}/clientes/${clienteId}`).set(f.auth).expect(200)).body;
  const corregir = (cobroId: string, body: Record<string, unknown>) =>
    f.http().post(`${API}/cobros/${cobroId}/corregir`).set(f.auth).send({ motivo: 'prueba', ...body });
  const sumaUnidades = async (comandaId: string) => {
    const lineas = await f.prisma.comandaItem.findMany({ where: { comandaId, canceladoEn: null } });
    return lineas.reduce((a, l) => a + Number(l.cantidad), 0);
  };

  beforeAll(async () => {
    f = await montar('test-cc', ['T1', 'T2', 'T3', 'T4', 'T5']);
  }, 30_000);

  afterAll(() => f.cerrar());

  it('cobro parcial 2 de 3: la línea se parte, lo no cobrado queda como deuda del mismo cliente', async () => {
    const cliente = await nuevoCliente('Parcial', f.mesas[0]);
    const comanda = await consumo(cliente.id, 3);
    const lineaId = comanda.items[0].id;

    const { body: cobro } = await cobrar(cliente.id, { lineas: [{ lineaId, cantidad: 2 }], pagos: [efectivo(20)] }).expect(201);
    expect(Number(cobro.subtotal)).toBe(20);
    expect(cobro.lineas).toHaveLength(1);
    expect(Number(cobro.lineas[0].cantidad)).toBe(2);
    expect(cobro.lineas[0].id).not.toBe(lineaId); // la porción cobrada es la línea NUEVA

    // La deuda restante: 1 unidad, sin factura, del mismo cliente.
    const { lineas, cuenta: resumen } = await cuenta(cliente.id);
    expect(lineas).toHaveLength(1);
    expect(lineas[0].id).toBe(lineaId);
    expect(Number(lineas[0].cantidad)).toBe(1);
    expect(Number(lineas[0].totalLinea)).toBe(10);
    expect(lineas[0].cobroId).toBeNull();
    expect(Number(resumen.total_por_cobrar)).toBe(10);
    expect(Number(resumen.total_cobrado)).toBe(20);
    // Cada unidad se factura una vez: la suma de unidades se conserva.
    expect(await sumaUnidades(comanda.id)).toBe(3);
    expect((await f.prisma.comanda.findUniqueOrThrow({ where: { id: comanda.id } })).estado).toBe('cobrada_parcial');

    // No se puede cobrar más de lo que queda en la línea, ni repetirla.
    await cobrar(cliente.id, { lineas: [{ lineaId, cantidad: 2 }], pagos: [efectivo(20)] }).expect(400);
    await cobrar(cliente.id, { lineas: [{ lineaId }, { lineaId }], pagos: [efectivo(20)] }).expect(400);

    // Un cliente con deuda no se cierra.
    const rechazo = await f.http().post(`${API}/clientes/${cliente.id}/cerrar`).set(f.auth).expect(409);
    expect(rechazo.body.message).toMatch(/todavía debe 1 línea/);

    // Lo que queda se paga con pagos mixtos (4 USD + 5.400 Bs a 900 = 6 USD).
    const { body: segundo } = await cobrar(cliente.id, {
      pagos: [efectivo(4), { metodo: 'pago_movil', moneda: 'BS', monto: 5400, referencia: 'R-1' }],
    }).expect(201);
    expect(Number(segundo.total)).toBe(10);
    expect(segundo.pagos).toHaveLength(2);
    expect((await f.prisma.comanda.findUniqueOrThrow({ where: { id: comanda.id } })).estado).toBe('cobrada');
    expect(await sumaUnidades(comanda.id)).toBe(3);

    // Y ahora sí cierra, liberando la mesa.
    await f.http().post(`${API}/clientes/${cliente.id}/cerrar`).set(f.auth).expect(201);
    const plano = (await f.http().get(`${API}/plano`).set(f.auth).expect(200)).body;
    expect(plano.find((m: any) => m.mesa_id === f.mesas[0]).estado).toBe('libre');
  });

  it('reasignar líneas pendientes a otro cliente (existente o nuevo con otro nombre), con partición', async () => {
    const mesa = f.mesas[1];
    const origen = await nuevoCliente('Origen', mesa);
    const destino = await nuevoCliente('Destino', mesa);
    const c1 = await consumo(origen.id, 2);
    const c2 = await consumo(origen.id, 1);

    // 1 de las 2 unidades de c1 pasa a Destino (parte la línea).
    const { body: r1 } = await f.http().post(`${API}/clientes/${origen.id}/reasignar`).set(f.auth)
      .send({ clienteDestinoId: destino.id, lineas: [{ lineaId: c1.items[0].id, cantidad: 1 }] }).expect(201);
    expect(r1.destino.id).toBe(destino.id);
    expect(r1.lineas).toHaveLength(1);
    expect(Number(r1.lineas[0].cantidad)).toBe(1);
    expect(await sumaUnidades(c1.id)).toBe(2);

    // La línea de c2 entera pasa a un cliente NUEVO con otro nombre (hereda la mesa).
    const { body: r2 } = await f.http().post(`${API}/clientes/${origen.id}/reasignar`).set(f.auth)
      .send({ nuevoCliente: { nombre: '  Carlos  ' }, lineas: [{ lineaId: c2.items[0].id }] }).expect(201);
    expect(r2.destino.nombre).toBe('Carlos');
    expect(r2.destino.mesaId).toBe(mesa);
    expect(r2.destino.cerradoEn).toBeNull();

    expect(Number((await cuenta(origen.id)).cuenta.cuenta_total)).toBe(10);
    expect(Number((await cuenta(destino.id)).cuenta.cuenta_total)).toBe(10);
    expect(Number((await cuenta(r2.destino.id)).cuenta.cuenta_total)).toBe(10);

    // Destino paga lo suyo: la línea que cobró ya no se puede reasignar (409).
    const { body: cobro } = await cobrar(destino.id, { pagos: [efectivo(10)] }).expect(201);
    await f.http().post(`${API}/clientes/${destino.id}/reasignar`).set(f.auth)
      .send({ clienteDestinoId: origen.id, lineas: [{ lineaId: cobro.lineas[0].id }] }).expect(409);

    // Un destino cerrado no recibe deuda; destino y nuevoCliente a la vez, o ninguno, es 400.
    await f.http().post(`${API}/clientes/${destino.id}/cerrar`).set(f.auth).expect(201);
    const [restante] = (await cuenta(origen.id)).lineas;
    await f.http().post(`${API}/clientes/${origen.id}/reasignar`).set(f.auth)
      .send({ clienteDestinoId: destino.id, lineas: [{ lineaId: restante.id }] }).expect(409);
    await f.http().post(`${API}/clientes/${origen.id}/reasignar`).set(f.auth)
      .send({ clienteDestinoId: r2.destino.id, nuevoCliente: { nombre: 'X' }, lineas: [{ lineaId: restante.id }] }).expect(400);
    await f.http().post(`${API}/clientes/${origen.id}/reasignar`).set(f.auth)
      .send({ lineas: [{ lineaId: restante.id }] }).expect(400);
  });

  it('un cliente SIN mesa pide, la cocina despacha y se le cobra; sentar, mover y liberar', async () => {
    const cliente = await nuevoCliente('De pie');
    expect(cliente.mesaId).toBeNull();

    const comanda = await consumo(cliente.id, 1, false);
    expect(comanda.tipo).toBe('mesa');
    expect(comanda.mesaId).toBeNull();
    const { body: cola } = await f.http().get(`${API}/despacho/cola`).set(f.auth).expect(200);
    const enCola = cola.find((c: any) => c.comanda_id === comanda.id);
    expect(enCola.mesa_id).toBeNull();
    expect(enCola.cliente_nombre).toBe('De pie');

    const { body: sinMesa } = await f.http().get(`${API}/clientes?sinMesa=true`).set(f.auth).expect(200);
    expect(sinMesa.map((c: any) => c.cliente_id)).toContain(cliente.id);

    // Se sienta: su comanda que sigue en cocina se muda con él.
    await f.http().post(`${API}/clientes/${cliente.id}/sentar`).set(f.auth).send({ mesaId: f.mesas[2] }).expect(201);
    expect((await f.prisma.comanda.findUniqueOrThrow({ where: { id: comanda.id } })).mesaId).toBe(f.mesas[2]);
    const { body: enMesa } = await f.http().get(`${API}/clientes?mesaId=${f.mesas[2]}`).set(f.auth).expect(200);
    expect(enMesa.map((c: any) => c.cliente_id)).toContain(cliente.id);

    // Se mueve de mesa; ya despachada, la comanda conserva donde se sirvió.
    await f.http().post(`${API}/clientes/${cliente.id}/sentar`).set(f.auth).send({ mesaId: f.mesas[3] }).expect(201);
    expect((await f.prisma.comanda.findUniqueOrThrow({ where: { id: comanda.id } })).mesaId).toBe(f.mesas[3]);
    await f.http().post(`${API}/comandas/${comanda.id}/despachar`).set(f.auth).expect(201);
    await f.http().post(`${API}/clientes/${cliente.id}/sentar`).set(f.auth).send({ mesaId: f.mesas[4] }).expect(201);
    expect((await f.prisma.comanda.findUniqueOrThrow({ where: { id: comanda.id } })).mesaId).toBe(f.mesas[3]);

    // Se levanta (sigue abierto y debiendo) y paga sin mesa.
    const { body: libre } = await f.http().post(`${API}/clientes/${cliente.id}/liberar`).set(f.auth).expect(201);
    expect(libre.mesaId).toBeNull();
    const { body: cobro } = await cobrar(cliente.id, { pagos: [efectivo(10)] }).expect(201);
    expect(cobro.mesaId).toBeNull();
    expect(cobro.clienteNombre).toBe('De pie');

    // Para llevar: nunca lleva mesa, aunque el cliente esté sentado.
    const sentado = await nuevoCliente('Se lo lleva', f.mesas[0]);
    const llevar = await f.http().post(`${API}/comandas`).set(f.auth)
      .send({ clienteId: sentado.id, tipo: 'para_llevar', items: [{ productoId: f.productoId, cantidad: 1 }] }).expect(201);
    expect(llevar.body.tipo).toBe('para_llevar');
    expect(llevar.body.mesaId).toBeNull();

    await f.http().post(`${API}/clientes/${cliente.id}/cerrar`).set(f.auth).expect(201);
    // Un cliente cerrado no puede pedir hasta que se reabra.
    await f.http().post(`${API}/comandas`).set(f.auth)
      .send({ clienteId: cliente.id, items: [{ productoId: f.productoId, cantidad: 1 }] }).expect(409);
    await f.http().post(`${API}/clientes/${cliente.id}/reabrir`).set(f.auth).expect(201);
    await consumo(cliente.id, 1, false);
  });

  it('listar deudas y cuentas por cobrar', async () => {
    const cliente = await nuevoCliente('Deudor', f.mesas[2]);
    await consumo(cliente.id, 1, false); // en cocina: cuenta como deuda, no como cobrable
    const { body: deudas } = await f.http().get(`${API}/clientes/deudas`).set(f.auth).expect(200);
    expect(deudas.map((c: any) => c.cliente_id)).toContain(cliente.id);
    const { body: porCobrar } = await f.http().get(`${API}/cuentas-por-cobrar`).set(f.auth).expect(200);
    expect(porCobrar.map((c: any) => c.cliente_id)).not.toContain(cliente.id);
  });

  it('corregir una factura: con DEVOLUCIÓN si baja, con COBRO ADICIONAL si sube; todo en la bitácora', async () => {
    const cliente = await nuevoCliente('Corrige', f.mesas[3]);
    const comanda = await consumo(cliente.id, 3);
    const lineaId = comanda.items[0].id;
    const { body: cobro } = await cobrar(cliente.id, { pagos: [efectivo(30)] }).expect(201);

    // Baja a 2 unidades: sin la devolución, el servidor lo rechaza diciendo cuánto.
    const sinPago = await corregir(cobro.id, { cambios: [{ lineaId, cantidad: 2 }] }).expect(422);
    expect(sinPago.body.diferenciaUsd).toBe('-10.0000');
    expect(sinPago.body.message).toMatch(/devolución/);
    // La factura no cambió (todo en una transacción).
    expect(Number((await f.http().get(`${API}/cobros/${cobro.id}`).set(f.auth).expect(200)).body.total)).toBe(30);

    // No se devuelve por un método más de lo cobrado por él.
    await corregir(cobro.id, { cambios: [{ lineaId, cantidad: 2 }], pagos: [{ metodo: 'punto', moneda: 'USD', monto: -10 }] }).expect(422);

    const { body: bajo } = await corregir(cobro.id, {
      cambios: [{ lineaId, cantidad: 2 }],
      pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: -10 }],
    }).expect(201);
    expect(Number(bajo.subtotal)).toBe(20);
    expect(Number(bajo.total)).toBe(20);
    expect(Number(bajo.totalBs)).toBe(18000);
    expect(bajo.pagos.map((p: any) => Number(p.monto))).toEqual([30, -10]);

    // Sube con una línea nueva: el cobro adicional entra en bolívares (tasa congelada de la factura).
    const { body: alto } = await corregir(cobro.id, {
      agregar: [{ comandaId: comanda.id, productoId: f.productoId, cantidad: 1, nota: 'olvidado' }],
      pagos: [{ metodo: 'pago_movil', moneda: 'BS', monto: 9000, referencia: 'R-77' }],
    }).expect(201);
    expect(Number(alto.total)).toBe(30);
    expect(alto.lineas).toHaveLength(2);
    expect(alto.pagos).toHaveLength(3);
    // Un pago nunca se edita: los dos primeros siguen igual.
    expect(alto.pagos.slice(0, 2).map((p: any) => Number(p.monto))).toEqual([30, -10]);

    // Descuento y propina también corrigen; el nombre de la factura se puede cambiar.
    const { body: desc } = await corregir(cobro.id, {
      descuento: 5,
      propina: 1,
      clienteNombre: 'Nombre corregido',
      pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: -4 }],
    }).expect(201);
    expect(Number(desc.total)).toBe(26);
    expect(desc.clienteNombre).toBe('Nombre corregido');

    // Anular una línea de la factura, con devolución.
    const viva = alto.lineas.find((l: any) => l.nota === 'olvidado');
    const { body: sinViva } = await corregir(cobro.id, {
      cambios: [{ lineaId: viva.id, anular: true }],
      pagos: [{ metodo: 'efectivo_usd', moneda: 'USD', monto: -10 }],
    }).expect(201);
    expect(Number(sinViva.subtotal)).toBe(20);
    expect(sinViva.lineas.find((l: any) => l.id === viva.id).canceladoEn).not.toBeNull();

    // Quitarle todas las líneas no se corrige: se anula.
    await corregir(cobro.id, { cambios: [{ lineaId, anular: true }], pagos: [] }).expect(409);

    // Caja y facturas siguen cuadradas, y la bitácora guarda quién, cuándo y por qué.
    const descuadres = await f.prisma.$queryRaw<any[]>`SELECT * FROM v_cobro_descuadre WHERE restaurante_id = ${f.restauranteId}::uuid`;
    expect(descuadres).toHaveLength(0);
    const bitacora = await f.prisma.bitacora.findMany({ where: { restauranteId: f.restauranteId, entidadId: cobro.id, tabla: 'cobro' } });
    expect(bitacora.length).toBeGreaterThanOrEqual(4);
    expect(bitacora.every((b) => b.usuarioId === f.usuarioId && b.motivo === 'prueba')).toBe(true);

    // Una factura anulada ya no se corrige.
    await f.http().post(`${API}/cobros/${cobro.id}/anular`).set(f.auth).send({ motivo: 'error' }).expect(201);
    await corregir(cobro.id, { descuento: 0, pagos: [] }).expect(409);
    // Y su comanda no se anula con líneas facturadas.
    await f.http().post(`${API}/comandas/${comanda.id}/anular`).set(f.auth).send({ motivo: 'x' }).expect(409);
  });

  it('cerrar un cliente con deuda se rechaza (también lo que sigue en cocina)', async () => {
    const cliente = await nuevoCliente('Con deuda', f.mesas[4]);
    await consumo(cliente.id, 1, false);
    const r = await f.http().post(`${API}/clientes/${cliente.id}/cerrar`).set(f.auth).expect(409);
    expect(r.body.message).toMatch(/todavía debe/);
    expect((await f.prisma.cliente.findUniqueOrThrow({ where: { id: cliente.id } })).cerradoEn).toBeNull();

    // Anulando la comanda la deuda desaparece y entonces sí cierra.
    const { body: cola } = await f.http().get(`${API}/despacho/cola`).set(f.auth).expect(200);
    const suya = cola.find((c: any) => c.cliente_id === cliente.id);
    await f.http().post(`${API}/comandas/${suya.comanda_id}/anular`).set(f.auth).send({ motivo: 'se fue' }).expect(201);
    await f.http().post(`${API}/clientes/${cliente.id}/cerrar`).set(f.auth).expect(201);
  });
});
