import { Module } from '@nestjs/common';
import { NotificacionesController } from './notificaciones.controller';
import { NotificacionesService } from './notificaciones.service';
import { VapidConfigService } from './vapid.config';

/**
 * Exporta el servicio (lo consume `ComandasModule` para el aviso de "entró
 * una comanda") y `VapidConfigService` por si algún otro módulo necesita
 * saber si Web Push está configurado sin pasar por el service completo.
 */
@Module({
  controllers: [NotificacionesController],
  providers: [NotificacionesService, VapidConfigService],
  exports: [NotificacionesService, VapidConfigService],
})
export class NotificacionesModule {}
