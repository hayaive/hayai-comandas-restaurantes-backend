import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Cliente Prisma de la aplicación.
 *
 * Prisma 7 con el generador "prisma-client" no acepta `url` en el bloque
 * `datasource` del schema (ver prisma7.config.ts): en runtime hay que pasar
 * SIEMPRE un driver adapter. Nos conectamos con `APP_DATABASE_URL`, no con
 * `DATABASE_URL` (esa es del rol dueño de las tablas, sólo para migraciones):
 * es la preparación para el día que se active `prisma/sql/03_rls.sql` con un
 * rol de aplicación sin BYPASSRLS (ver docs/DECISIONES-DATOS.md §1).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('Falta APP_DATABASE_URL (o DATABASE_URL) en el entorno.');
    }
    const adapter = new PrismaPg({ connectionString });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Conectado a PostgreSQL');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
