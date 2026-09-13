import { Controller, Get, Query } from '@nestjs/common';
import { PlanoService } from './plano.service';
import { UsuarioActual, UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';

@Controller('plano')
export class PlanoController {
  constructor(private readonly plano: PlanoService) {}

  @Get()
  obtener(
    @UsuarioActual() u: UsuarioSesion,
    @Query('salonId') salonId?: string,
    @Query('plantillaId') plantillaId?: string,
  ) {
    return this.plano.obtener(u.restauranteId, salonId, plantillaId);
  }
}
