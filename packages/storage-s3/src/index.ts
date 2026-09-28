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
import type { PutOptions, StorageDriver, StoredFile } from '@tenancy-node/core';

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
