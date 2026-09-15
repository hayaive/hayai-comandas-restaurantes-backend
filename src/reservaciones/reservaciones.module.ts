import { Module } from '@nestjs/common';
import { ReservacionesController } from './reservaciones.controller';
import { ReservacionesPublicoController } from './reservaciones-publico.controller';
import { ReservacionesService } from './reservaciones.service';
import { ReservacionesPublicoService } from './reservaciones-publico.service';

// Ya no importa `ComandasModule`: sentar una reserva dejó de abrir comanda
// (ver `ReservacionesService.sentar`), así que este módulo no depende del de
// comandas. La dependencia inversa tampoco existe.
@Module({
  controllers: [ReservacionesController, ReservacionesPublicoController],
  providers: [ReservacionesService, ReservacionesPublicoService],
  exports: [ReservacionesService],
})
export class ReservacionesModule {}
