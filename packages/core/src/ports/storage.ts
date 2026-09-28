export interface StoredFile {
  /** Llave completa en el driver ('bolivar/logos/logo.png'). */
  key: string;
  size: number;
  lastModified: Date | null;
}

export interface PutOptions {
  contentType?: string;
}

/**
 * Almacenamiento de archivos crudo (disco local, S3, MinIO, R2...). No conoce tenants:
 * el aislamiento lo hace `TenantStorage` con el prefijo `{tenantId}/`.
 */
export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Uint8Array | string, options?: PutOptions): Promise<void>;
  /** Contenido del archivo, o `undefined` si no existe. */
  get(key: string): Promise<Uint8Array | undefined>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Archivos cuya llave empieza con `prefix`. */
  list(prefix: string): Promise<StoredFile[]>;
  /** Borra todo lo que empieza con `prefix` (por ejemplo, al eliminar un tenant). */
  deletePrefix(prefix: string): Promise<void>;
  /** URL para descargar el archivo (pública o firmada). */
  url(key: string, options?: { expiresInSeconds?: number }): Promise<string>;
  ping?(): Promise<void>;
  close?(): Promise<void>;
}
