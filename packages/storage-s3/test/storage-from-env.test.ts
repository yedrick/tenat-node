import path from 'node:path';
import { InvalidConfigError, LocalStorage } from '@tenancy-node/core';
import { S3Storage, storageFromEnv } from '@tenancy-node/storage-s3';
import { describe, expect, it } from 'vitest';

const ACCOUNT = '0123456789abcdef0123456789abcdef';

async function s3Config(env: Record<string, string>) {
  const storage = storageFromEnv(env);
  expect(storage).toBeInstanceOf(S3Storage);
  const { config } = (storage as S3Storage).client;
  const endpoint = config.endpoint ? await config.endpoint() : undefined;
  return {
    storage: storage as S3Storage,
    region: await config.region(),
    endpoint: endpoint ? `${endpoint.protocol}//${endpoint.hostname}` : undefined,
    pathStyle: config.forcePathStyle,
    credentials: await config.credentials(),
  };
}

describe('storageFromEnv', () => {
  it('uses the local disk by default', () => {
    expect(storageFromEnv({})).toBeInstanceOf(LocalStorage);
    const local = storageFromEnv({ STORAGE_DRIVER: 'local', STORAGE_LOCAL_ROOT: './archivos' });
    expect((local as LocalStorage).root).toBe(path.resolve('./archivos'));
  });

  it('configures S3 or any compatible service', async () => {
    const minio = await s3Config({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'archivos',
      S3_REGION: 'sa-east-1',
      S3_ENDPOINT: 'http://minio:9000',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_PUBLIC_URL: 'https://cdn.tuapp.com',
      S3_PREFIX: 'uploads/',
    });
    expect(minio).toMatchObject({
      region: 'sa-east-1',
      endpoint: 'http://minio',
      pathStyle: true,
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    });
    expect(await minio.storage.url('bolivar/logo.png')).toBe(
      'https://cdn.tuapp.com/uploads/bolivar/logo.png',
    );
  });

  it('builds the Cloudflare R2 endpoint from the account id', async () => {
    const r2 = await s3Config({
      STORAGE_DRIVER: 'R2',
      S3_BUCKET: 'logos',
      R2_ACCOUNT_ID: ACCOUNT,
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(r2).toMatchObject({
      region: 'auto',
      endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    });
    // Sin URL pública, las URLs son firmadas y vencen.
    const url = await r2.storage.url('bolivar/logo.png');
    expect(url).toContain(`https://logos.${ACCOUNT}.r2.cloudflarestorage.com/bolivar/logo.png?`);
    expect(url).toContain('X-Amz-Signature=');
  });

  it('fails at startup with a clear message when something is missing or wrong', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ STORAGE_DRIVER: 'ftp' }, /local, s3 or r2/],
      [{ STORAGE_DRIVER: 's3' }, /S3_BUCKET/],
      [{ STORAGE_DRIVER: 'r2', S3_BUCKET: 'b' }, /R2_ACCOUNT_ID/],
      [{ STORAGE_DRIVER: 'r2', S3_BUCKET: 'b', R2_ACCOUNT_ID: 'nope' }, /32-character/],
      [{ STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ENDPOINT: 'minio:9000' }, /http/],
      [{ STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k' }, /both/],
      [{ STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_FORCE_PATH_STYLE: 'si' }, /true or false/],
      [{ STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_SIGNED_URL_EXPIRES: '-5' }, /positive/],
    ];
    for (const [env, message] of cases) {
      expect(() => storageFromEnv(env)).toThrow(InvalidConfigError);
      expect(() => storageFromEnv(env)).toThrow(message);
    }
  });
});
