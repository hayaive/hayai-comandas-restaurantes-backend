import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ComandasService } from './comandas.service';
import {
  AgregarItemsDto,
  AnularDto,
  CambiarEstadoItemDto,
  CancelarItemDto,
  ActualizarItemDto,
  CobrarDto,
  CrearComandaDto,
  EnviarRondaDto,
  MoverComandaDto,
} from './dto/comanda.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';

@Controller('comandas')
export class ComandasController {
  constructor(private readonly comandas: ComandasService) {}

  @Get('activas')
  activas(@UsuarioActual() u: UsuarioSesion) {
    return this.comandas.listarActivas(u.restauranteId);
  }

  @Post()
  abrir(@UsuarioActual() u: UsuarioSesion, @Body() dto: CrearComandaDto) {
    return this.comandas.abrirComanda(u.restauranteId, u.id, dto);
  }

  @Get(':id')
  obtener(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.comandas.obtenerConDetalle(u.restauranteId, id);
  }

  @Post(':id/items')
  agregarItems(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: AgregarItemsDto) {
    return this.comandas.agregarItems(u.restauranteId, id, dto);
  }

  @Patch(':id/items/:itemId')
  actualizarItem(
    @UsuarioActual() u: UsuarioSesion,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: ActualizarItemDto,
  ) {
    return this.comandas.actualizarItem(u.restauranteId, id, itemId, dto);
  }

  @Delete(':id/items/:itemId')
  @HttpCode(204)
  async cancelarItem(
    @UsuarioActual() u: UsuarioSesion,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: CancelarItemDto,
  ) {
    await this.comandas.cancelarItem(u.restauranteId, id, itemId, dto.motivo, u.id);
  }

  @Post(':id/enviar')
  enviar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: EnviarRondaDto) {
    return this.comandas.enviarRonda(u.restauranteId, id, dto.ronda);
  }

  @Patch(':id/items/:itemId/estado')
  cambiarEstadoItem(
    @UsuarioActual() u: UsuarioSesion,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: CambiarEstadoItemDto,
  ) {
    return this.comandas.cambiarEstadoItem(u.restauranteId, id, itemId, dto.estado);
  }

  @Post(':id/mover')
  mover(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: MoverComandaDto) {
    return this.comandas.moverComanda(u.restauranteId, id, dto.mesaIdDestino);
  }

  @Post(':id/cuenta')
  pedirCuenta(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.comandas.pedirCuenta(u.restauranteId, id);
  }

  @Post(':id/cobrar')
  cobrar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: CobrarDto) {
    return this.comandas.cobrar(u.restauranteId, id, dto, u.id);
  }

  @Post(':id/anular')
  anular(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: AnularDto) {
    return this.comandas.anular(u.restauranteId, id, dto.motivo, u.id);
  }
}

@Controller('cocina')
export class CocinaController {
  constructor(private readonly comandas: ComandasService) {}

  @Get('cola')
  cola(@UsuarioActual() u: UsuarioSesion, @Query('destino') destino: 'cocina' | 'barra') {
    return this.comandas.colaCocina(u.restauranteId, destino);
  }
}
