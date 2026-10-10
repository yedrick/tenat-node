# @tenancy-node/storage-s3

S3-compatible storage (AWS, R2, Spaces, MinIO, SeaweedFS) for tenancy-node

Parte de [tenancy-node](https://github.com/yedrick/tenat-node): multi-tenancy para Node.js con arquitectura hexagonal y observabilidad por tenant.

## Instalación

```sh
npm install @tenancy-node/storage-s3 @tenancy-node/core
```

Requiere Node.js 20 o superior. Funciona con ESM y CommonJS, e incluye los tipos de TypeScript.

## Uso

```ts
import { createTenancy } from '@tenancy-node/core';
import { s3, storageFromEnv } from '@tenancy-node/storage-s3';

createTenancy({ storage: s3({ bucket: 'mi-app', publicUrl: 'https://cdn.tuapp.com' }) });

// O desde el .env: STORAGE_DRIVER=local | s3 | r2, S3_BUCKET, R2_ACCOUNT_ID, S3_ENDPOINT...
createTenancy({ storage: storageFromEnv() });
```

## Documentación

Guías y referencia en https://yedrick.github.io/tenat-node/.

## Licencia

MIT
