import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { createTestTenancy, storageDriverContract } from '@tenancy-node/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { S3Storage } from '@tenancy-node/storage-s3';
import { s3 } from '@tenancy-node/storage-s3';

/** Contra SeaweedFS, un servidor real compatible con S3. */
describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('S3 storage', () => {
  let container: StartedTestContainer;
  let endpoint = '';
  let n = 0;
  const drivers: S3Storage[] = [];

  const make = async (options: Partial<Parameters<typeof s3>[0]> = {}) => {
    const bucket = `test-${Date.now()}-${n++}`;
    const driver = s3({
      bucket,
      endpoint,
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: 'any', secretAccessKey: 'any' },
      ...options,
    });
    drivers.push(driver);
    await driver.client.send(new CreateBucketCommand({ Bucket: bucket }));
    return driver;
  };

  beforeAll(async () => {
    container = await new GenericContainer('chrislusf/seaweedfs:latest')
      .withCommand(['server', '-s3', '-dir=/data'])
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forLogMessage(/Start Seaweed S3 API Server|S3 API Server/i))
      .start();
    endpoint = `http://${container.getHost()}:${container.getMappedPort(8333)}`;
    // El API de S3 tarda un momento más en aceptar pedidos después del log.
    for (let i = 0; i < 50; i++) {
      try {
        await (await make()).ping();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }, 240_000);
  afterAll(async () => {
    for (const d of drivers) await d.close();
    await container?.stop();
  });

  storageDriverContract('S3Storage (SeaweedFS)', () => make());

  it('signs URLs that really download the file, or uses the public URL', async () => {
    const driver = await make();
    await driver.put('bolivar/logo.png', 'PNG-DATA', { contentType: 'image/png' });
    const signed = await driver.url('bolivar/logo.png', { expiresInSeconds: 60 });
    expect(signed).toContain('X-Amz-Signature');
    const response = await fetch(signed);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('PNG-DATA');

    const cdn = await make({ publicUrl: 'https://cdn.tuapp.com/', keyPrefix: 'uploads/' });
    await cdn.put('bolivar/a b.png', 'x');
    expect(await cdn.url('bolivar/a b.png')).toBe(
      'https://cdn.tuapp.com/uploads/bolivar/a%20b.png',
    );
    expect((await cdn.list('bolivar/')).map((f) => f.key)).toEqual(['bolivar/a b.png']);
  });

  it('works as tenancy.storage() with isolation per tenant', async () => {
    const driver = await make();
    const { tenancy, seed } = createTestTenancy({ storage: driver });
    await seed(['bolivar', 'tigre']);
    await tenancy.run('bolivar', () => tenancy.storage().put('factura.pdf', 'B'));
    expect(await tenancy.run('tigre', () => tenancy.storage().exists('factura.pdf'))).toBe(false);
    expect(await tenancy.run('bolivar', () => tenancy.storage().getText('factura.pdf'))).toBe('B');
    expect((await tenancy.health()).checks.storage?.ok).toBe(true);
  });
});
