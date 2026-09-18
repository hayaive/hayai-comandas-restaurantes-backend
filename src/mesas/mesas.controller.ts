import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { MesasService } from './mesas.service';
import { CrearMesaDto } from './dto/crear-mesa.dto';
import { ActualizarMesaDto } from './dto/actualizar-mesa.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';
import { Comun, Modulo } from '../comun/decoradores/modulo.decorator';

@Controller('mesas')
export class MesasController {
  constructor(private readonly mesas: MesasService) {}

  @Get()
  @Comun()
  listar(@UsuarioActual() u: UsuarioSesion, @Query('salonId') salonId?: string) {
    return this.mesas.listar(u.restauranteId, salonId);
  }

  @Get(':id')
  @Modulo('mesas')
  obtener(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.mesas.obtener(u.restauranteId, id);
  }

  @Post()
  @Modulo('mesas')
  crear(@UsuarioActual() u: UsuarioSesion, @Body() dto: CrearMesaDto) {
    return this.mesas.crear(u.restauranteId, dto);
  }

  @Patch(':id')
  @Modulo('mesas')
  actualizar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: ActualizarMesaDto) {
    return this.mesas.actualizar(u.restauranteId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Modulo('mesas')
  async eliminar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    await this.mesas.eliminar(u.restauranteId, id);
  }
}
