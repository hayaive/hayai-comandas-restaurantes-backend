import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PgErrorFilter } from './pg-error.filter';

/**
 * Regresión del bug: `DELETE /plantillas/:id` sobre una plantilla con
 * comandas/reservaciones históricas caía en Postgres 23503 (FK RESTRICT),
 * pero como ninguna de esas dos FK tenía entrada en `MAPA_CONSTRAINTS`, el
 * usuario veía el mensaje genérico "El registro referenciado no existe" en
 * vez de saber que la plantilla tiene histórico.
 */
function mockHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res = { status };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

function fkError(constraintName: string, tabla: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `Foreign key constraint failed on the field: \`${constraintName} (index)\``,
    {
      code: 'P2003',
      clientVersion: 'test',
      meta: {
        message: `update or delete on table "plantilla" violates foreign key constraint "${constraintName}" on table "${tabla}"`,
      },
    },
  );
}

describe('PgErrorFilter — DELETE plantilla con histórico', () => {
  const filter = new PgErrorFilter();

  it('traduce la FK de comanda→plantilla a un 422 claro, no al genérico', () => {
    const { host, status, json } = mockHost();
    filter.catch(fkError('comanda_restaurante_id_plantilla_id_fkey', 'comanda'), host);
    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      statusCode: 422,
      message: 'No se puede eliminar: esta plantilla tiene comandas asociadas',
    });
  });

  it('traduce la FK de reservacion→plantilla a un 422 claro, no al genérico', () => {
    const { host, status, json } = mockHost();
    filter.catch(fkError('reservacion_restaurante_id_plantilla_id_fkey', 'reservacion'), host);
    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      statusCode: 422,
      message: 'No se puede eliminar: esta plantilla tiene reservaciones asociadas',
    });
  });

  it('una FK sin mapear específico sigue cayendo en el genérico (no revienta)', () => {
    const { host, status, json } = mockHost();
    filter.catch(fkError('alguna_fk_no_mapeada', 'otra_tabla'), host);
    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      statusCode: 422,
      message: 'El registro referenciado no existe',
    });
  });
});
