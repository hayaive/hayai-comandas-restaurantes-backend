import { Module } from '@nestjs/common';
import { PlantillasController, SalonPlantillasController } from './plantillas.controller';
import { PlantillasService } from './plantillas.service';
import { PlanoController } from './plano.controller';
import { PlanoService } from './plano.service';

@Module({
  controllers: [PlantillasController, SalonPlantillasController, PlanoController],
  providers: [PlantillasService, PlanoService],
  exports: [PlantillasService, PlanoService],
})
export class PlantillasModule {}
