import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTenancy, type EventEnvelope } from '@tenancy-node/core';
import { serveAdmin } from '@tenancy-node/admin-api';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { MemoryLogger } from '@tenancy-node/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminUsers } from '../src/auth/users.js';

const PASSWORD = 'contraseña-muy-segura-123';

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')(
  'Admin API: plans and leads (PostgreSQL)',
  () => {
    let container: StartedPostgreSqlContainer;
    let tenancy: ReturnType<typeof make>;
    let admin: Awaited<ReturnType<typeof serveAdmin>>;
    let base = '';
    const leadEvents: EventEnvelope[] = [];

    const make = (url: string) =>
      createTenancy({
        centralDomains: ['tuapp.com'],
        logger: new MemoryLogger(),
        features: { agenda: 'Agenda', caja: 'Caja', reportes: 'Reportes' },
        plans: {
          basico: {
            label: 'Básico',
            price: { currency: 'BOB', monthly: 150 },
            features: ['agenda', 'caja'],
            limits: { usuarios: 3 },
          },
          pro: { label: 'Profesional', features: '*', limits: { usuarios: 10 } },
        },
        defaultPlan: 'basico',
        theme: { fonts: [{ family: 'Inter' }, { family: 'Georgia', source: 'system' }] },
        billing: {
          providers: [
            {
              name: 'qr',
              createCheckout: async ({ invoice }) => ({
                providerRef: `qr_${invoice.id}`,
                qr: 'QR',
              }),
              parseWebhook: async ({ headers, body }) => {
                if (headers['x-firma'] !== 'ok') throw new Error('bad signature');
                const { ref } = JSON.parse(body) as { ref: string };
                return { type: 'paid', providerRef: ref, reference: 'BNB-1' };
              },
            },
          ],
        },
        plugins: [database({ driver: postgres(), central: { url } })],
      });

    const call = async (
      method: string,
      path: string,
      options: { body?: unknown; headers?: Record<string, string> } = {},
    ) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };

    const login = async (email: string) => {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      const body = (await res.json()) as { csrfToken: string };
      const cookie = String(res.headers.get('set-cookie')).split(';')[0]!;
      return { cookie, 'x-csrf-token': body.csrfToken };
    };

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      tenancy = make(container.getConnectionUri());
      await tenancy.database.install();
      tenancy.events.on('lead.created', (e) => void leadEvents.push(e), { mode: 'sync' });
      admin = await serveAdmin(tenancy, {
        port: 0,
        sessionSecret: 'x'.repeat(40),
        secureCookies: false,
        leads: { rateLimit: { max: 3, windowMs: 60_000 }, extraFields: ['origen'] },
      });
      base = admin.url;
      const users = new AdminUsers(tenancy.database.central());
      await users.create({
        email: 'admin@tuapp.com',
        name: 'Admin',
        password: PASSWORD,
        role: 'admin',
      });
      await users.create({
        email: 'soporte@tuapp.com',
        name: 'Soporte',
        password: PASSWORD,
        role: 'support',
      });
      await tenancy.tenants.create({ id: 'clinica-a', plan: 'basico' });
      await tenancy.tenants.create({ id: 'clinica-b' });
      await tenancy.tenants.create({ id: 'clinica-c', plan: 'pro' });
    }, 300_000);
    afterAll(async () => {
      await admin?.close();
      await tenancy?.close();
      await container?.stop();
    });

    it('lists plans with tenant counts, catalog and fonts', async () => {
      const headers = await login('soporte@tuapp.com');
      const plans = await call('GET', '/plans', { headers });
      expect(plans.status).toBe(200);
      expect(plans.body).toMatchObject({
        enabled: true,
        defaultPlan: 'basico',
        withoutPlan: 0,
        unknown: [],
      });
      expect(plans.body.features.map((f: { id: string }) => f.id)).toEqual([
        'agenda',
        'caja',
        'reportes',
      ]);
      // clinica-b no tiene plan: cuenta en el plan por defecto.
      expect(
        plans.body.plans.map((p: { id: string; tenants: number }) => [p.id, p.tenants]),
      ).toEqual([
        ['basico', 2],
        ['pro', 1],
      ]);
      const fonts = await call('GET', '/fonts', { headers });
      expect(fonts.body.restricted).toBe(true);
      expect(fonts.body.fonts[0]).toMatchObject({ family: 'Inter', source: 'google' });

      const list = await call('GET', '/tenants?plan=pro', { headers });
      expect(list.body.items.map((t: { id: string }) => t.id)).toEqual(['clinica-c']);
      const none = await call('GET', '/tenants?plan=', { headers });
      expect(none.body.items.map((t: { id: string }) => t.id)).toEqual(['clinica-b']);

      const metrics = await call('GET', '/metrics', { headers });
      expect(metrics.body.plans).toEqual({ basico: 1, '': 1, pro: 1 });
    });

    it('changes the plan and the loose modules of a tenant, with audit', async () => {
      const support = await login('soporte@tuapp.com');
      expect(
        (await call('PATCH', '/tenants/clinica-a', { headers: support, body: { plan: 'pro' } }))
          .status,
      ).toBe(403);

      const headers = await login('admin@tuapp.com');
      const patched = await call('PATCH', '/tenants/clinica-a', {
        headers,
        body: { features: { add: ['reportes'], limits: { usuarios: 5 } } },
      });
      expect(patched.status).toBe(200);
      expect(patched.body.features).toEqual({ add: ['reportes'], limits: { usuarios: 5 } });

      const detail = await call('GET', '/tenants/clinica-a', { headers });
      expect(detail.body.plan).toEqual({
        enabled: true,
        plan: 'basico',
        planLabel: 'Básico',
        knownPlan: true,
        unknownPlan: null,
        features: ['agenda', 'caja', 'reportes'],
        limits: { usuarios: 5 },
      });
      expect(detail.body.fonts.map((f: { family: string }) => f.family)).toEqual([
        'Inter',
        'Georgia',
      ]);

      const invalid = await call('PATCH', '/tenants/clinica-a', {
        headers,
        body: { plan: 'gold' },
      });
      expect(invalid.status).toBe(422);
      expect(invalid.body.error.code).toBe('TENANCY_INVALID_TENANT_DATA');
      const badFeature = await call('PATCH', '/tenants/clinica-a', {
        headers,
        body: { features: { add: ['inventado'] } },
      });
      expect(badFeature.status).toBe(422);

      const font = await call('PUT', '/tenants/clinica-a/theme', {
        headers,
        body: { font: 'Comic Sans' },
      });
      expect(font.status).toBe(422);
      expect(font.body.error.code).toBe('TENANCY_INVALID_THEME');

      const audit = await call('GET', '/audit?tenant=clinica-a&action=tenant.update', { headers });
      expect(audit.body[0].changes).toEqual({
        before: { features: null },
        after: { features: { add: ['reportes'], limits: { usuarios: 5 } } },
      });

      // Crear con plan y módulos sueltos (desde una solicitud).
      const created = await call('POST', '/tenants', {
        headers,
        body: { id: 'clinica-d', plan: 'basico', features: { add: ['reportes'] } },
      });
      expect(created.status).toBe(202);
      await expect
        .poll(async () => (await tenancy.tenants.find('clinica-d'))?.status)
        .toBe('active');
      expect((await tenancy.tenants.findOrFail('clinica-d')).features).toEqual({
        add: ['reportes'],
      });
    });

    it('receives public leads with honeypot, consent and rate limit', async () => {
      const form = {
        name: 'Ana Pérez',
        company: 'Dental Sur',
        city: 'La Paz',
        phone: '+591 70000000',
        email: 'ana@example.com',
        plan: 'pro',
        message: 'Quiero una demo',
        consent: true,
        data: { origen: 'google' },
      };
      const created = await call('POST', '/leads', { body: form });
      expect(created).toEqual({ status: 201, body: { ok: true } });
      expect(leadEvents).toHaveLength(1);
      expect(leadEvents[0]!.data).toMatchObject({
        name: 'Ana Pérez',
        plan: 'pro',
        email: 'ana@example.com',
      });

      // Bot: llena el campo trampa. Se responde igual, pero no se guarda.
      expect(
        (await call('POST', '/leads', { body: { ...form, website: 'http://spam' } })).status,
      ).toBe(201);
      const invalid = await call('POST', '/leads', {
        body: { name: 'Sin datos', consent: false, data: { otro: 'x' } },
      });
      expect(invalid.status).toBe(422);
      expect(invalid.body.error.details.map((d: { path: string }) => d.path)).toEqual([
        'email',
        'consent',
        'data.otro',
      ]);
      // El envío con errores no gastó un intento: el tercero válido entra...
      const third = await call('POST', '/leads', {
        body: { ...form, name: 'Carla Ríos', company: 'Clínica Norte', email: 'carla@example.com' },
      });
      expect(third.status).toBe(201);
      // ...y el siguiente desde la misma IP en la ventana queda bloqueado.
      const limited = await call('POST', '/leads', { body: form });
      expect(limited.status).toBe(429);
      expect(leadEvents).toHaveLength(2);

      // Plan desconocido: la solicitud se guarda sin plan.
      const lead = await admin.api.leads.create({
        name: 'Beto',
        email: 'beto@example.com',
        plan: 'gold',
      });
      expect(lead).toMatchObject({ plan: null, status: 'new', consentAt: null });

      const support = await login('soporte@tuapp.com');
      const list = await call('GET', '/leads', { headers: support });
      expect(list.body.total).toBe(3);
      expect(list.body.counts).toEqual({ new: 3, contacted: 0, converted: 0, discarded: 0 });
      const first = list.body.items.find((l: { name: string }) => l.name === 'Ana Pérez');
      expect(first).toMatchObject({
        company: 'Dental Sur',
        data: { origen: 'google' },
        ip: expect.any(String),
      });
      expect(first.consentAt).not.toBeNull();
      expect((await call('GET', '/leads?search=dental', { headers: support })).body.total).toBe(1);
      expect((await call('GET', '/leads?status=inventado', { headers: support })).status).toBe(422);
      expect(
        (
          await call('PATCH', `/leads/${first.id}`, {
            headers: support,
            body: { status: 'contacted' },
          })
        ).status,
      ).toBe(403);

      const headers = await login('admin@tuapp.com');
      const converted = await call('PATCH', `/leads/${first.id}`, {
        headers,
        body: { status: 'converted', tenantId: 'clinica-d', notes: 'Pagó el plan Pro' },
      });
      expect(converted.body).toMatchObject({ status: 'converted', tenantId: 'clinica-d' });
      expect((await call('GET', `/leads/${first.id}`, { headers })).body.notes).toBe(
        'Pagó el plan Pro',
      );
      expect((await call('GET', '/leads?status=converted', { headers })).body.total).toBe(1);
      expect((await call('DELETE', `/leads/${lead.id}`, { headers })).status).toBe(204);
      expect((await call('DELETE', `/leads/${lead.id}`, { headers })).status).toBe(404);
      expect((await call('GET', '/leads/abc', { headers })).status).toBe(404);
      expect((await call('GET', '/metrics', { headers })).body.leads).toMatchObject({
        converted: 1,
      });
    });
    it('sends, lists, previews and retracts notifications', async () => {
      const support = await login('soporte@tuapp.com');
      const denied = await call('POST', '/notifications', {
        headers: support,
        body: { title: 'x' },
      });
      expect(denied.status).toBe(403);

      const headers = await login('admin@tuapp.com');
      const reach = await call('POST', '/notifications/reach', {
        headers,
        body: { audience: { type: 'plans', plans: ['basico'] } },
      });
      // clinica-a (basico), clinica-b (sin plan → basico) y clinica-d (basico).
      expect(reach.body).toEqual({ tenants: 3 });

      const sent = await call('POST', '/notifications', {
        headers,
        body: {
          title: 'Mantenimiento el sábado',
          body: 'De 2 a 4 de la mañana',
          level: 'warning',
          audience: { type: 'tenants', tenants: ['clinica-a'] },
          link: { url: 'https://estado.tuapp.com' },
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      });
      expect(sent.status).toBe(201);
      expect(sent.body).toMatchObject({
        level: 'warning',
        createdBy: 'admin@tuapp.com',
        link: { label: 'Ver más' },
      });
      const invalid = await call('POST', '/notifications', { headers, body: { title: '' } });
      expect(invalid.status).toBe(422);
      expect(invalid.body.error.code).toBe('TENANCY_INVALID_NOTIFICATION');

      await tenancy.run('clinica-a', () => tenancy.notifications.markRead('all', 'u1'));
      const list = await call('GET', '/notifications', { headers: support });
      expect(list.body.total).toBe(1);
      expect(list.body.channels).toEqual([]);
      expect(list.body.items[0]).toMatchObject({
        title: 'Mantenimiento el sábado',
        reads: { tenants: 1, users: 1 },
      });
      expect(
        (await call('POST', `/notifications/${sent.body.id}/deliver`, { headers })).body,
      ).toEqual([]);

      expect((await call('DELETE', `/notifications/${sent.body.id}`, { headers })).status).toBe(
        204,
      );
      expect((await call('DELETE', `/notifications/${sent.body.id}`, { headers })).status).toBe(
        404,
      );
      const audit = await call('GET', '/audit?action=notification.', { headers });
      expect(audit.body.map((a: { action: string }) => a.action)).toEqual(
        expect.arrayContaining([
          'notification.send',
          'notification.delete',
          'notification.deliver',
        ]),
      );
    });
    it('manages subscriptions, invoices, manual payments and provider webhooks', async () => {
      const support = await login('soporte@tuapp.com');
      const headers = await login('admin@tuapp.com');
      expect(
        (
          await call('PUT', '/tenants/clinica-c/billing/subscription', {
            headers: support,
            body: {},
          })
        ).status,
      ).toBe(403);

      const sub = await call('PUT', '/tenants/clinica-a/billing/subscription', {
        headers,
        body: { period: 'monthly' },
      });
      expect(sub.status).toBe(200);
      expect(sub.body).toMatchObject({
        plan: 'basico',
        amountCents: 15000,
        currency: 'BOB',
        status: 'active',
      });
      const noPrice = await call('PUT', '/tenants/clinica-c/billing/subscription', {
        headers,
        body: {},
      });
      expect(noPrice.status).toBe(422);
      expect(noPrice.body.error.code).toBe('TENANCY_INVALID_BILLING');

      const detail = await call('GET', '/tenants/clinica-a/billing', { headers: support });
      expect(detail.body.providers).toEqual(['manual', 'qr']);
      expect(detail.body.invoices).toHaveLength(1);
      const first = detail.body.invoices[0];

      const partial = await call('POST', `/billing/invoices/${first.id}/payments`, {
        headers,
        body: { amount: 100, method: 'transfer', reference: 'TRX-9' },
      });
      expect(partial.status).toBe(201);
      expect(partial.body.invoice).toMatchObject({ status: 'open', paidCents: 10000 });
      expect(partial.body.payment).toMatchObject({
        recordedBy: 'admin@tuapp.com',
        method: 'transfer',
      });

      const checkout = await call('POST', `/billing/invoices/${first.id}/checkout`, {
        headers,
        body: {},
      });
      expect(checkout.body).toEqual({ providerRef: `qr_${first.id}`, qr: 'QR' });

      const hook = (provider: string, body: object, firma = 'ok') =>
        fetch(`${base}/billing/webhooks/${provider}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-firma': firma },
          body: JSON.stringify(body),
        });
      expect((await hook('qr', { ref: `qr_${first.id}` }, 'mala')).status).toBe(400);
      expect((await hook('stripe', {})).status).toBe(404);
      expect((await hook('manual', {})).status).toBe(404);
      const ok = await hook('qr', { ref: `qr_${first.id}` });
      expect(await ok.json()).toEqual({ received: true, handled: true });

      const after = await call('GET', '/tenants/clinica-a/billing', { headers });
      expect(after.body.invoices[0]).toMatchObject({ status: 'paid', paidCents: 15000 });
      expect(after.body.payments.map((p: { method: string }) => p.method).sort()).toEqual([
        'qr',
        'transfer',
      ]);

      const oneOff = await call('POST', '/tenants/clinica-a/billing/invoices', {
        headers,
        body: { description: 'Capacitación', amount: 80 },
      });
      expect(oneOff.status).toBe(201);
      expect(
        (await call('POST', `/billing/invoices/${oneOff.body.id}/void`, { headers })).body.status,
      ).toBe('void');
      expect(
        (await call('POST', `/billing/invoices/${oneOff.body.id}/void`, { headers })).status,
      ).toBe(409);

      const list = await call('GET', '/billing/invoices?status=paid', { headers: support });
      expect(list.body.total).toBe(1);
      expect(list.body.summary).toEqual({ open: 0, overdue: 0, pastDueSubscriptions: 0 });
      expect((await call('GET', '/billing/invoices?status=nope', { headers })).status).toBe(422);
      expect((await call('POST', '/billing/run', { headers })).body).toEqual({
        invoiced: [],
        pastDue: [],
        suspended: [],
      });
      expect(
        (await call('POST', '/tenants/clinica-a/billing/cancel', { headers })).body.status,
      ).toBe('canceled');
      const audit = await call('GET', '/audit?action=billing.', { headers });
      expect(audit.body.map((a: { action: string }) => a.action)).toEqual(
        expect.arrayContaining([
          'billing.subscribe',
          'billing.payment',
          'billing.invoice',
          'billing.void',
          'billing.run',
          'billing.cancel',
        ]),
      );
    });
    it('edits plans and the platform brand from the panel', async () => {
      const support = await login('soporte@tuapp.com');
      const headers = await login('admin@tuapp.com');
      expect(
        (await call('PATCH', '/plans/basico', { headers: support, body: { label: 'x' } })).status,
      ).toBe(403);

      const edited = await call('PATCH', '/plans/basico', {
        headers,
        body: { label: 'Básico 2026', price: { currency: 'BOB', monthly: 180 }, highlight: true },
      });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({
        label: 'Básico 2026',
        customized: true,
        source: 'config',
        updatedBy: 'admin@tuapp.com',
      });
      expect(
        (await call('PATCH', '/plans/basico', { headers, body: { features: ['nope'] } })).body.error
          .code,
      ).toBe('TENANCY_INVALID_PLAN');
      const created = await call('POST', '/plans', {
        headers,
        body: {
          id: 'premium',
          label: 'Premium',
          features: '*',
          price: { currency: 'BOB', monthly: 500 },
        },
      });
      expect(created.status).toBe(201);
      expect(
        (
          await call('POST', '/plans', {
            headers,
            body: { id: 'premium', label: 'x', features: [] },
          })
        ).status,
      ).toBe(409);
      // El plan nuevo se puede asignar y se ve en la web comercial.
      expect(
        (await call('PATCH', '/tenants/clinica-c', { headers, body: { plan: 'premium' } })).status,
      ).toBe(200);
      expect((await call('DELETE', '/plans/premium', { headers })).status).toBe(409);
      expect(
        (await call('PATCH', '/tenants/clinica-c', { headers, body: { plan: 'pro' } })).status,
      ).toBe(200);
      expect((await call('DELETE', '/plans/premium', { headers })).body).toEqual({
        id: 'premium',
        result: 'archived',
      });
      expect((await call('DELETE', '/plans/basico', { headers })).body).toEqual({
        id: 'basico',
        result: 'reset',
      });
      const list = await call('GET', '/plans', { headers: support });
      expect(list.body.plans.find((p: { id: string }) => p.id === 'premium')).toMatchObject({
        archived: true,
      });
      expect(list.body.plans.find((p: { id: string }) => p.id === 'basico')).toMatchObject({
        label: 'Básico',
        customized: false,
      });

      const brand = await call('PATCH', '/platform', {
        headers,
        body: {
          name: 'IONIX',
          primary: '#0f766e',
          contact: { whatsapp: '+591 70000000', email: 'ventas@ionix.bo' },
          salesNotifyTo: ['jefe@ionix.bo'],
        },
      });
      expect(brand.status).toBe(200);
      expect(brand.body).toMatchObject({
        name: 'IONIX',
        primary: '#0F766E',
        contact: { whatsapp: '59170000000' },
      });
      expect(
        (await call('PATCH', '/platform', { headers, body: { primary: 'rojo' } })).body.error.code,
      ).toBe('TENANCY_INVALID_PLATFORM');
      expect(
        (await call('PATCH', '/platform', { headers: support, body: { name: 'x' } })).status,
      ).toBe(403);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      const upload = await fetch(`${base}/platform/logo`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'image/png' },
        body: png,
      });
      const withLogo = (await upload.json()) as { logo: string; logoUrl: string };
      expect(withLogo.logo).toMatch(/^platform\/logo-[0-9a-f]{16}\.png$/);
      const ico = await fetch(`${base}/platform/favicon`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'image/x-icon' },
        body: Buffer.from([0, 0, 1, 0, 1]),
      });
      expect(((await ico.json()) as { favicon: string }).favicon).toMatch(/\.ico$/);
      const bad = await fetch(`${base}/platform/logo`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'image/png' },
        body: Buffer.from('<svg/>'),
      });
      expect(bad.status).toBe(415);
      expect((await call('GET', '/platform', { headers: support })).body.salesNotifyTo).toEqual([
        'jefe@ionix.bo',
      ]);

      // El aviso de una solicitud lleva los correos de ventas.
      const lead = await admin.api.leads.create({ name: 'Dora', email: 'dora@example.com' });
      expect(leadEvents.find((e) => (e.data as { id: number }).id === lead.id)?.data).toMatchObject(
        {
          notifyTo: ['jefe@ionix.bo'],
        },
      );
      const audit = await call('GET', '/audit?action=p', { headers });
      expect(audit.body.map((a: { action: string }) => a.action)).toEqual(
        expect.arrayContaining([
          'plan.update',
          'plan.create',
          'plan.archive',
          'plan.reset',
          'platform.update',
          'platform.logo_upload',
        ]),
      );
    });
  },
);
