import { Module } from '@nestjs/common';
import { ReportesController, TasaController } from './reportes.controller';
import { ReportesService } from './reportes.service';
import { TasaService } from './tasa.service';

@Module({
  controllers: [ReportesController, TasaController],
  providers: [ReportesService, TasaService],
  exports: [ReportesService, TasaService],
})
export class ReportesModule {}
