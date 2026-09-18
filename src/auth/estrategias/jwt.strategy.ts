import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { UsuarioSesion } from '../../comun/decoradores/usuario-actual.decorator';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET ?? 'dev-secret-cambiar',
    });
  }

  /**
   * ⚠️⚠️ ESTA CONSULTA A LA BASE EN CADA PETICIÓN ES LA SEGURIDAD, NO UN
   * DESPERDICIO. Si alguien la "optimiza" para no consultar la base (una
   * caché, o confiar en lo que trae el payload del JWT), la revocación y la
   * caducidad de los accesos temporales dejan de ser inmediatas: un acceso
   * revocado por el dueño, o uno que ya venció, seguiría entrando hasta que
   * caduque su token — hasta 12 h más. Lo mismo con `modulos`: quitarle una
   * pantalla a alguien surte efecto en su siguiente clic sólo porque se relee
   * aquí.
   *
   * La ventana de vigencia (`acceso_hasta IS NULL OR acceso_hasta > now()`)
   * es la que aplica la caducidad: vencer no escribe nada en la base (no hay
   * job), así que o se compara aquí o no se compara en ningún sitio.
   */
  async validate(payload: JwtPayload): Promise<UsuarioSesion> {
    const usuario = await this.prisma.usuario.findFirst({
      where: {
        id: payload.sub,
        restauranteId: payload.restauranteId,
        activo: true,
        OR: [{ accesoHasta: null }, { accesoHasta: { gt: new Date() } }],
      },
    });
    if (!usuario) {
      throw new UnauthorizedException('Sesión inválida');
    }
    return {
      id: usuario.id,
      restauranteId: usuario.restauranteId,
      rol: usuario.rol,
      nombre: usuario.nombre,
      usuario: usuario.usuario,
      modulos: usuario.modulos,
      accesoHasta: usuario.accesoHasta,
    };
  }
}
