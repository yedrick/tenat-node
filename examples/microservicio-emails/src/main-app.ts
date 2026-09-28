// pnpm --filter example-microservicio-emails app -- bolivar "Club Bolívar" dueño@bolivar.bo
import { createApp } from './app.js';

const [id = 'bolivar', name = 'Club Bolívar', ownerEmail = 'admin@bolivar.bo'] =
  process.argv.slice(2);
const tenancy = createApp({
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:secret@127.0.0.1:5432/app',
  rabbitUrl: process.env.RABBIT_URL ?? 'amqp://guest:guest@127.0.0.1:5672',
});
await tenancy.database.install();
await tenancy.tenants.create({ id, name, data: { ownerEmail } });
console.log(`tenant ${id} creado; publicando eventos de la outbox...`);
console.log(await tenancy.outbox.relayOnce());
await tenancy.close();
