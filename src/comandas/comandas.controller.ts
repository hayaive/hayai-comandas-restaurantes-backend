import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ComandasService } from './comandas.service';
import {
  ActualizarItemDto,
  AgregarItemsDto,
  AnularDto,
  CancelarItemDto,
  CobrarMesaDto,
  CrearComandaDto,
  MoverComandaDto,
} from './dto/comanda.dto';
import { ReporteDiaQueryDto } from '../reportes/dto/reportes.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';
import { Modulo } from '../comun/decoradores/modulo.decorator';

/**
 * Comandas: el PEDIDO. Nace en la cola de despacho y muere despachado, anulado
 * o cubierto por un cobro.
 *
 * Desaparecieron con el rediseño de comandas múltiples:
 *   · `GET  /comandas/activas`        → `GET /cuentas-por-cobrar` y `GET /despacho/cola`
 *                                        (la vista `v_comanda_activa` ya no existe)
 *   · `POST /comandas/:id/enviar`     → no hay borrador: `POST /comandas` ya encola
 *   · `PATCH /comandas/:id/items/:itemId/estado` → no hay workflow por ítem
 *   · `POST /comandas/:id/cuenta`     → no existe el estado `por_cobrar`
 *   · `POST /comandas/:id/cobrar`     → `POST /mesas/:mesaId/cobrar`, el cobro es de la mesa
 *   · `GET  /cocina/cola?destino=`    → `GET /despacho/cola`, global y por comanda
 */
@Controller('comandas')
export class ComandasController {
  constructor(private readonly comandas: ComandasService) {}

  @Post()
  @Modulo('mesero')
  crear(@UsuarioActual() u: UsuarioSesion, @Body() dto: CrearComandaDto) {
    return this.comandas.crearComanda(u.restauranteId, u.id, dto);
  }

  @Get(':id')
  @Modulo('mesero', 'despacho', 'mesas', 'por_cobrar')
  obtener(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.comandas.obtenerConDetalle(u.restauranteId, id);
  }

  @Post(':id/items')
  @Modulo('mesero')
  agregarItems(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: AgregarItemsDto) {
    return this.comandas.agregarItems(u.restauranteId, id, dto);
  }

  @Patch(':id/items/:itemId')
  @Modulo('mesero')
  actualizarItem(
    @UsuarioActual() u: UsuarioSesion,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: ActualizarItemDto,
  ) {
    return this.comandas.actualizarItem(u.restauranteId, id, itemId, dto);
  }

  /** Anular UNA línea antes de despachar. No borra: deja `canceladoEn`. */
  @Delete(':id/items/:itemId')
  @HttpCode(204)
  @Modulo('despacho')
  async cancelarItem(
    @UsuarioActual() u: UsuarioSesion,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: CancelarItemDto,
  ) {
    await this.comandas.cancelarItem(u.restauranteId, id, itemId, dto.motivo, u.id);
  }

  /** La cocina sacó el pedido: sale de la cola, no de la base. */
  @Post(':id/despachar')
  @Modulo('despacho')
  despachar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.comandas.despachar(u.restauranteId, id);
  }

  @Post(':id/mover')
  @Modulo('mesas', 'mesero')
  mover(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: MoverComandaDto) {
    return this.comandas.moverComanda(u.restauranteId, id, dto.mesaIdDestino);
  }

  @Post(':id/anular')
  @Modulo('despacho')
  anular(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: AnularDto) {
    return this.comandas.anular(u.restauranteId, id, dto.motivo, u.id);
  }
}

/** La pantalla de cocina/barra (KDS): una sola cola, global y en orden de llegada. */
@Controller('despacho')
export class DespachoController {
  constructor(private readonly comandas: ComandasService) {}

  // ⚠️ El shell del frontend (`useComandaBootstrap` en AppShell) hoy pide la
  // cola y las cuentas en TODAS las pantallas para los contadores del menú.
  // Con módulos, el frontend tiene que pedirlas sólo si la persona tiene
  // Despacho / Por cobrar; si no, recibe un 403 en cada sondeo.
  @Get('cola')
  @Modulo('despacho')
  cola(@UsuarioActual() u: UsuarioSesion) {
    return this.comandas.colaDespacho(u.restauranteId);
  }
}

/** El menú del cajero: qué mesas deben dinero. */
@Controller('cuentas-por-cobrar')
export class CuentasPorCobrarController {
  constructor(private readonly comandas: ComandasService) {}

  @Get()
  @Modulo('por_cobrar')
  listar(@UsuarioActual() u: UsuarioSesion) {
    return this.comandas.cuentasPorCobrar(u.restauranteId);
  }
}

/**
 * La cuenta de una mesa y su cobro.
 *
 * Cuelga de `/mesas` y no de `/comandas` porque la unidad de cobro es la mesa:
 * una mesa tiene N comandas y se cobran juntas. Convive con `MesasController`
 * (CRUD del catálogo de mesas) sin chocar: las rutas tienen distinta forma.
 */
@Controller('mesas')
export class CuentaMesaController {
  constructor(private readonly comandas: ComandasService) {}

  @Get(':mesaId/cuenta')
  @Modulo('mesas', 'por_cobrar')
  cuenta(@UsuarioActual() u: UsuarioSesion, @Param('mesaId') mesaId: string) {
    return this.comandas.cuentaDeMesa(u.restauranteId, mesaId);
  }

  @Post(':mesaId/cobrar')
  @Modulo('mesas', 'por_cobrar')
  cobrar(
    @UsuarioActual() u: UsuarioSesion,
    @Param('mesaId') mesaId: string,
    @Body() dto: CobrarMesaDto,
  ) {
    return this.comandas.cobrarMesa(u.restauranteId, mesaId, dto, u.id);
  }
}

/** Las facturas emitidas: reimprimir y anular. */
@Controller('cobros')
export class CobrosController {
  constructor(private readonly comandas: ComandasService) {}

  /** GET /cobros?fecha= — el histórico de facturas de un día operativo (Ventas). */
  @Get()
  @Modulo('ventas')
  listar(@UsuarioActual() u: UsuarioSesion, @Query() q: ReporteDiaQueryDto) {
    return this.comandas.cobrosDelDia(u.restauranteId, q.fecha);
  }

  @Get(':id')
  @Modulo('mesas', 'por_cobrar', 'ventas')
  obtener(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.comandas.obtenerCobro(u.restauranteId, id);
  }

  @Post(':id/anular')
  @Modulo('por_cobrar')
  anular(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: AnularDto) {
    return this.comandas.anularCobro(u.restauranteId, id, dto.motivo, u.id);
  }
}
