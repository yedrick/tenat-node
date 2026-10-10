import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  InvalidConfigError,
  LocalStorage,
  type PutOptions,
  type StorageDriver,
  type StoredFile,
} from '@tenancy-node/core';

export interface S3StorageOptions {
  bucket: string;
  region?: string | undefined;
  /** Para servicios compatibles: MinIO, R2, DigitalOcean Spaces, SeaweedFS... */
  endpoint?: string | undefined;
  /** `true` para la mayoría de los servicios compatibles con S3 (no AWS). */
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Prefijo global de las llaves dentro del bucket (por ejemplo `uploads/`). */
  keyPrefix?: string | undefined;
  /** URL pública base (CDN o bucket público). Si falta, `url()` devuelve una URL firmada. */
  publicUrl?: string | undefined;
  /** Vigencia de las URLs firmadas. Por defecto 3600 s. */
  signedUrlExpiresInSeconds?: number;
  /** Cliente propio (no se cierra al terminar). */
  client?: S3Client;
  clientConfig?: S3ClientConfig;
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/** Almacenamiento en S3 o compatible: `bucket/bolivar/logo.png`. */
export class S3Storage implements StorageDriver {
  readonly name = 's3';
  readonly client: S3Client;
  private readonly owned: boolean;

  constructor(private readonly options: S3StorageOptions) {
    this.owned = !options.client;
    this.client =
      options.client ??
      new S3Client({
        region: options.region ?? 'us-east-1',
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        ...options.clientConfig,
      });
  }

  private key(key: string): string {
    return (this.options.keyPrefix ?? '') + key;
  }

  async put(key: string, body: Uint8Array | string, options: PutOptions = {}): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: this.key(key),
        Body: typeof body === 'string' ? Buffer.from(body) : body,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: this.key(key) }),
      );
      return result.Body ? await result.Body.transformToByteArray() : new Uint8Array();
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: this.key(key) }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.key(key) }),
    );
  }

  async list(prefix: string): Promise<StoredFile[]> {
    const files: StoredFile[] = [];
    const base = this.options.keyPrefix ?? '';
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: this.key(prefix),
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        files.push({
          key: object.Key.slice(base.length),
          size: object.Size ?? 0,
          lastModified: object.LastModified ?? null,
        });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return files.sort((a, b) => a.key.localeCompare(b.key));
  }

  async deletePrefix(prefix: string): Promise<void> {
    const keys = (await this.list(prefix)).map((f) => this.key(f.key));
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      try {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.options.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      } catch {
        // Algunos servicios compatibles no soportan DeleteObjects: se borra uno por uno.
        for (const Key of batch)
          await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key }));
      }
    }
  }

  async url(key: string, options: { expiresInSeconds?: number } = {}): Promise<string> {
    if (this.options.publicUrl) {
      return `${this.options.publicUrl.replace(/\/+$/, '')}/${this.key(key).split('/').map(encodeURIComponent).join('/')}`;
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: this.key(key) }),
      {
        expiresIn: options.expiresInSeconds ?? this.options.signedUrlExpiresInSeconds ?? 3600,
      },
    );
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
  }

  async close(): Promise<void> {
    if (this.owned) this.client.destroy();
  }
}

/** `storage: s3({ bucket: 'mi-app' })` */
export function s3(options: S3StorageOptions): S3Storage {
  return new S3Storage(options);
}

/** Variables de entorno que lee `storageFromEnv`. */
export type StorageEnv = Record<string, string | undefined>;

const TRUE = /^(1|true|yes|on)$/i;
const FALSE = /^(0|false|no|off)$/i;

/**
 * Elige y configura el almacenamiento con variables de entorno, para cambiar de disco local a
 * S3, Cloudflare R2, MinIO, Spaces... sin tocar el código:
 *
 * ```ts
 * createTenancy({ storage: storageFromEnv() });
 * ```
 *
 * | Variable                                   | Uso                                                       |
 * | ------------------------------------------ | --------------------------------------------------------- |
 * | `STORAGE_DRIVER`                           | `local` (por defecto), `s3` o `r2`                        |
 * | `STORAGE_LOCAL_ROOT`                       | Carpeta del driver local. Por defecto `./storage`         |
 * | `S3_BUCKET`                                | Bucket (obligatorio con `s3` y `r2`)                      |
 * | `S3_REGION`                                | Región. Por defecto `us-east-1` (`auto` con `r2`)         |
 * | `S3_ENDPOINT`                              | Servicio compatible (MinIO, Spaces...). Con `r2`, opcional |
 * | `R2_ACCOUNT_ID`                            | Con `r2`: arma `https://<id>.r2.cloudflarestorage.com`    |
 * | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Credenciales (si faltan, las de AWS del entorno)          |
 * | `S3_FORCE_PATH_STYLE`                      | `true` para MinIO y la mayoría de los compatibles         |
 * | `S3_PUBLIC_URL`                            | URL pública (CDN o dominio del bucket); sin ella, URLs firmadas |
 * | `S3_PREFIX`                                | Prefijo de las llaves dentro del bucket                   |
 * | `S3_SIGNED_URL_EXPIRES`                    | Vigencia de las URLs firmadas, en segundos                |
 *
 * Lanza `InvalidConfigError` si falta algo o un valor no es válido, al arrancar y no en la
 * primera subida.
 */
export function storageFromEnv(env: StorageEnv = process.env): StorageDriver {
  const value = (name: string) => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  const driver = (value('STORAGE_DRIVER') ?? 'local').toLowerCase();
  if (driver === 'local') {
    const root = value('STORAGE_LOCAL_ROOT');
    return new LocalStorage(root ? { root } : {});
  }
  if (driver !== 's3' && driver !== 'r2')
    throw new InvalidConfigError(`STORAGE_DRIVER must be local, s3 or r2 (got "${driver}")`);

  const bucket = value('S3_BUCKET');
  if (!bucket) throw new InvalidConfigError(`STORAGE_DRIVER=${driver} needs S3_BUCKET`);

  let endpoint = value('S3_ENDPOINT');
  if (driver === 'r2' && !endpoint) {
    const account = value('R2_ACCOUNT_ID');
    if (!account)
      throw new InvalidConfigError('STORAGE_DRIVER=r2 needs R2_ACCOUNT_ID or S3_ENDPOINT');
    if (!/^[a-f0-9]{32}$/i.test(account))
      throw new InvalidConfigError('R2_ACCOUNT_ID must be the 32-character Cloudflare account id');
    endpoint = `https://${account}.r2.cloudflarestorage.com`;
  }
  if (endpoint && !/^https?:\/\//i.test(endpoint))
    throw new InvalidConfigError('S3_ENDPOINT must start with http:// or https://');

  const accessKeyId = value('S3_ACCESS_KEY_ID');
  const secretAccessKey = value('S3_SECRET_ACCESS_KEY');
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
    throw new InvalidConfigError('Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither');

  const pathStyle = value('S3_FORCE_PATH_STYLE');
  if (pathStyle && !TRUE.test(pathStyle) && !FALSE.test(pathStyle))
    throw new InvalidConfigError('S3_FORCE_PATH_STYLE must be true or false');

  const expires = value('S3_SIGNED_URL_EXPIRES');
  const expiresIn = expires === undefined ? undefined : Number(expires);
  if (expiresIn !== undefined && !(Number.isInteger(expiresIn) && expiresIn > 0))
    throw new InvalidConfigError('S3_SIGNED_URL_EXPIRES must be a positive number of seconds');

  return new S3Storage({
    bucket,
    region: value('S3_REGION') ?? (driver === 'r2' ? 'auto' : undefined),
    endpoint,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    ...(pathStyle ? { forcePathStyle: TRUE.test(pathStyle) } : {}),
    keyPrefix: value('S3_PREFIX'),
    publicUrl: value('S3_PUBLIC_URL'),
    ...(expiresIn ? { signedUrlExpiresInSeconds: expiresIn } : {}),
  });
}
