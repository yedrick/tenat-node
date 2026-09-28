import type { Kysely } from 'kysely';

// Las bases de los tenants tienen el esquema de la aplicación, que el paquete no conoce.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDB = any;
export type AnyKysely = Kysely<AnyDB>;
