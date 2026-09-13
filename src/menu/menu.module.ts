import { Module } from '@nestjs/common';
import { CategoriasController, ProductosController } from './menu.controller';
import { CategoriasService } from './categorias.service';
import { ProductosService } from './productos.service';

@Module({
  controllers: [CategoriasController, ProductosController],
  providers: [CategoriasService, ProductosService],
  exports: [CategoriasService, ProductosService],
})
export class MenuModule {}
