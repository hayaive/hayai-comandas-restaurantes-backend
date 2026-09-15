import { Module } from '@nestjs/common';
import {
  CobrosController,
  ComandasController,
  CuentaMesaController,
  CuentasPorCobrarController,
  DespachoController,
} from './comandas.controller';
import { ComandasService } from './comandas.service';

@Module({
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
