import { BadRequestException, GoneException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { AccesosService } from './accesos.service';
import { AuthService, segundosDeJwtExpira } from '../auth/auth.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { PrismaService } from '../comun/prisma/prisma.service';
import { UsuarioSesion } from '../comun/decoradores/usuario-actual.decorator';

/**
 * Las reglas del canje y de la gestión que, si se rompen, abren la puerta o
 * se la cierran al mesero de verdad. La base está simulada: lo que aquí se
 * prueba es la LÓGICA del servicio (qué status, cuándo se avisa, qué se
 * guarda). Los CHECK y el trigger los verificó J.O.R.B.I contra Postgres real.
 */

const RESTAURANTE = { id: '00000000-0000-7000-8000-000000000001', nombre: 'Casa', logoUrl: null, slug: 'casa' };
const TOKEN = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

function usuarioTemporal(extra: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-7000-8000-0000000000aa',
    restauranteId: RESTAURANTE.id,
    nombre: 'Pedro',
    usuario: 'acceso-ABCDEFGH',
    claveHash: null,
    pinHash: null,
    rol: 'mesero',
    modulos: ['mesero'],
    accesoHasta: new Date(Date.now() + 3_600_000),
    activo: true,
    ultimoAccesoEn: null,
    creadoEn: new Date(),
    actualizadoEn: new Date(),
    ...extra,
  };
}

function montar(opciones: { invitacion?: unknown; fallosTrasIntento?: number } = {}) {
  const prisma = {
    restaurante: {
      findFirst: jest.fn().mockResolvedValue(RESTAURANTE),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ slug: RESTAURANTE.slug }),
    },
    invitacionAcceso: {
      findFirst: jest.fn().mockResolvedValue(opciones.invitacion ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    usuario: {
      findFirst: jest.fn().mockResolvedValue({ id: 'u', restaurante: { slug: RESTAURANTE.slug } }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
    },
    suscripcionPush: { deleteMany: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ fallos_consecutivos: opciones.fallosTrasIntento ?? 1 }]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
  const auth = { emitirSesion: jest.fn().mockResolvedValue({ token: 'jwt', usuario: {} }) };
  const notificaciones = { notificarAccesoSospechoso: jest.fn().mockResolvedValue(undefined) };
  const servicio = new AccesosService(
    prisma as unknown as PrismaService,
    auth as unknown as AuthService,
    notificaciones as unknown as NotificacionesService,
  );
  return { servicio, prisma, auth, notificaciones };
}

async function invitacionCon(codigo: string, extraUsuario: Record<string, unknown> = {}, fallos = 0) {
  return {
    restauranteId: RESTAURANTE.id,
    usuarioId: '00000000-0000-7000-8000-0000000000aa',
    enlaceHash: sha(TOKEN),
    codigoHash: await argon2.hash(codigo, { type: argon2.argon2id }),
    fallosConsecutivos: fallos,
    usuario: usuarioTemporal(extraUsuario),
  };
}

describe('AccesosService — canje del enlace', () => {
  it('404 si el slug no es de un restaurante activo', async () => {
    const { servicio, prisma } = montar();
    prisma.restaurante.findFirst.mockResolvedValue(null);
    await expect(servicio.consultar({ restaurante: 'otro', token: TOKEN })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 (no 400) si el token no tiene forma de token: para el mesero es "este enlace no sirve"', async () => {
    const { servicio, prisma } = montar();
    await expect(servicio.consultar({ restaurante: 'casa', token: 'abc' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.invitacionAcceso.findFirst).not.toHaveBeenCalled();
  });

  it('busca por SHA-256 del token, dentro del restaurante del slug y sólo entre accesos TEMPORALES', async () => {
    const { servicio, prisma } = montar({ invitacion: await invitacionCon('1234') });
    await servicio.consultar({ restaurante: 'casa', token: TOKEN.toLowerCase() });
    expect(prisma.invitacionAcceso.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          enlaceHash: sha(TOKEN),
          restauranteId: RESTAURANTE.id,
          usuario: { accesoHasta: { not: null } },
        },
      }),
    );
  });

  it('410 si el acceso ya venció', async () => {
    const { servicio } = montar({ invitacion: await invitacionCon('1234', { accesoHasta: new Date(Date.now() - 1000) }) });
    await expect(servicio.consultar({ restaurante: 'casa', token: TOKEN })).rejects.toBeInstanceOf(GoneException);
  });

  it('consultar devuelve el saludo y NO toca contadores', async () => {
    const { servicio, prisma } = montar({ invitacion: await invitacionCon('1234') });
    const r = await servicio.consultar({ restaurante: 'casa', token: TOKEN });
    expect(r).toEqual({
      restaurante: { nombre: 'Casa', logoUrl: null },
      nombre: 'Pedro',
      accesoHasta: expect.any(Date),
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.invitacionAcceso.updateMany).not.toHaveBeenCalled();
  });

  it('código incorrecto: 401 y el contador sube (atómico, en la base)', async () => {
    const { servicio, prisma, notificaciones } = montar({ invitacion: await invitacionCon('1234'), fallosTrasIntento: 3 });
    await expect(servicio.canjear({ restaurante: 'casa', token: TOKEN, codigo: '9999' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(notificaciones.notificarAccesoSospechoso).not.toHaveBeenCalled();
  });

  it('avisa al dueño EXACTAMENTE al llegar a 10 fallos, no en el 11', async () => {
    const a10 = montar({ invitacion: await invitacionCon('1234'), fallosTrasIntento: 10 });
    await expect(a10.servicio.canjear({ restaurante: 'casa', token: TOKEN, codigo: '0000' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(a10.notificaciones.notificarAccesoSospechoso).toHaveBeenCalledWith(RESTAURANTE.id, 'Pedro', expect.any(String));

    const a11 = montar({ invitacion: await invitacionCon('1234'), fallosTrasIntento: 11 });
    await expect(a11.servicio.canjear({ restaurante: 'casa', token: TOKEN, codigo: '0000' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(a11.notificaciones.notificarAccesoSospechoso).not.toHaveBeenCalled();
  });

  it('nunca bloquea: con 500 fallos previos, el código bueno entra igual', async () => {
    const { servicio, auth } = montar({ invitacion: await invitacionCon('1234', {}, 500) });
    await expect(servicio.canjear({ restaurante: 'casa', token: TOKEN, codigo: '1234' })).resolves.toEqual({
      token: 'jwt',
      usuario: {},
    });
    expect(auth.emitirSesion).toHaveBeenCalled();
  });

  it('código correcto: pone los fallos a 0 y emite la sesión con la misma función que el login', async () => {
    const { servicio, prisma, auth } = montar({ invitacion: await invitacionCon('4321', {}, 4) });
    await servicio.canjear({ restaurante: 'casa', token: TOKEN, codigo: '4321' });
    expect(prisma.invitacionAcceso.updateMany).toHaveBeenCalledWith({
      where: { restauranteId: RESTAURANTE.id, usuarioId: '00000000-0000-7000-8000-0000000000aa' },
      data: { fallosConsecutivos: 0 },
    });
    expect(auth.emitirSesion).toHaveBeenCalledWith(expect.objectContaining({ nombre: 'Pedro' }));
  });
});

describe('AccesosService — gestión', () => {
  const sesion = { id: 'admin', restauranteId: RESTAURANTE.id } as UsuarioSesion;

  it('crear: token base32 de 32 caracteres en el FRAGMENTO, código de 4 dígitos, y sólo se guardan hashes', async () => {
    const { servicio, prisma } = montar();
    const fin = new Date(Date.now() + 86_400_000);
    prisma.$queryRaw.mockResolvedValue([{ fin }]);
    prisma.usuario.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({ ...data, creadoEn: new Date() }));

    const r = await servicio.crear(sesion, { nombre: 'Pedro', duracion: 'hoy', modulos: ['mesero'] });

    const token = r.enlace.split('#')[1];
    expect(r.enlace).toMatch(/\/acceso\/casa#[0-9A-HJKMNP-TV-Z]{32}$/);
    expect(r.codigo).toMatch(/^\d{4}$/);
    expect(r.acceso).toEqual(
      expect.objectContaining({ nombre: 'Pedro', modulos: ['mesero'], accesoHasta: fin }),
    );

    const datosUsuario = prisma.usuario.create.mock.calls[0][0].data;
    expect(datosUsuario).toEqual(
      expect.objectContaining({ rol: 'mesero', claveHash: null, pinHash: null, accesoHasta: fin }),
    );
    expect(datosUsuario.usuario).toMatch(/^acceso-[0-9A-HJKMNP-TV-Z]{8}$/);

    const datosInvitacion = prisma.invitacionAcceso.create.mock.calls[0][0].data;
    expect(datosInvitacion.enlaceHash).toBe(sha(token));
    expect(datosInvitacion.codigoHash.startsWith('$argon2id$')).toBe(true);
    expect(await argon2.verify(datosInvitacion.codigoHash, r.codigo)).toBe(true);
    expect(datosInvitacion.otorgadaPorId).toBe('admin');
    expect(JSON.stringify(datosInvitacion)).not.toContain(token);
  });

  it('regenerar sin cuerpo cambia enlace y código, y pone los fallos a 0', async () => {
    const { servicio, prisma } = montar();
    const r = await servicio.regenerar(sesion, 'u', {});
    expect(r.enlace).toBeDefined();
    expect(r.codigo).toBeDefined();
    expect(prisma.invitacionAcceso.updateMany.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ fallosConsecutivos: 0, enlaceHash: expect.any(String), codigoHash: expect.any(String) }),
    );
  });

  it('regenerar { codigo: true } cambia SÓLO el código: el mesero conserva su enlace', async () => {
    const { servicio, prisma } = montar();
    const r = await servicio.regenerar(sesion, 'u', { codigo: true });
    expect(r).toEqual({ codigo: expect.stringMatching(/^\d{4}$/) });
    expect(prisma.invitacionAcceso.updateMany.mock.calls[0][0].data.enlaceHash).toBeUndefined();
  });

  it('regenerar { enlace: false, codigo: false } es un 400', async () => {
    const { servicio } = montar();
    await expect(servicio.regenerar(sesion, 'u', { enlace: false, codigo: false })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('regenerar sobre un acceso que no está vivo es 404', async () => {
    const { servicio, prisma } = montar();
    prisma.usuario.findFirst.mockResolvedValue(null);
    await expect(servicio.regenerar(sesion, 'u', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.invitacionAcceso.updateMany).not.toHaveBeenCalled();
  });

  it('revocar: acceso_hasta = ahora, borra la credencial y sus aparatos, y NO borra al usuario', async () => {
    const { servicio, prisma } = montar();
    await servicio.eliminar(RESTAURANTE.id, 'u');
    expect(prisma.usuario.updateMany.mock.calls[0][0].data).toEqual({ accesoHasta: expect.any(Date) });
    expect(prisma.invitacionAcceso.deleteMany).toHaveBeenCalledWith({ where: { restauranteId: RESTAURANTE.id, usuarioId: 'u' } });
    expect(prisma.suscripcionPush.deleteMany).toHaveBeenCalledWith({ where: { restauranteId: RESTAURANTE.id, usuarioId: 'u' } });
  });

  it('revocar algo que no está vivo es 404 (y no borra nada)', async () => {
    const { servicio, prisma } = montar();
    prisma.usuario.updateMany.mockResolvedValue({ count: 0 });
    await expect(servicio.eliminar(RESTAURANTE.id, 'u')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.invitacionAcceso.deleteMany).not.toHaveBeenCalled();
  });
});

describe('segundosDeJwtExpira', () => {
  it.each([
    [undefined, 43_200],
    ['12h', 43_200],
    ['30m', 1_800],
    ['3600', 3_600],
    ['1d', 86_400],
    ['basura', 43_200],
  ])('%s → %i s', (valor, esperado) => {
    expect(segundosDeJwtExpira(valor)).toBe(esperado);
  });
});
