import { Module } from '@nestjs/common';
import { ComandasModule } from '../comandas/comandas.module';
import { ReservacionesController } from './reservaciones.controller';
import { ReservacionesPublicoController } from './reservaciones-publico.controller';
import { ReservacionesService } from './reservaciones.service';
import { ReservacionesPublicoService } from './reservaciones-publico.service';

@Module({
  imports: [ComandasModule],
  controllers: [ReservacionesController, ReservacionesPublicoController],
  providers: [ReservacionesService, ReservacionesPublicoService],
  exports: [ReservacionesService],
})
export class ReservacionesModule {}
