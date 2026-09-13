import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../comun/prisma/prisma.service';
import { Usuario } from '../generated/prisma/client';

function sanitizar(usuario: Usuario) {
  const { claveHash: _claveHash, pinHash: _pinHash, ...resto } = usuario;
  return resto;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * NOTA sobre multi-restaurante: `usuario` es único POR restaurante (citext),
   * no globalmente (ver CONTRACT.md §2.2). Con un solo restaurante activo hoy
   * (DECISIONES-DATOS.md §1) esta búsqueda por nombre de usuario a secas es
   * correcta; el día que exista un segundo restaurante, `POST /auth/login`
   * necesita un dato extra para desambiguar (slug del restaurante) — abrir
   * ese cambio de contrato junto con la activación de `prisma/sql/03_rls.sql`,
   * no antes.
   */
  async login(usuarioTexto: string, clave: string) {
    const usuario = await this.prisma.usuario.findFirst({
      where: { usuario: usuarioTexto, activo: true },
    });
    if (!usuario) throw new UnauthorizedException('Usuario o clave inválidos');

    const claveValida = await argon2.verify(usuario.claveHash, clave).catch(() => false);
    if (!claveValida) throw new UnauthorizedException('Usuario o clave inválidos');

    return this.emitirSesion(usuario);
  }

  async loginPin(usuarioTexto: string, pin: string) {
    const usuario = await this.prisma.usuario.findFirst({
      where: { usuario: usuarioTexto, activo: true },
    });
    if (!usuario || !usuario.pinHash) throw new UnauthorizedException('Usuario o PIN inválidos');

    const pinValido = await argon2.verify(usuario.pinHash, pin).catch(() => false);
    if (!pinValido) throw new UnauthorizedException('Usuario o PIN inválidos');

    return this.emitirSesion(usuario);
  }

  async yo(usuarioId: string, restauranteId: string) {
    const usuario = await this.prisma.usuario.findFirst({
      where: { id: usuarioId, restauranteId },
    });
    if (!usuario) throw new UnauthorizedException('Sesión inválida');
    return sanitizar(usuario);
  }

  private async emitirSesion(usuario: Usuario) {
    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: { ultimoAccesoEn: new Date() },
    });

    const token = await this.jwt.signAsync({
      sub: usuario.id,
      restauranteId: usuario.restauranteId,
      rol: usuario.rol,
    });

    return { token, usuario: sanitizar(usuario) };
  }
}
