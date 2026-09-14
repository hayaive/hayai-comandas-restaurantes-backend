import { rmSync } from 'node:fs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { UploadsModule } from './uploads.module';
import { CARPETA_UPLOADS_RAIZ } from './uploads.service';

/**
 * Integración liviana: levanta sólo `UploadsModule` (sin `AppModule`, sin
 * Prisma, sin JwtAuthGuard global) para poder probar el multipart real de
 * principio a fin sin necesitar una base de datos. La sesión/`restauranteId`
 * los resuelve el guard global de `AppModule`, fuera del alcance de este test.
 */
describe('UploadsController — POST /uploads/productos (sin DB)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [UploadsModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(CARPETA_UPLOADS_RAIZ, { recursive: true, force: true });
  });

  it('sube una imagen válida y devuelve una url bajo /uploads/productos/<uuid>.<ext>', async () => {
    const res = await request(app.getHttpServer())
      .post('/uploads/productos')
      .attach('archivo', Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0]), {
        filename: 'foto.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);

    expect(res.body.url).toMatch(
      /^\/uploads\/productos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/,
    );
  });

  it('rechaza un tipo de archivo no permitido con 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/uploads/productos')
      .attach('archivo', Buffer.from('no soy una imagen'), {
        filename: 'archivo.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);

    expect(res.body.message).toMatch(/JPG, PNG o WEBP/);
  });

  it('rechaza un archivo mayor a 5MB con 413', async () => {
    await request(app.getHttpServer())
      .post('/uploads/productos')
      .attach('archivo', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'grande.jpg',
        contentType: 'image/jpeg',
      })
      .expect(413);
  });

  it('nunca usa el nombre de archivo del cliente para escribir a disco (path traversal)', async () => {
    const res = await request(app.getHttpServer())
      .post('/uploads/productos')
      .attach('archivo', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: '../../../etc/passwd.png',
        contentType: 'image/png',
      })
      .expect(201);

    expect(res.body.url).not.toContain('..');
    expect(res.body.url).not.toContain('passwd');
    expect(res.body.url).toMatch(/^\/uploads\/productos\/[0-9a-f-]+\.png$/);
  });

  it('exige el archivo: sin el campo "archivo" responde 400', async () => {
    await request(app.getHttpServer()).post('/uploads/productos').expect(400);
  });
});
