import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MemoryLogger } from '@tenancy-node/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { startEmailService, type Mailer } from '../src/emails-service.js';

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')(
  'microservicio-emails end to end',
  () => {
    let pg: StartedPostgreSqlContainer;
    let rabbit: StartedTestContainer;
    let databaseUrl = '';
    let rabbitUrl = '';

    beforeAll(async () => {
      [pg, rabbit] = await Promise.all([
        new PostgreSqlContainer('postgres:16-alpine')
          .withUsername('admin')
          .withPassword('secret')
          .withDatabase('app')
          .start(),
        new GenericContainer('rabbitmq:4-alpine')
          .withExposedPorts(5672)
          .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
          .start(),
      ]);
      databaseUrl = `postgres://admin:secret@${pg.getHost()}:${pg.getPort()}/app`;
      rabbitUrl = `amqp://guest:guest@${rabbit.getHost()}:${rabbit.getMappedPort(5672)}`;
    }, 300_000);
    afterAll(async () => {
      await Promise.all([pg?.stop(), rabbit?.stop()]);
    });

    it('sends exactly one welcome email per tenant, even when the event is delivered twice or the mailer fails', async () => {
      const sent: Parameters<Mailer['send']>[0][] = [];
      const log: string[] = [];
      /** Tenants cuyo próximo envío falla (servidor SMTP caído). */
      const failNext = new Set<string>();
      const service = await startEmailService({
        rabbitUrl,
        mailer: {
          send: async (m) => {
            if (failNext.delete(m.tenant)) throw new Error('smtp down');
            sent.push(m);
          },
        },
        log: (l) => void log.push(l),
      });

      const app = createApp({ databaseUrl, rabbitUrl, logger: new MemoryLogger() });
      await app.database.install();
      await app.tenants.create({
        id: 'bolivar',
        name: 'Club Bolívar',
        data: { ownerEmail: 'admin@bolivar.bo' },
      });
      await app.tenants.create({ id: 'tigre', name: 'The Strongest' });
      // La creación no esperó a RabbitMQ: los eventos están en la outbox
      expect(await app.outbox.stats()).toMatchObject({ pending: 2 });
      expect(await app.outbox.relayOnce()).toMatchObject({ published: 2 });

      const until = async (check: () => boolean) => {
        const deadline = Date.now() + 15_000;
        while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
      };
      await until(() => sent.length === 2);
      expect(sent.map((m) => [m.tenant, m.to, m.subject]).sort()).toEqual([
        ['bolivar', 'admin@bolivar.bo', '¡Bienvenido a tuapp, Club Bolívar!'],
        ['tigre', 'admin@tigre.tuapp.com', '¡Bienvenido a tuapp, The Strongest!'],
      ]);

      // Se fuerza una segunda entrega del mismo evento (lo que puede pasar con "al menos una vez")
      await sql`UPDATE tenancy_event_outbox SET status = 'pending', available_at = now() WHERE tenant_id = 'bolivar'`.execute(
        app.centralDb(),
      );
      expect((await app.outbox.relayOnce()).published).toBe(1);
      await until(() => log.some((l) => l.includes('repetido')));
      expect(sent).toHaveLength(2);

      // El mailer falla en la primera entrega: el evento no queda marcado y la reentrega envía el correo
      failNext.add('wilster');
      await app.tenants.create({ id: 'wilster', name: 'Wilstermann' });
      expect((await app.outbox.relayOnce()).published).toBe(1);
      await until(() => sent.some((m) => m.tenant === 'wilster'));
      expect(log.some((l) => l.includes('smtp down'))).toBe(true);
      expect(sent.filter((m) => m.tenant === 'wilster')).toHaveLength(1);
      expect(log.filter((l) => l.includes('repetido'))).toHaveLength(1);

      await service.stop();
      await app.close();
    });
  },
);
