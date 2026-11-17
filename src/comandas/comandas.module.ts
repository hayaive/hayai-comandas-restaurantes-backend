import { Module } from '@nestjs/common';
import {
  ClienteCobroController,
  CobrosController,
  ComandasController,
  CuentaMesaController,
  CuentasPorCobrarController,
  DespachoController,
} from './comandas.controller';
import { ComandasService } from './comandas.service';
import { CobrosService } from './cobros.service';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { ClientesModule } from '../clientes/clientes.module';

// Importa NotificacionesModule para avisar por push cuando entra una comanda
// nueva (fuera de la transacción, ver ComandasService.crearComanda). La
// dependencia va en este sentido nada más: NotificacionesModule no conoce
// ComandasModule. ClientesModule no conoce a este: la cuenta y el asiento del
// cliente no dependen de comandas ni de cobros.
@Module({
  imports: [NotificacionesModule, ClientesModule],
  controllers: [
    ComandasController,
    DespachoController,
    CuentasPorCobrarController,
    CuentaMesaController,
    ClienteCobroController,
    CobrosController,
  ],
  providers: [ComandasService, CobrosService],
  exports: [ComandasService, CobrosService],
})
export class ComandasModule {}
