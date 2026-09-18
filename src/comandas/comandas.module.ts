import { Module } from '@nestjs/common';
import {
  CobrosController,
  ComandasController,
  CuentaMesaController,
  CuentasPorCobrarController,
  DespachoController,
} from './comandas.controller';
import { ComandasService } from './comandas.service';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';

// Importa NotificacionesModule para avisar por push cuando entra una comanda
// nueva (fuera de la transacción, ver ComandasService.crearComanda). La
// dependencia va en este sentido nada más: NotificacionesModule no conoce
// ComandasModule.
@Module({
  imports: [NotificacionesModule],
  controllers: [
    ComandasController,
    DespachoController,
    CuentasPorCobrarController,
    CuentaMesaController,
    CobrosController,
  ],
  providers: [ComandasService],
  exports: [ComandasService],
})
export class ComandasModule {}
