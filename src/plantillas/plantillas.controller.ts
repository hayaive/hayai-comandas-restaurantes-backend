import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { PlantillasService } from './plantillas.service';
import { CrearPlantillaDto } from './dto/crear-plantilla.dto';
import { ActualizarPlantillaDto } from './dto/actualizar-plantilla.dto';
import { ClonarPlantillaDto } from './dto/clonar-plantilla.dto';
import {
  ActualizarPlantillaMesaDto,
  GuardarLayoutDto,
  PlantillaMesaItemDto,
} from './dto/plantilla-mesa-item.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';
import { Comun, Modulo } from '../comun/decoradores/modulo.decorator';

@Controller('salones/:salonId/plantillas')
export class SalonPlantillasController {
  constructor(private readonly plantillas: PlantillasService) {}

  @Get()
  @Comun()
  listar(@UsuarioActual() u: UsuarioSesion, @Param('salonId') salonId: string) {
    return this.plantillas.listarPorSalon(u.restauranteId, salonId);
  }

  @Post()
  @Modulo('mesas')
  crear(@UsuarioActual() u: UsuarioSesion, @Param('salonId') salonId: string, @Body() dto: CrearPlantillaDto) {
    return this.plantillas.crear(u.restauranteId, salonId, dto);
  }
}

@Controller('plantillas')
export class PlantillasController {
  constructor(private readonly plantillas: PlantillasService) {}

  @Get(':id')
  @Comun()
  obtener(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.plantillas.obtenerConMesas(u.restauranteId, id);
  }

  @Patch(':id')
  @Modulo('mesas')
  actualizar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: ActualizarPlantillaDto) {
    return this.plantillas.actualizar(u.restauranteId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Modulo('mesas')
  async eliminar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    await this.plantillas.eliminar(u.restauranteId, id);
  }

  @Post(':id/clonar')
  @Modulo('mesas')
  clonar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: ClonarPlantillaDto) {
    return this.plantillas.clonar(u.restauranteId, id, dto.nombre);
  }

  @Post(':id/activar')
  @Modulo('mesas')
  activar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.plantillas.activar(u.restauranteId, id);
  }

  @Put(':id/mesas')
  @Modulo('mesas')
  guardarLayout(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: GuardarLayoutDto) {
    return this.plantillas.guardarLayoutCompleto(u.restauranteId, id, dto.mesas);
  }

  @Post(':id/mesas')
  @Modulo('mesas')
  agregarMesa(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: PlantillaMesaItemDto) {
    return this.plantillas.agregarMesa(u.restauranteId, id, dto);
  }

  @Patch(':id/mesas/:mesaId')
  @Modulo('mesas')
  actualizarMesa(
    @UsuarioActual() u: UsuarioSesion,
    @Param('id') id: string,
    @Param('mesaId') mesaId: string,
    @Body() dto: ActualizarPlantillaMesaDto,
  ) {
    return this.plantillas.actualizarMesa(u.restauranteId, id, mesaId, dto);
  }

  @Delete(':id/mesas/:mesaId')
  @HttpCode(204)
  @Modulo('mesas')
  async quitarMesa(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Param('mesaId') mesaId: string) {
    await this.plantillas.quitarMesa(u.restauranteId, id, mesaId);
  }
}
