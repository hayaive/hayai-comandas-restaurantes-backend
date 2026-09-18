import { Controller, Get, Post, Body, Param, Patch, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReservacionesService } from './reservaciones.service';
import {
  ActualizarReservacionDto,
  CancelarReservacionDto,
  CrearReservacionDto,
  SentarReservacionDto,
} from './dto/reservacion.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';
import { EstadoReservacion } from '../generated/prisma/enums';
import { Modulo } from '../comun/decoradores/modulo.decorator';

@Controller('reservaciones')
export class ReservacionesController {
  constructor(private readonly reservaciones: ReservacionesService) {}

  @Get('huerfanas')
  @Modulo('reservaciones', 'mesas')
  huerfanas(@UsuarioActual() u: UsuarioSesion) {
    return this.reservaciones.huerfanas(u.restauranteId);
  }

  @Get()
  @Modulo('reservaciones')
  listar(
    @UsuarioActual() u: UsuarioSesion,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('estado') estado?: EstadoReservacion,
    @Query('mesaId') mesaId?: string,
  ) {
    return this.reservaciones.listar(u.restauranteId, { desde, hasta, estado, mesaId });
  }

  @Post()
  @Modulo('reservaciones')
  crear(@UsuarioActual() u: UsuarioSesion, @Body() dto: CrearReservacionDto) {
    return this.reservaciones.crear(u.restauranteId, u.id, dto);
  }

  @Get(':id')
  @Modulo('reservaciones', 'checkin', 'escanear')
  obtener(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.reservaciones.obtener(u.restauranteId, id);
  }

  @Patch(':id')
  @Modulo('reservaciones')
  actualizar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: ActualizarReservacionDto) {
    return this.reservaciones.actualizar(u.restauranteId, id, dto);
  }

  @Post(':id/confirmar')
  @Modulo('reservaciones')
  confirmar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.reservaciones.confirmar(u.restauranteId, id);
  }

  @Post(':id/cancelar')
  @Modulo('reservaciones')
  cancelar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: CancelarReservacionDto) {
    return this.reservaciones.cancelar(u.restauranteId, id, dto.motivo);
  }

  @Post(':id/no-show')
  @Modulo('reservaciones')
  noShow(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.reservaciones.noShow(u.restauranteId, id);
  }

  @Post(':id/sentar')
  @Modulo('reservaciones', 'checkin', 'escanear')
  sentar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: SentarReservacionDto) {
    return this.reservaciones.sentar(u.restauranteId, id, u.id, dto);
  }

  @Get(':id/qr')
  @Modulo('reservaciones')
  async qr(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Res() res: Response) {
    const buffer = await this.reservaciones.generarQr(u.restauranteId, id);
    res.set({ 'Content-Type': 'image/png', 'Content-Length': buffer.length });
    res.end(buffer);
  }
}
