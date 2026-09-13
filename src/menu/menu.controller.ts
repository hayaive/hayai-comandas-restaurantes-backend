import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CategoriasService } from './categorias.service';
import { ProductosService } from './productos.service';
import { CrearCategoriaDto, ActualizarCategoriaDto } from './dto/categoria.dto';
import { CrearProductoDto, ActualizarProductoDto, DisponibilidadProductoDto } from './dto/producto.dto';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';

@Controller('categorias')
export class CategoriasController {
  constructor(private readonly categorias: CategoriasService) {}

  @Get()
  listar(@UsuarioActual() u: UsuarioSesion) {
    return this.categorias.listar(u.restauranteId);
  }

  @Post()
  crear(@UsuarioActual() u: UsuarioSesion, @Body() dto: CrearCategoriaDto) {
    return this.categorias.crear(u.restauranteId, dto);
  }

  @Patch(':id')
  actualizar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: ActualizarCategoriaDto) {
    return this.categorias.actualizar(u.restauranteId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async eliminar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    await this.categorias.eliminar(u.restauranteId, id);
  }
}

@Controller('productos')
export class ProductosController {
  constructor(private readonly productos: ProductosService) {}

  @Get()
  listar(
    @UsuarioActual() u: UsuarioSesion,
    @Query('categoriaId') categoriaId?: string,
    @Query('soloDisponibles') soloDisponibles?: string,
  ) {
    return this.productos.listar(u.restauranteId, categoriaId, soloDisponibles === 'true');
  }

  @Get(':id')
  obtener(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    return this.productos.obtener(u.restauranteId, id);
  }

  @Post()
  crear(@UsuarioActual() u: UsuarioSesion, @Body() dto: CrearProductoDto) {
    return this.productos.crear(u.restauranteId, dto);
  }

  @Patch(':id')
  actualizar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string, @Body() dto: ActualizarProductoDto) {
    return this.productos.actualizar(u.restauranteId, id, dto);
  }

  @Patch(':id/disponibilidad')
  actualizarDisponibilidad(
    @UsuarioActual() u: UsuarioSesion,
    @Param('id') id: string,
    @Body() dto: DisponibilidadProductoDto,
  ) {
    return this.productos.actualizarDisponibilidad(u.restauranteId, id, dto.disponible);
  }

  @Delete(':id')
  @HttpCode(204)
  async eliminar(@UsuarioActual() u: UsuarioSesion, @Param('id') id: string) {
    await this.productos.eliminar(u.restauranteId, id);
  }
}
