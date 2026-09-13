import { Module } from '@nestjs/common';
import { SalonesController } from './salones.controller';
import { SalonesService } from './salones.service';

@Module({
  controllers: [SalonesController],
  providers: [SalonesService],
  exports: [SalonesService],
})
export class SalonesModule {}
