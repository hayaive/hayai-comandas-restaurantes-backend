import { Module } from '@nestjs/common';
import { ReservacionesController } from './reservaciones.controller';
import { ReservacionesPublicoController } from './reservaciones-publico.controller';
import { ReservacionesService } from './reservaciones.service';
import { ReservacionesPublicoService } from './reservaciones-publico.service';
import { ClientesModule } from '../clientes/clientes.module';

// Importa ClientesModule: sentar una reserva (o el check-in por QR) abre el
// cliente que ocupa la mesa. No depende de comandas: sentar no abre comanda.
@Module({
  imports: [ClientesModule],
  controllers: [ReservacionesController, ReservacionesPublicoController],
  providers: [ReservacionesService, ReservacionesPublicoService],
  exports: [ReservacionesService],
})
export class ReservacionesModule {}
