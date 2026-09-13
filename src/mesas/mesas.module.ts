import { Module } from '@nestjs/common';
import { MesasController } from './mesas.controller';
import { MesasService } from './mesas.service';

@Module({
  controllers: [MesasController],
  providers: [MesasService],
  exports: [MesasService],
})
export class MesasModule {}
