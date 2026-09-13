import { Module } from '@nestjs/common';
import { ReportesController, TasaController } from './reportes.controller';
import { ReportesService } from './reportes.service';
import { TasaService } from './tasa.service';
import { TasaSchedulerService } from './tasa-scheduler.service';

@Module({
  controllers: [ReportesController, TasaController],
  providers: [ReportesService, TasaService, TasaSchedulerService],
  exports: [ReportesService, TasaService],
})
export class ReportesModule {}
