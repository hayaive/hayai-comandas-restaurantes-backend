import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { SalonesService } from './salones.service';
import { CrearSalonDto } from './dto/crear-salon.dto';
import { ActualizarSalonDto } from './dto/actualizar-salon.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';
import { Comun, Modulo } from '../comun/decoradores/modulo.decorator';

@Controller('salones')
export class SalonesController {
  constructor(private readonly salones: SalonesService) {}

  @Get()
  @Comun()
  listar(@UsuarioActual() u: UsuarioSesion) {
    return this.salones.listar(u.restauranteId);
  }

  @Get(':id')
  @Modulo('mesas')
  obtener(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.salones.obtener(u.restauranteId, id);
  }

  @Post()
  @Modulo('mesas')
  crear(@UsuarioActual() u: UsuarioSesion, @Body() dto: CrearSalonDto) {
    return this.salones.crear(u.restauranteId, dto);
  }

  @Patch(':id')
  @Modulo('mesas')
  actualizar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: ActualizarSalonDto) {
    return this.salones.actualizar(u.restauranteId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Modulo('mesas')
  async eliminar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    await this.salones.eliminar(u.restauranteId, id);
  }
}
