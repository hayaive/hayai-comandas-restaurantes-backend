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

  async validate(payload: JwtPayload): Promise<UsuarioSesion> {
    const usuario = await this.prisma.usuario.findFirst({
      where: { id: payload.sub, restauranteId: payload.restauranteId, activo: true },
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
    };
  }
}
