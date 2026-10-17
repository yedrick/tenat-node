/// <reference lib="dom" />
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AdminUsers, serveAdmin } from '@tenancy-node/admin-api';
import { createTenancy, type Tenancy } from '@tenancy-node/core';
import { database, type DatabaseExtension } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { MemoryLogger } from '@tenancy-node/testing';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const PASSWORD = 'contraseña-del-panel-123';

/** Planes, solicitudes y fuentes del tema en Chromium real, con la CSP del panel. */
describe.skipIf(
  process.env.TENANCY_SKIP_DB_TESTS === '1' || !existsSync(path.join(dist, 'index.html')),
)('admin UI: plans, leads and fonts in a real browser', () => {
  let container: StartedPostgreSqlContainer;
  let tenancy: Tenancy & DatabaseExtension;
  let admin: Awaited<ReturnType<typeof serveAdmin>>;
  let browser: Browser;
  let base = '';
  const problems: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    tenancy = createTenancy({
      centralDomains: ['tuapp.com'],
      logger: new MemoryLogger(),
      features: { agenda: 'Agenda', caja: 'Caja chica', reportes: 'Reportes' },
      plans: {
        basico: {
          label: 'Básico',
          price: { currency: 'BOB', monthly: 150 },
          features: ['agenda', 'caja'],
          limits: { usuarios: 3 },
        },
        pro: { label: 'Profesional', features: '*', limits: { usuarios: 10 }, highlight: true },
      },
      defaultPlan: 'basico',
      theme: {
        fonts: [{ family: 'Inter' }, { family: 'Georgia', source: 'system', fallback: 'serif' }],
      },
      plugins: [database({ driver: postgres(), central: { url: container.getConnectionUri() } })],
    }) as Tenancy & DatabaseExtension;
    await tenancy.database.install();
    await new AdminUsers(tenancy.database.central()).create({
      email: 'owner@tuapp.com',
      name: 'Dueña',
      password: PASSWORD,
      role: 'owner',
    });
    admin = await serveAdmin(tenancy, {
      port: 0,
      sessionSecret: 'k'.repeat(40),
      secureCookies: false,
      ui: dist,
      leads: true,
    });
    base = `http://127.0.0.1:${(admin.server.address() as { port: number }).port}/admin`;
    await tenancy.tenants.create({ id: 'clinica-a', name: 'Clínica A', plan: 'basico' });
    await admin.api.leads.create({
      name: 'Ana Pérez',
      company: 'Dental Sur',
      email: 'ana@example.com',
      phone: '+591 70000000',
      city: 'La Paz',
      plan: 'pro',
      message: 'Quiero una demo',
      consent: true,
    });
    browser = await chromium.launch();
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await admin?.close();
    await tenancy?.close();
    await container?.stop();
  });

  const newPage = async (): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on(
      'console',
      (m) =>
        m.type() === 'error' &&
        !/401|Unauthorized/.test(m.text()) &&
        problems.push(`console: ${m.text()}`),
    );
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) =>
        console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
      );
    });
    // Sin red en CI: Google Fonts responde vacío, pero la CSP se aplica igual.
    await page.route('https://fonts.googleapis.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
    );
    return page;
  };

  it('shows plans, edits a tenant plan, converts a lead and picks a font', async () => {
    const page = await newPage();
    await page.goto(`${base}/`);
    await page.getByLabel('Email').fill('owner@tuapp.com');
    await page.getByLabel('Contraseña').fill(PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await page.getByText('Tenants por plan').waitFor();

    // Planes
    await page.getByRole('link', { name: 'Planes', exact: true }).click();
    const basico = page.getByRole('region', { name: 'Plan Básico' });
    await basico.waitFor();
    expect(await basico.textContent()).toContain('150 BOB / mes');
    expect(await basico.textContent()).toContain('1 tenant');

    // Plan del tenant: agregar Reportes como módulo suelto
    await basico.getByRole('link', { name: /1 tenant/ }).click();
    await page.getByText('Clínica A', { exact: true }).click();
    await page.getByRole('heading', { name: 'Plan y módulos' }).waitFor();
    await page.getByRole('checkbox', { name: /Reportes/ }).check();
    await page.getByRole('button', { name: 'Guardar plan' }).click();
    await page.getByText('Plan guardado').waitFor();
    expect((await tenancy.tenants.findOrFail('clinica-a')).features).toEqual({
      add: ['reportes'],
    });

    // Tema: la fuente se elige de la lista y se ve en la vista previa
    await page.getByRole('tab', { name: 'Tema' }).click();
    await page.getByRole('radio', { name: 'Georgia' }).click();
    const font = await page
      .getByTestId('theme-preview')
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font).toContain('Georgia');
    await page.getByRole('button', { name: 'Guardar tema' }).click();
    await page.getByText('Tema guardado').waitFor();
    expect((await tenancy.tenants.findOrFail('clinica-a')).theme?.font).toBe('Georgia');

    // Solicitud → tenant
    await page.getByRole('link', { name: 'Solicitudes', exact: true }).click();
    await page.getByText('Dental Sur').click();
    const dialog = page.getByRole('dialog', { name: 'Dental Sur' });
    await dialog.getByText('Quiero una demo').waitFor();
    await dialog.getByRole('button', { name: 'Crear tenant' }).click();
    const form = page.getByRole('dialog', { name: 'Nuevo tenant' });
    await expect.poll(() => form.getByLabel('Id').inputValue()).toBe('dental-sur');
    await expect.poll(() => form.getByLabel('Plan').inputValue()).toBe('pro');
    await form.getByRole('button', { name: 'Crear' }).click();
    await page.getByText('El tenant quedó activo.').waitFor({ timeout: 30_000 });
    expect((await tenancy.tenants.findOrFail('dental-sur')).plan).toBe('pro');
    const leads = await admin.api.leads.list({ status: 'converted' });
    expect(leads.items.map((l) => l.tenantId)).toEqual(['dental-sur']);

    expect(problems).toEqual([]);
    await page.close();
  });
  it('sends a notice to a tenant and records a manual payment', async () => {
    await tenancy.billing.subscribe('clinica-a');
    const page = await newPage();
    await page.goto(`${base}/`);
    await page.getByLabel('Email').fill('owner@tuapp.com');
    await page.getByLabel('Contraseña').fill(PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await page.getByRole('heading', { name: 'Cobros' }).waitFor();

    // Aviso a un tenant específico, con vista previa y alcance
    await page.getByRole('link', { name: 'Avisos', exact: true }).click();
    await page.getByText('Sin canales push configurados').waitFor();
    await page.getByRole('button', { name: 'Nuevo aviso' }).click();
    const compose = page.getByRole('dialog', { name: 'Nuevo aviso' });
    await compose.getByLabel('Título').fill('Mantenimiento el sábado');
    await compose.getByLabel('Mensaje').fill('De 2 a 4 de la mañana');
    await compose.getByRole('radio', { name: 'Atención' }).click();
    await compose.getByRole('radio', { name: 'Tenants específicos' }).click();
    await compose.getByLabel('Buscar tenants').fill('clínica a');
    await compose.getByRole('button', { name: /Clínica A/ }).click();
    await compose.getByText('Llegará a 1 tenant activo.').waitFor();
    expect(await compose.getByTestId('notification-preview').textContent()).toContain(
      'Mantenimiento el sábado',
    );
    await compose.getByRole('button', { name: 'Enviar aviso' }).click();
    await page.getByText('Aviso enviado').waitFor();
    await page.getByRole('cell', { name: /1 tenant: clinica-a/ }).waitFor();
    const visible = await tenancy.run('clinica-a', () => tenancy.notifications.forTenant());
    expect(visible.map((n) => [n.title, n.level, n.createdBy])).toEqual([
      ['Mantenimiento el sábado', 'warning', 'owner@tuapp.com'],
    ]);

    // Cobros: registrar el pago manual de la primera factura
    await page.getByRole('link', { name: 'Cobros', exact: true }).click();
    await page.getByRole('link', { name: 'clinica-a' }).waitFor();
    await page.getByRole('button', { name: 'Registrar pago' }).click();
    const pay = page.getByRole('dialog', { name: 'Registrar pago' });
    expect(await pay.getByLabel('Monto (BOB)').inputValue()).toBe('150');
    await pay.getByLabel('Referencia').fill('TRX-77');
    await pay.getByRole('button', { name: 'Registrar pago' }).click();
    await page.getByText('Pago registrado').waitFor();
    const [invoice] = (await tenancy.billing.invoices({ tenantId: 'clinica-a' })).items;
    expect(invoice).toMatchObject({ status: 'paid', paidCents: 15000 });
    const [payment] = await tenancy.billing.payments({ tenantId: 'clinica-a' });
    expect(payment).toMatchObject({ reference: 'TRX-77', recordedBy: 'owner@tuapp.com' });

    // Pagada, sale de "Abiertas": se ve en "Pagadas". La pestaña del tenant muestra el pago.
    await page.getByRole('radio', { name: 'Pagadas' }).click();
    await page.getByRole('link', { name: 'clinica-a' }).click();
    await page.getByRole('tab', { name: 'Cobros' }).click();
    await page.getByText('Al día').waitFor();
    await page.getByText('TRX-77').waitFor();

    expect(problems).toEqual([]);
    await page.close();
  });
  it('edits a plan price and the platform brand without deploying', async () => {
    const page = await newPage();
    await page.goto(`${base}/`);
    await page.getByLabel('Email').fill('owner@tuapp.com');
    await page.getByLabel('Contraseña').fill(PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();

    // Precio de un plan de la configuración, editado desde el panel
    await page.getByRole('link', { name: 'Planes', exact: true }).click();
    const basico = page.getByRole('region', { name: 'Plan Básico' });
    await basico.getByRole('button', { name: 'Editar' }).click();
    const form = page.getByRole('form', { name: 'Editar plan Básico' });
    await form.getByLabel('Mensual').fill('180');
    await form.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('Plan "Básico" guardado').waitFor();
    await expect.poll(async () => basico.textContent()).toContain('180 BOB / mes');
    expect(await basico.textContent()).toContain('Modificado');
    expect(tenancy.plans.get('basico')?.price).toMatchObject({ monthly: 180 });

    // Marca de la plataforma
    await page.getByRole('link', { name: 'Plataforma', exact: true }).click();
    const brand = page.getByRole('form', { name: 'Marca de la plataforma' });
    await brand.getByLabel('Nombre').fill('IONIX');
    await brand.getByLabel('WhatsApp').fill('591 70000000');
    await brand.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('Plataforma guardada').waitFor();
    expect(await page.getByTestId('platform-preview').textContent()).toContain('IONIX');
    const platform = await tenancy.platform.get();
    expect(platform).toMatchObject({ name: 'IONIX', contact: { whatsapp: '59170000000' } });
    await page.getByText(/Actualizado por owner@tuapp.com/).waitFor();

    expect(problems).toEqual([]);
    await page.close();
  });
});
