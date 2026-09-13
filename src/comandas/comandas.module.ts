import { Module } from '@nestjs/common';
import { ComandasController, CocinaController } from './comandas.controller';
import { ComandasService } from './comandas.service';

@Module({
  controllers: [ComandasController, CocinaController],
  providers: [ComandasService],
  exports: [ComandasService],
})
export class ComandasModule {}
