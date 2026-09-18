import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../comun/prisma/prisma.service';
import { modulosEfectivos } from '../comun/modulos';
import { Usuario } from '../generated/prisma/client';

/**
 * Lo que sale de un usuario por la API. Quita los secretos por LISTA NEGRA
 * (por eso la credencial de los accesos temporales vive en otra tabla,
 * `invitacion_acceso`, que no pasa nunca por aquí) y sustituye `modulos` por
 * los EFECTIVOS: el frontend pinta el menú con esto, y tiene que coincidir con
 * lo que deja pasar `ModulosGuard`.
 */
export function sanitizar(usuario: Usuario) {
  const { claveHash: _claveHash, pinHash: _pinHash, ...resto } = usuario;
  return { ...resto, modulos: modulosEfectivos(usuario) };
}

/** 12 h: el mismo default que `JwtModule.register` en `auth.module.ts`. */
const JWT_EXPIRA_POR_DEFECTO_S = 12 * 60 * 60;

/**
 * `JWT_EXPIRA` en segundos. Acepta lo que acepta `jsonwebtoken` en la
 * práctica de este proyecto: un número (segundos) o `<n>s|m|h|d`. Si no se
 * entiende, 12 h — el tope nunca puede quedar indefinido, porque es contra lo
 * que se compara la vigencia de un acceso temporal.
 */
export function segundosDeJwtExpira(valor: string | undefined): number {
  if (!valor) return JWT_EXPIRA_POR_DEFECTO_S;
  const texto = valor.trim();
  if (/^\d+$/.test(texto)) return Number(texto);
  const m = texto.match(/^(\d+)\s*([smhd])$/i);
  if (!m) return JWT_EXPIRA_POR_DEFECTO_S;
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * factor;
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
   *
   * `accesoHasta: null`: un acceso temporal NUNCA entra por aquí, sólo por su
   * enlace + código (`POST /auth/acceso`). No tiene clave (CHECK
   * `usuario_credenciales_coherentes`), pero el filtro no depende de eso.
   */
  async login(usuarioTexto: string, clave: string) {
    const usuario = await this.prisma.usuario.findFirst({
      where: { usuario: usuarioTexto, activo: true, accesoHasta: null },
    });
    if (!usuario || !usuario.claveHash) throw new UnauthorizedException('Usuario o clave inválidos');

    const claveValida = await argon2.verify(usuario.claveHash, clave).catch(() => false);
    if (!claveValida) throw new UnauthorizedException('Usuario o clave inválidos');

    return this.emitirSesion(usuario);
  }

  /**
   * `accesoHasta: null`, igual que `login()`. Aquí importa más: esta es la
   * pantalla pública donde se prueban códigos cortos SIN enlace, justo lo que
   * el dueño descartó para los accesos temporales al aceptar 4 dígitos sin
   * bloqueo.
   */
  async loginPin(usuarioTexto: string, pin: string) {
    const usuario = await this.prisma.usuario.findFirst({
      where: { usuario: usuarioTexto, activo: true, accesoHasta: null },
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

  /**
   * Emite el JWT. Pública porque también la usa el canje del enlace de un
   * acceso temporal (`AccesosService.canjear`): una sola forma de emitir
   * sesión, una sola forma de la respuesta.
   *
   * Personal permanente: `JWT_EXPIRA` (12 h), como siempre.
   * Acceso temporal: el MENOR entre `JWT_EXPIRA` y lo que le queda de acceso.
   * No es la barrera (esa es `JwtStrategy.validate`, que relee la base en cada
   * petición); es para que el token no sobreviva a lo que representa y el
   * frontend vea un 401 limpio al vencer.
   */
  async emitirSesion(usuario: Usuario) {
    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: { ultimoAccesoEn: new Date() },
    });

    const payload = {
      sub: usuario.id,
      restauranteId: usuario.restauranteId,
      rol: usuario.rol,
    };

    let token: string;
    if (usuario.accesoHasta) {
      const restante = Math.floor((usuario.accesoHasta.getTime() - Date.now()) / 1000);
      const expiresIn = Math.max(1, Math.min(segundosDeJwtExpira(process.env.JWT_EXPIRA), restante));
      token = await this.jwt.signAsync(payload, { expiresIn });
    } else {
      token = await this.jwt.signAsync(payload);
    }

    return { token, usuario: sanitizar(usuario) };
  }
}
