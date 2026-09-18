import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { CLAVE_ROLES } from '../decoradores/roles.decorator';
import { MODULOS_DE_ADMINISTRACION } from '../modulos';
import { RolesGuard } from './roles.guard';
import { accesoDeRuta, AccesoDeRuta } from './modulos.guard';

/**
 * LA RED DE `ModulosGuard`. Recorre TODAS las rutas que registra AppModule (no
 * una lista a mano: las que Nest descubre de verdad) y falla si alguna no
 * declara `@Publico`, `@Comun` o `@Modulo`. Sin esto, un endpoint nuevo nace
 * bloqueado para todos (el guard falla cerrado) y el fallo sólo se ve en
 * producción; con esto, se ve en `npm test`.
 *
 * Además fija dos listas CERRADAS que no pueden crecer sin que alguien lo
 * decida: lo público (sin sesión) y lo común (cualquier sesión, sin importar
 * las pantallas). Si esta prueba falla porque añadiste una ruta a una de esas
 * listas, no la "arregles" añadiéndola aquí sin más: es abrir un endpoint a
 * cualquier mesero temporal (o a internet). Repórtalo.
 *
 * No toca la base: se sustituye PrismaService y el módulo sólo se compila
 * (sin `init()`, así que ningún hook de arranque corre).
 */

interface Ruta {
  metodo: string;
  ruta: string;
  acceso: AccesoDeRuta;
  roles: string[] | undefined;
  conRolesGuard: boolean;
}

function unir(...partes: (string | undefined)[]): string {
  const ruta = partes
    .filter((p): p is string => !!p)
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${ruta}`;
}

async function descubrirRutas(): Promise<Ruta[]> {
  const modulo = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();

  const discovery = modulo.get(DiscoveryService);
  const scanner = new MetadataScanner();
  const reflector = new Reflector();
  const rutas: Ruta[] = [];

  for (const wrapper of discovery.getControllers()) {
    const clase = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
    if (!clase) continue;
    const prefijo = Reflect.getMetadata(PATH_METADATA, clase) as string | string[] | undefined;
    for (const nombre of scanner.getAllMethodNames(clase.prototype)) {
      const handler = (clase.prototype as Record<string, object>)[nombre];
      const metodoHttp = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (metodoHttp === undefined) continue;
      const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      const guards = [
        ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
        ...((Reflect.getMetadata(GUARDS_METADATA, clase) as unknown[]) ?? []),
      ];
      for (const p of Array.isArray(prefijo) ? prefijo : [prefijo]) {
        for (const s of Array.isArray(sub) ? sub : [sub]) {
          rutas.push({
            metodo: RequestMethod[metodoHttp],
            ruta: unir(p, s),
            acceso: accesoDeRuta(reflector, handler, clase),
            roles: reflector.getAllAndOverride<string[] | undefined>(CLAVE_ROLES, [handler as () => void, clase]),
            conRolesGuard: guards.includes(RolesGuard),
          });
        }
      }
    }
  }
  await modulo.close();
  return rutas.sort((a, b) => a.ruta.localeCompare(b.ruta) || a.metodo.localeCompare(b.metodo));
}

const clave = (r: Ruta) => `${r.metodo} ${r.ruta}`;

/** Lo que responde SIN sesión. */
const PUBLICAS = [
  'POST /auth/acceso',
  'POST /auth/acceso/consultar',
  'POST /auth/login',
  'POST /auth/pin',
  'GET /publico/r/:slug/disponibilidad',
  'POST /publico/r/:slug/reservaciones',
  'GET /publico/reserva/:codigoPublico',
  'POST /publico/reserva/:codigoPublico/checkin',
  'POST /publico/reserva/:codigoPublico/mesa',
];

/**
 * Lo que usa el shell en TODAS las pantallas. Acordado con el frontend
 * (CONTRACT.md §5.1). Las dos escrituras de tasa van además con
 * `@Roles('administrador', 'encargado')` — se comprueba abajo.
 */
const COMUNES = [
  'GET /auth/yo',
  'GET /mesas',
  'GET /plano',
  'GET /plantillas/:id',
  'DELETE /push/suscripciones',
  'GET /push/suscripciones',
  'PATCH /push/suscripciones/:id',
  'POST /push/probar',
  'POST /push/suscripciones',
  'GET /push/vapid',
  'GET /restaurante',
  'GET /salones',
  'GET /salones/:salonId/plantillas',
  'POST /tasa',
  'POST /tasa/actualizar',
  'GET /tasa/vigente',
];

describe('Cobertura de rutas por ModulosGuard', () => {
  let rutas: Ruta[];

  beforeAll(async () => {
    rutas = await descubrirRutas();
    if (process.env.IMPRIMIR_RUTAS === '1') {
      const lineas = rutas.map((r) => {
        const decl =
          r.acceso?.tipo === 'modulos'
            ? `@Modulo(${r.acceso.modulos.map((m) => `'${m}'`).join(', ')})`
            : r.acceso?.tipo === 'comun'
              ? '@Comun()'
              : r.acceso?.tipo === 'publico'
                ? '@Publico()'
                : 'SIN DECLARAR';
        const roles = r.roles?.length ? ` + @Roles(${r.roles.map((x) => `'${x}'`).join(', ')})` : '';
        return `| ${r.metodo} | ${r.ruta} | ${decl}${roles} |`;
      });
      console.log(lineas.join('\n'));
    }
  }, 30_000);

  it('descubre las rutas de verdad (si esto da 0, la prueba no está probando nada)', () => {
    expect(rutas.length).toBeGreaterThan(80);
    expect(rutas.map(clave)).toEqual(expect.arrayContaining(['POST /accesos', 'POST /auth/acceso', 'POST /comandas']));
  });

  it('TODA ruta declara @Publico, @Comun o @Modulo', () => {
    const sinDeclarar = rutas.filter((r) => r.acceso === null).map(clave);
    expect(sinDeclarar).toEqual([]);
  });

  it('ningún @Modulo va vacío (sería una ruta que sólo el administrador puede usar, por accidente)', () => {
    const vacios = rutas.filter((r) => r.acceso?.tipo === 'modulos' && r.acceso.modulos.length === 0).map(clave);
    expect(vacios).toEqual([]);
  });

  it('lo público es EXACTAMENTE la lista acordada', () => {
    const publicas = rutas.filter((r) => r.acceso?.tipo === 'publico').map(clave);
    expect(publicas.sort()).toEqual([...PUBLICAS].sort());
  });

  it('lo común es EXACTAMENTE la lista acordada con el frontend', () => {
    const comunes = rutas.filter((r) => r.acceso?.tipo === 'comun').map(clave);
    expect(comunes.sort()).toEqual([...COMUNES].sort());
  });

  it('toda escritura @Comun exige además un rol (@Roles + RolesGuard)', () => {
    const escriturasSinRol = rutas
      .filter((r) => r.acceso?.tipo === 'comun' && r.metodo !== 'GET' && !r.ruta.startsWith('/push/'))
      .filter((r) => !r.roles?.length || !r.conRolesGuard)
      .map(clave);
    expect(escriturasSinRol).toEqual([]);
  });

  it('lo que sólo pide pantallas de administración exige además @Roles("administrador") con RolesGuard', () => {
    const soloAdmin = rutas.filter(
      (r) => r.acceso?.tipo === 'modulos' && r.acceso.modulos.every((m) => MODULOS_DE_ADMINISTRACION.includes(m)),
    );
    expect(soloAdmin.length).toBeGreaterThan(0);
    const malProtegidas = soloAdmin
      .filter((r) => !(r.conRolesGuard && r.roles?.length === 1 && r.roles[0] === 'administrador'))
      .map(clave);
    expect(malProtegidas).toEqual([]);
  });

  it('ninguna ruta mezcla un módulo de administración con uno asignable (un no-admin pasaría por el asignable)', () => {
    const mezcladas = rutas
      .filter(
        (r) =>
          r.acceso?.tipo === 'modulos' &&
          r.acceso.modulos.some((m) => MODULOS_DE_ADMINISTRACION.includes(m)) &&
          r.acceso.modulos.some((m) => !MODULOS_DE_ADMINISTRACION.includes(m)),
      )
      .map(clave);
    expect(mezcladas).toEqual([]);
  });
});
