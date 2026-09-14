import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { ComunModule } from './comun/comun.module';
import { JwtAuthGuard } from './comun/guards/jwt-auth.guard';
import { AuthModule } from './auth/auth.module';
import { SalonesModule } from './salones/salones.module';
import { MesasModule } from './mesas/mesas.module';
import { PlantillasModule } from './plantillas/plantillas.module';
import { MenuModule } from './menu/menu.module';
import { ComandasModule } from './comandas/comandas.module';
import { ReservacionesModule } from './reservaciones/reservaciones.module';
import { ReportesModule } from './reportes/reportes.module';
import { UploadsModule } from './uploads/uploads.module';

@Module({
  imports: [
    ComunModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    AuthModule,
    SalonesModule,
    MesasModule,
    PlantillasModule,
    MenuModule,
    ComandasModule,
    ReservacionesModule,
    ReportesModule,
    UploadsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
