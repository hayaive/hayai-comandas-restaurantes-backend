import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService, sanitizar } from './auth.service';
import { PrismaService } from '../comun/prisma/prisma.service';
import { TODOS_LOS_MODULOS } from '../comun/modulos';
import { Usuario } from '../generated/prisma/client';

/**
 * Lo que cambia en auth con los accesos temporales: nunca entran por
 * login/PIN, su JWT no sobrevive al acceso, y toda respuesta con un usuario
 * lleva sus módulos EFECTIVOS y ningún secreto.
 */
function montar() {
  const prisma = {
    usuario: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('jwt') };
  const servicio = new AuthService(prisma as unknown as PrismaService, jwt as unknown as JwtService);
  return { servicio, prisma, jwt };
}

function usuario(extra: Partial<Usuario> = {}): Usuario {
  return {
    id: 'u',
    restauranteId: 'r',
    nombre: 'Ana',
    usuario: 'ana',
    claveHash: '$argon2id$x',
    pinHash: '$argon2id$y',
    rol: 'mesero',
    modulos: ['mesero'],
    accesoHasta: null,
    activo: true,
    ultimoAccesoEn: null,
    creadoEn: new Date(),
    actualizadoEn: new Date(),
    ...extra,
  };
}

describe('AuthService', () => {
  it('login y PIN sólo buscan personal PERMANENTE (accesoHasta: null)', async () => {
    const { servicio, prisma } = montar();
    await expect(servicio.login('ana', 'x')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(servicio.loginPin('ana', '1234')).rejects.toBeInstanceOf(UnauthorizedException);
    for (const [args] of prisma.usuario.findFirst.mock.calls) {
      expect(args.where).toEqual(expect.objectContaining({ accesoHasta: null, activo: true }));
    }
  });

  it('login con un usuario sin clave responde 401 (no revienta en argon2)', async () => {
    const { servicio, prisma } = montar();
    prisma.usuario.findFirst.mockResolvedValue(usuario({ claveHash: null }));
    await expect(servicio.login('ana', 'x')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('personal permanente: JWT con la expiración por defecto del módulo', async () => {
    const { servicio, jwt } = montar();
    await servicio.emitirSesion(usuario());
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'u', restauranteId: 'r', rol: 'mesero' });
  });

  it('acceso temporal: el JWT dura lo que le queda de acceso si es menos de 12 h', async () => {
    const { servicio, jwt } = montar();
    await servicio.emitirSesion(usuario({ accesoHasta: new Date(Date.now() + 3_600_000), claveHash: null, pinHash: null }));
    const opciones = jwt.signAsync.mock.calls[0][1];
    expect(opciones.expiresIn).toBeGreaterThan(3_590);
    expect(opciones.expiresIn).toBeLessThanOrEqual(3_600);
  });

  it('acceso temporal de un mes: el JWT sigue topado en 12 h', async () => {
    const { servicio, jwt } = montar();
    await servicio.emitirSesion(usuario({ accesoHasta: new Date(Date.now() + 30 * 86_400_000), claveHash: null, pinHash: null }));
    expect(jwt.signAsync.mock.calls[0][1].expiresIn).toBe(12 * 3600);
  });

  it('sanitizar: sin hashes, y con los módulos EFECTIVOS', () => {
    const limpio = sanitizar(usuario());
    expect(limpio).not.toHaveProperty('claveHash');
    expect(limpio).not.toHaveProperty('pinHash');
    expect(limpio.modulos).toEqual(['mesero']);
    expect(sanitizar(usuario({ rol: 'administrador', modulos: [] })).modulos).toEqual([...TODOS_LOS_MODULOS]);
  });
});
