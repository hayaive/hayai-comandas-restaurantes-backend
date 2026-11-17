import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ComandasService } from './comandas.service';
import { CobrosService } from './cobros.service';
import { ClientesService } from '../clientes/clientes.service';
import {
  ActualizarItemDto,
  AgregarItemsDto,
  AnularDto,
  CancelarItemDto,
  CobrarClienteDto,
  CorregirCobroDto,
  CrearComandaDto,
} from './dto/comanda.dto';
import { ReporteDiaQueryDto } from '../reportes/dto/reportes.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';
import { Modulo } from '../comun/decoradores/modulo.decorator';

/**
 * Comandas: el PEDIDO. Nace en la cola de despacho y muere despachado o anulado.
 * Es de un cliente (`clienteId`); sus líneas se cobran por cliente.
 *
 * Desaparecieron:
 *   · `POST /comandas/:id/mover` → `POST /clientes/:id/sentar` (mueve al cliente
 *     y, con él, sus comandas que siguen en cocina)
 *   · `POST /mesas/:mesaId/cobrar` → `POST /clientes/:id/cobrar`
 *   (y antes: `/comandas/activas`, `/comandas/:id/enviar`, `/comandas/:id/cuenta`,
 *   `/cocina/cola`: ver CONTRACT.md §5)
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
  @Modulo('mesero', 'despacho', 'mesas', 'por_cobrar', 'ventas')
  obtener(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.comandas.obtenerConDetalle(u.restauranteId, id);
  }

  /** Agregar líneas, también a una comanda ya despachada o cobrada (no vuelven a cocina). */
  @Post(':id/items')
  @Modulo('mesero', 'por_cobrar')
  agregarItems(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: AgregarItemsDto) {
    return this.comandas.agregarItems(u.restauranteId, u.id, id, dto);
  }

  @Patch(':id/items/:itemId')
  @Modulo('mesero', 'por_cobrar')
  actualizarItem(
    @UsuarioActual() u: UsuarioSesion,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: ActualizarItemDto,
  ) {
    return this.comandas.actualizarItem(u.restauranteId, u.id, id, itemId, dto);
  }

  /** Anular UNA línea sin factura (antes o después de despachar). No borra: deja `canceladoEn`. */
  @Delete(':id/items/:itemId')
  @HttpCode(204)
  @Modulo('despacho', 'mesero', 'por_cobrar')
  async cancelarItem(
    @UsuarioActual() u: UsuarioSesion,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: CancelarItemDto,
  ) {
    await this.comandas.cancelarItem(u.restauranteId, u.id, id, itemId, dto.motivo);
  }

  /** La cocina sacó el pedido: sale de la cola, no de la base. */
  @Post(':id/despachar')
  @Modulo('despacho')
  despachar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.comandas.despachar(u.restauranteId, id);
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

  // ⚠️ El shell del frontend pide la cola y las cuentas en TODAS las pantallas
  // para los contadores del menú. Con módulos, sólo hay que pedirlas si la
  // persona tiene Despacho / Por cobrar; si no, recibe un 403 en cada sondeo.
  @Get('cola')
  @Modulo('despacho')
  cola(@UsuarioActual() u: UsuarioSesion) {
    return this.comandas.colaDespacho(u.restauranteId);
  }
}

/** El menú del cajero: qué clientes deben algo ya despachado. */
@Controller('cuentas-por-cobrar')
export class CuentasPorCobrarController {
  constructor(private readonly clientes: ClientesService) {}

  @Get()
  @Modulo('por_cobrar')
  listar(@UsuarioActual() u: UsuarioSesion) {
    return this.clientes.deudas(u.restauranteId, true);
  }
}

/** Quiénes están sentados en una mesa y qué debe cada uno. */
@Controller('mesas')
export class CuentaMesaController {
  constructor(private readonly clientes: ClientesService) {}

  @Get(':mesaId/cuenta')
  @Modulo('mesas', 'por_cobrar', 'mesero')
  cuenta(@UsuarioActual() u: UsuarioSesion, @Param('mesaId') mesaId: string) {
    return this.clientes.cuentaDeMesa(u.restauranteId, mesaId);
  }
}

/** El cobro es del CLIENTE: `POST /clientes/:id/cobrar` (el resto de `/clientes` vive en ClientesModule). */
@Controller('clientes')
export class ClienteCobroController {
  constructor(private readonly cobros: CobrosService) {}

  @Post(':id/cobrar')
  @Modulo('mesas', 'por_cobrar')
  cobrar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: CobrarClienteDto) {
    return this.cobros.cobrarCliente(u.restauranteId, id, dto, u.id);
  }
}

/** Las facturas emitidas: reimprimir, corregir y anular. */
@Controller('cobros')
export class CobrosController {
  constructor(private readonly cobros: CobrosService) {}

  /** GET /cobros?fecha= — el histórico de facturas de un día operativo (Ventas). */
  @Get()
  @Modulo('ventas')
  listar(@UsuarioActual() u: UsuarioSesion, @Query() q: ReporteDiaQueryDto) {
    return this.cobros.delDia(u.restauranteId, q.fecha);
  }

  @Get(':id')
  @Modulo('mesas', 'por_cobrar', 'ventas')
  obtener(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.cobros.obtener(u.restauranteId, id);
  }

  /** Corregir una factura de cualquier día, con su cobro adicional o devolución. */
  @Post(':id/corregir')
  @Modulo('por_cobrar', 'ventas')
  corregir(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: CorregirCobroDto) {
    return this.cobros.corregir(u.restauranteId, id, dto, u.id);
  }

  @Post(':id/anular')
  @Modulo('por_cobrar')
  anular(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: AnularDto) {
    return this.cobros.anular(u.restauranteId, id, dto.motivo, u.id);
  }
}
