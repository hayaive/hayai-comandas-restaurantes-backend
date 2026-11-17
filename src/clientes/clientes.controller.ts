import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ClientesService } from './clientes.service';
import { CrearClienteDto, ListarClientesQueryDto, ReasignarLineasDto, SentarClienteDto } from './dto/cliente.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';
import { Modulo } from '../comun/decoradores/modulo.decorator';

/**
 * Clientes: la unidad de cobro (una VISITA: nombre, mesa opcional, deuda).
 * `POST /clientes/:id/cobrar` vive en `ClienteCobroController` (módulo de comandas).
 */
@Controller('clientes')
export class ClientesController {
  constructor(private readonly clientes: ClientesService) {}

  @Post()
  @Modulo('mesero', 'mesas')
  crear(@UsuarioActual() u: UsuarioSesion, @Body() dto: CrearClienteDto) {
    return this.clientes.crear(u.restauranteId, u.id, dto);
  }

  @Get()
  @Modulo('mesero', 'mesas', 'por_cobrar')
  listar(@UsuarioActual() u: UsuarioSesion, @Query() q: ListarClientesQueryDto) {
    return this.clientes.listar(u.restauranteId, { mesaId: q.mesaId, sinMesa: q.sinMesa === 'true' });
  }

  // ⚠️ Antes de `:id`, o "deudas" se leería como un id.
  @Get('deudas')
  @Modulo('por_cobrar', 'mesas')
  deudas(@UsuarioActual() u: UsuarioSesion) {
    return this.clientes.deudas(u.restauranteId, false);
  }

  @Get(':id')
  @Modulo('mesero', 'mesas', 'por_cobrar')
  cuenta(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.clientes.cuenta(u.restauranteId, id);
  }

  /** Sentar (sin mesa) o mover (con mesa). */
  @Post(':id/sentar')
  @Modulo('mesas', 'mesero')
  sentar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: SentarClienteDto) {
    return this.clientes.sentar(u.restauranteId, u.id, id, dto.mesaId);
  }

  @Post(':id/liberar')
  @Modulo('mesas', 'mesero')
  liberar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.clientes.liberar(u.restauranteId, u.id, id);
  }

  @Post(':id/cerrar')
  @Modulo('mesas', 'por_cobrar')
  cerrar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.clientes.cerrar(u.restauranteId, u.id, id);
  }

  @Post(':id/reabrir')
  @Modulo('mesas', 'por_cobrar')
  reabrir(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.clientes.reabrir(u.restauranteId, u.id, id);
  }

  @Post(':id/reasignar')
  @Modulo('mesero', 'mesas', 'por_cobrar')
  reasignar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: ReasignarLineasDto) {
    return this.clientes.reasignar(u.restauranteId, u.id, id, dto);
  }
}
