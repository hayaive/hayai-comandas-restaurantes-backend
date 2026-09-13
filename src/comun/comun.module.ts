import { Global, Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { DiaOperativoService } from './dia-operativo/dia-operativo.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [DiaOperativoService],
  exports: [PrismaModule, DiaOperativoService],
})
export class ComunModule {}
