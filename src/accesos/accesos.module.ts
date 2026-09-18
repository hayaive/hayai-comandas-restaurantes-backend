import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { AccesoCanjeController, AccesosController } from './accesos.controller';
import { AccesosService } from './accesos.service';

/**
 * Accesos temporales (menú "Meseros"). Importa `AuthModule` para emitir la
 * sesión del canje con la MISMA función que el login, y
 * `NotificacionesModule` para el aviso `acceso_sospechoso`.
 */
@Module({
  imports: [AuthModule, NotificacionesModule],
  controllers: [AccesosController, AccesoCanjeController],
  providers: [AccesosService],
})
export class AccesosModule {}
