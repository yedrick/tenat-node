import { MemoryLogger } from '@tenancy-node/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('example fastify-memory', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('answers per tenant, serves the theme and keeps errors per tenant', async () => {
    const logger = new MemoryLogger();
    const { app, tenancy } = await buildApp({ logger });
    close = () => app.close();
    const who = await app.inject({ url: '/whoami', headers: { host: 'bolivar.localhost' } });
    expect(who.json()).toEqual({ tenant: 'bolivar', name: 'Club Bolívar' });
    expect((await app.inject({ url: '/whoami', headers: { host: 'localhost' } })).json()).toEqual({ tenant: null, name: 'central' });

    const css = await app.inject({ url: '/theme.css', headers: { host: 'tigre.localhost' } });
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.body).toContain('--color-primary: #FFD100');

    expect((await app.inject({ method: 'POST', url: '/pedidos', headers: { host: 'bolivar.localhost' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/boom', headers: { host: 'tigre.localhost' } })).statusCode).toBe(500);
    expect((await app.inject({ url: '/whoami', headers: { host: 'nadie.localhost' } })).statusCode).toBe(404);

    const errors = (await app.inject({ url: '/admin/errors', headers: { host: 'localhost' } })).json();
    expect(errors.recent.find((e: { tenantId: string | null }) => e.tenantId === 'tigre')).toMatchObject({ message: 'Algo falló en tigre' });
    await tenancy.events.flush(); // los listeners `async` corren después de la respuesta
    expect(logger.entries.some((e) => e.message === 'Pedido recibido' && e.fields.tenantId === 'bolivar')).toBe(true);
  });
});
