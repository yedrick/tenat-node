/// <reference lib="dom" />
// El código dentro de page.evaluate() corre en el navegador: necesita los tipos del DOM.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { serveAdmin } from '@tenancy-node/admin-api';
import { AdminUsers } from '@tenancy-node/admin-api';
import { createTenancy, type Tenancy } from '@tenancy-node/core';
import { database, type DatabaseExtension } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { outbox } from '@tenancy-node/outbox';
import { MemoryLogger } from '@tenancy-node/testing';
import { webhooks } from '@tenancy-node/transport-webhook';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const shots = process.env.TENANCY_SCREENSHOTS;
const PASSWORD = 'contraseña-del-panel-123';

/** Recorrido real del panel en Chromium: login, creación con progreso, tema, dominios, datos, webhooks, roles. */
describe.skipIf(
  process.env.TENANCY_SKIP_DB_TESTS === '1' || !existsSync(path.join(dist, 'index.html')),
)('admin UI in a real browser', () => {
  let container: StartedPostgreSqlContainer;
  let tenancy: Tenancy & DatabaseExtension;
  let admin: Awaited<ReturnType<typeof serveAdmin>>;
  let browser: Browser;
  let base = '';
  const problems: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withUsername('admin')
      .withPassword('secret')
      .withDatabase('app')
      .start();
    tenancy = createTenancy({
      centralDomains: ['tuapp.com'],
      logger: new MemoryLogger(),
      plugins: [
        database({
          driver: postgres(),
          central: {
            url: `postgres://admin:secret@${container.getHost()}:${container.getPort()}/app`,
          },
          encryptionKey: 'base64:' + Buffer.alloc(32, 5).toString('base64'),
          migrations: {
            tenant: {
              '001_clientes': {
                up: (db) =>
                  db.schema
                    .createTable('clientes')
                    .addColumn('id', 'integer', (c) => c.primaryKey())
                    .addColumn('nombre', 'text')
                    .addColumn('api_key', 'text')
                    .execute(),
              },
            },
          },
          seed: async (db) =>
            void (await db
              .insertInto('clientes')
              .values([{ id: 1, nombre: 'Ana', api_key: 'sk_live_secreta' }])
              .execute()),
        }),
        outbox(),
        webhooks({ allowPrivateNetworks: true }),
      ],
    }) as Tenancy & DatabaseExtension;
    await tenancy.database.install();
    const users = new AdminUsers(tenancy.database.central());
    await users.create({
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
    });
    base = `http://127.0.0.1:${(admin.server.address() as { port: number }).port}/admin`;
    browser = await chromium.launch();
    if (shots) await mkdir(shots, { recursive: true });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await admin?.close();
    await tenancy?.close();
    await container?.stop();
  });

  const newPage = async (): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
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
    return page;
  };
  const shot = async (page: Page, name: string) =>
    shots && page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

  const login = async (page: Page, email: string, password = PASSWORD) => {
    await page.goto(`${base}/`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
  };

  it('logs in, shows the dashboard, creates a tenant with live progress and edits it', async () => {
    const page = await newPage();
    await login(page, 'owner@tuapp.com', 'incorrecta-1234');
    await expect
      .poll(() => page.getByRole('alert').textContent())
      .toContain('ADMIN_INVALID_CREDENTIALS');
    await shot(page, '01-login-error');
    await login(page, 'owner@tuapp.com');
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await shot(page, '02-dashboard');

    // Crear un tenant y ver el progreso en vivo (SSE)
    await page.getByRole('link', { name: 'Tenants' }).click();
    await page.getByRole('button', { name: 'Nuevo tenant' }).click();
    await page.getByLabel('Id').fill('bolivar');
    await page.getByLabel('Nombre').fill('Club Bolívar');
    await page.getByLabel('Dominios').fill('bolivar.tuapp.com');
    await page.getByRole('button', { name: 'Crear' }).click();
    await page.getByText('El tenant quedó activo.').waitFor({ timeout: 30_000 });
    const steps = await page.getByRole('list', { name: 'Progreso' }).textContent();
    expect(steps).toContain('Crear base de datos');
    expect(steps).toContain('Migraciones');
    await shot(page, '03-progress');
    await page.getByRole('button', { name: 'Ver tenant' }).click();
    await page.getByRole('heading', { name: /Club Bolívar/ }).waitFor();
    expect(page.url()).toBe(`${base}/tenants/bolivar`);

    // Tema con vista previa en vivo
    await page.getByRole('tab', { name: 'Tema' }).click();
    await page.getByLabel('Primario', { exact: true }).fill('#E4002B');
    const color = await page
      .getByTestId('preview-primary')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(color).toBe('rgb(228, 0, 43)');
    await shot(page, '04-theme');
    await page.getByRole('button', { name: 'Guardar tema' }).click();
    await page.getByText('Tema guardado').waitFor();
    const saved = (await tenancy.tenants.findOrFail('bolivar')).theme?.primary.value;
    expect(saved).toBe('#E4002B');

    // Dominios
    await page.getByRole('tab', { name: 'Dominios' }).click();
    await page.getByLabel('Nuevo dominio').fill('clubbolivar.com');
    await page.getByRole('button', { name: 'Agregar' }).click();
    await page.getByText('clubbolivar.com').waitFor();

    // Explorador de datos: la columna sensible se oculta
    await page.getByRole('tab', { name: 'Datos', exact: true }).click();
    await page.getByRole('button', { name: /clientes/ }).click();
    await page.getByText('Ana').waitFor();
    expect(await page.content()).not.toContain('sk_live_secreta');
    expect(await page.getByText('••••••').count()).toBe(1);
    await shot(page, '05-data');

    // Webhook: el secreto se muestra una sola vez
    await page.getByRole('link', { name: 'Webhooks' }).click();
    await page.getByRole('button', { name: 'Nuevo webhook' }).click();
    await page.getByLabel('Nombre').fill('ERP');
    await page.getByLabel('URL').fill('http://127.0.0.1:9/hook');
    await page.getByRole('button', { name: 'Crear' }).click();
    expect(await page.getByTestId('webhook-secret').textContent()).toMatch(/^whsec_/);
    await page.getByRole('button', { name: 'Listo' }).click();
    await page.getByRole('cell', { name: 'ERP' }).waitFor();

    // Usuarios: crear uno con rol support
    await page.getByRole('link', { name: 'Usuarios' }).click();
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    await page.getByLabel('Nombre').fill('Soporte');
    await page.getByLabel('Email').fill('soporte@tuapp.com');
    await page.getByLabel('Contraseña inicial').fill(PASSWORD);
    await page.getByRole('button', { name: 'Crear' }).click();
    await page.getByRole('cell', { name: 'soporte@tuapp.com' }).waitFor();

    // Auditoría
    await page.getByRole('link', { name: 'Auditoría' }).click();
    await page.getByText('tenant.create').first().waitFor();
    await page.getByText('theme.update').first().waitFor();
    expect(await page.getByRole('cell', { name: 'owner@tuapp.com' }).count()).toBeGreaterThan(0);
    await shot(page, '06-audit');
    await page.getByRole('button', { name: 'Salir' }).click();
    await page.getByRole('button', { name: 'Entrar' }).waitFor();
    await page.close();
  });

  it('shows a support user only what the role allows', async () => {
    const page = await newPage();
    await login(page, 'soporte@tuapp.com');
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    const nav = await page.getByRole('navigation', { name: 'Principal' }).textContent();
    expect(nav).toContain('Tenants');
    expect(nav).not.toContain('Usuarios');
    expect(nav).not.toContain('Auditoría');
    await page.getByRole('link', { name: 'Tenants' }).click();
    await page.getByRole('cell', { name: 'bolivar' }).first().waitFor();
    expect(await page.getByRole('button', { name: 'Nuevo tenant' }).count()).toBe(0);
    await page.getByRole('cell', { name: 'bolivar' }).first().click();
    await page.getByRole('button', { name: 'Vaciar caché' }).waitFor();
    expect(await page.getByRole('button', { name: 'Suspender' }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Eliminar tenant' }).count()).toBe(0);
    await page.close();
  });

  it('serves the SPA with strict CSP, deep links and no errors in the browser', async () => {
    const page = await newPage();
    const response = await page.goto(`${base}/tenants/bolivar`);
    expect(response!.headers()['content-security-policy']).toContain("script-src 'self'");
    expect(response!.headers()['cache-control']).toBe('no-cache');
    await page.getByRole('button', { name: 'Entrar' }).waitFor();
    const asset = await page.evaluate(
      () => (document.querySelector('script[type=module]') as HTMLScriptElement).src,
    );
    const assetResponse = await page.request.get(asset);
    expect(assetResponse.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    const traversal = await page.request.get(`${base}/..%2f..%2fpackage.json`);
    expect(await traversal.text()).not.toContain('"name"');
    expect(problems).toEqual([]);
    await page.close();
  });
});
