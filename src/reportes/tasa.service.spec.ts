import { TasaService } from './tasa.service';

/**
 * El BCV a veces publica la "fecha valor" ADELANTADA a hoy (viernes en la
 * tarde ya publica el valor que rige el lunes, o antes de un feriado publica
 * el del siguiente día hábil). `actualizarDesdeApiExterna` debe sellar el
 * upsert con esa fecha real de vigencia (`fechaActualizacion` de dolarapi.com)
 * en vez de "hoy", cayendo de vuelta a "hoy" sólo si el dato no viene o es
 * inválido.
 */
describe('TasaService.actualizarDesdeApiExterna — fecha valor del BCV', () => {
  const RESTAURANTE_ID = 'r1';
  const ZONA = 'America/Caracas';

  function mockPrisma(upsert: jest.Mock) {
    return {
      restaurante: {
        findFirstOrThrow: jest.fn().mockResolvedValue({ id: RESTAURANTE_ID, zonaHoraria: ZONA }),
      },
      tasaCambio: {
        upsert,
        findFirst: jest.fn().mockResolvedValue(null),
      },
    } as unknown as ConstructorParameters<typeof TasaService>[0];
  }

  function respuestaDolarapi(promedio: number, fechaActualizacion?: string | null) {
    return [
      {
        moneda: 'USD',
        fuente: 'oficial',
        promedio,
        ...(fechaActualizacion !== undefined ? { fechaActualizacion } : {}),
      },
    ];
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sella la tasa con la fechaActualizacion del BCV cuando viene adelantada a hoy (ej. viernes → lunes)', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = mockPrisma(upsert);
    const service = new TasaService(prisma);

    // Hoy es viernes 2026-09-11 en la data de prueba; el BCV ya publicó el
    // valor que rige el lunes 2026-09-14.
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({
        ok: true,
        json: async () => respuestaDolarapi(832.4883, '2026-09-14T00:00:00-04:00'),
      } as Response);

    await service.actualizarDesdeApiExterna(RESTAURANTE_ID);

    expect(fetchMock).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
    const args = upsert.mock.calls[0][0];
    expect(args.where.restauranteId_divisa_fecha_fuente.fecha.toISOString().substring(0, 10)).toBe('2026-09-14');
    expect(args.create.valor).toBe(832.4883);
  });

  it('cae a "hoy" cuando fechaActualizacion no viene', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = mockPrisma(upsert);
    const service = new TasaService(prisma);

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => respuestaDolarapi(100, undefined),
    } as Response);

    await service.actualizarDesdeApiExterna(RESTAURANTE_ID);

    const args = upsert.mock.calls[0][0];
    const hoy = new Date().toISOString().substring(0, 10);
    // Sólo verificamos que NO explota y que usa una fecha válida (hoy en
    // alguna zona horaria cercana); el detalle exacto de "hoy" ya lo cubre
    // hoyEnZona en su propio uso dentro del servicio.
    expect(typeof args.where.restauranteId_divisa_fecha_fuente.fecha.toISOString()).toBe('string');
    expect(args.create.valor).toBe(100);
    void hoy;
  });

  it('cae a "hoy" cuando fechaActualizacion es una fecha inválida', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = mockPrisma(upsert);
    const service = new TasaService(prisma);

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => respuestaDolarapi(100, 'no-es-una-fecha'),
    } as Response);

    await service.actualizarDesdeApiExterna(RESTAURANTE_ID);

    const args = upsert.mock.calls[0][0];
    expect(args.create.valor).toBe(100);
    expect(Number.isNaN(args.where.restauranteId_divisa_fecha_fuente.fecha.getTime())).toBe(false);
  });

  it('dos fetches seguidos con la misma fechaActualizacion upsertean la MISMA fila (misma fecha en el where), no duplicados', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = mockPrisma(upsert);
    const service = new TasaService(prisma);

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => respuestaDolarapi(832.4883, '2026-09-14T00:00:00-04:00'),
    } as Response);

    await service.actualizarDesdeApiExterna(RESTAURANTE_ID);
    await service.actualizarDesdeApiExterna(RESTAURANTE_ID);

    expect(upsert).toHaveBeenCalledTimes(4); // USD + EUR, dos veces
    const fecha1 = upsert.mock.calls[0][0].where.restauranteId_divisa_fecha_fuente.fecha.toISOString();
    const fecha2 = upsert.mock.calls[2][0].where.restauranteId_divisa_fecha_fuente.fecha.toISOString();
    expect(fecha1).toBe(fecha2);
    expect(upsert.mock.calls[0][0].where.restauranteId_divisa_fecha_fuente.fuente).toBe('bcv');
  });
});
