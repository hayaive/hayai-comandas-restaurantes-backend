import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../comun/prisma/prisma.service';
import { nuevoId } from '../comun/id';
import { CrearTasaDto } from './dto/tasa.dto';
import { Divisa } from '../generated/prisma/enums';
import { TasaCambio } from '../generated/prisma/client';
import { hoyEnZona } from './tasa-fecha.util';

/** CONTRACT.md §`GET /tasa/vigente` — el dólar y el euro en UNA petición. */
export interface TasasVigentes {
  /** 'YYYY-MM-DD': hoy según la zona horaria del restaurante. */
  fecha: string;
  usd: TasaCambio | null;
  eur: TasaCambio | null;
}

const URL_DOLARES = 'https://ve.dolarapi.com/v1/dolares';
const URL_EUROS = 'https://ve.dolarapi.com/v1/euros';
const TIMEOUT_MS = 8_000;

@Injectable()
export class TasaService {
  private readonly logger = new Logger(TasaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /tasa/vigente — devuelve SIEMPRE 200, nunca 400. "Todavía no hay
   * tasa" es un estado vacío (usd/eur en null), no un error.
   *
   * "Vigente" = la última registrada por divisa, no necesariamente la de
   * hoy: `ORDER BY fecha DESC, creada_en DESC`. El desempate por `creadaEn`
   * es obligatorio: con varias `fuente` (BCV, Binance) para el mismo día,
   * ordenar sólo por `fecha` deja a Postgres elegir la fila y el resultado
   * cambia entre ejecuciones (docs/DECISIONES-DATOS.md §10.6).
   */
  async vigente(restauranteId: string): Promise<TasasVigentes> {
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });
    const { fechaISO } = hoyEnZona(restaurante.zonaHoraria);

    const [usd, eur] = await Promise.all([
      this.prisma.tasaCambio.findFirst({
        where: { restauranteId, divisa: 'USD' },
        orderBy: [{ fecha: 'desc' }, { creadaEn: 'desc' }],
      }),
      this.prisma.tasaCambio.findFirst({
        where: { restauranteId, divisa: 'EUR' },
        orderBy: [{ fecha: 'desc' }, { creadaEn: 'desc' }],
      }),
    ]);

    return { fecha: fechaISO, usd, eur };
  }

  /**
   * POST /tasa — registrar o corregir. Es un UPSERT sobre la clave natural
   * (restauranteId, divisa, fecha, fuente), no un create: corregir un tipeo
   * en la tasa de hoy es una operación normal y es segura para el histórico
   * porque `cobrar()` congela su propia copia en `comanda.tasaValor`
   * (CONTRACT.md §`POST /tasa`, DECISIONES-DATOS §10.5).
   *
   * `divisa` ausente = 'USD': el frontend ya desplegado llama
   * `registrarTasa(valor, fuente)` sin divisa y ese camino habla del dólar.
   */
  async crear(restauranteId: string, registradaPorId: string, dto: CrearTasaDto): Promise<TasaCambio> {
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });
    const { fecha } = hoyEnZona(restaurante.zonaHoraria);
    const divisa: Divisa = dto.divisa ?? 'USD';

    return this.prisma.tasaCambio.upsert({
      where: {
        restauranteId_divisa_fecha_fuente: { restauranteId, divisa, fecha, fuente: dto.fuente },
      },
      create: {
        id: nuevoId(),
        restauranteId,
        fecha,
        divisa,
        valor: dto.valor,
        fuente: dto.fuente,
        registradaPorId,
      },
      // La divisa nunca se toca en el UPDATE (trigger `tasa_divisa_inmutable`
      // de todos modos lo impediría): sólo se corrige el valor y quién la
      // corrigió por última vez.
      update: {
        valor: dto.valor,
        registradaPorId,
      },
    });
  }

  /**
   * POST /tasa/actualizar — refresco manual. Llama a dolarapi.com y hace el
   * mismo upsert (fuente 'bcv') que usa el cron. Devuelve la tasa vigente
   * resultante, igual que `GET /tasa/vigente`, para que el frontend no tenga
   * que pedirla dos veces.
   */
  async actualizarDesdeApiExterna(restauranteId: string): Promise<TasasVigentes> {
    const restaurante = await this.prisma.restaurante.findFirstOrThrow({ where: { id: restauranteId } });
    const { fecha } = hoyEnZona(restaurante.zonaHoraria);

    const [usdPromedio, eurPromedio] = await Promise.all([
      this.fetchPromedioOficial(URL_DOLARES),
      this.fetchPromedioOficial(URL_EUROS),
    ]);

    if (usdPromedio == null && eurPromedio == null) {
      this.logger.warn(
        `dolarapi.com no respondió para restaurante ${restauranteId}; se conserva la última tasa registrada (manual o de un fetch anterior)`,
      );
    }

    await Promise.all([
      usdPromedio != null ? this.upsertBcv(restauranteId, fecha, 'USD', usdPromedio) : Promise.resolve(),
      eurPromedio != null ? this.upsertBcv(restauranteId, fecha, 'EUR', eurPromedio) : Promise.resolve(),
    ]);

    return this.vigente(restauranteId);
  }

  private upsertBcv(restauranteId: string, fecha: Date, divisa: Divisa, valor: number) {
    return this.prisma.tasaCambio.upsert({
      where: {
        restauranteId_divisa_fecha_fuente: { restauranteId, divisa, fecha, fuente: 'bcv' },
      },
      create: { id: nuevoId(), restauranteId, fecha, divisa, valor, fuente: 'bcv' },
      update: { valor },
    });
  }

  /**
   * `GET https://ve.dolarapi.com/v1/dolares` y `.../v1/euros` (verificado en
   * vivo el 2026-09-13: ambos devuelven hoy un array
   * `[{ fuente, promedio, ... }]`, con `fuente: "oficial"` para el BCV — NO
   * `{ oficial: { promedio } }` como en versiones anteriores de la API que
   * usaba `/v1/euro` en singular, ese path ahora da 404). Se soportan las dos
   * formas por si la API vuelve a cambiar de shape sin aviso.
   *
   * Nunca lanza: un timeout o un error de red aquí no puede tumbar el cron ni
   * el arranque del servidor — se loguea y la tasa manual sigue de respaldo.
   */
  private async fetchPromedioOficial(url: string): Promise<number | null> {
    const controlador = new AbortController();
    const timeout = setTimeout(() => controlador.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controlador.signal });
      if (!res.ok) {
        this.logger.warn(`dolarapi.com respondió ${res.status} en ${url}`);
        return null;
      }
      const data: unknown = await res.json();

      let promedio: unknown;
      if (Array.isArray(data)) {
        const oficial = data.find((d) => (d as { fuente?: string })?.fuente === 'oficial');
        promedio = (oficial as { promedio?: unknown } | undefined)?.promedio;
      } else if (data && typeof data === 'object') {
        const obj = data as { oficial?: { promedio?: unknown }; promedio?: unknown };
        promedio = obj.oficial?.promedio ?? obj.promedio;
      }

      if (typeof promedio !== 'number' || !Number.isFinite(promedio) || promedio <= 0) {
        this.logger.warn(`dolarapi.com devolvió una respuesta sin "promedio" oficial válido en ${url}`);
        return null;
      }
      return promedio;
    } catch (err) {
      this.logger.warn(`No se pudo consultar ${url}: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
