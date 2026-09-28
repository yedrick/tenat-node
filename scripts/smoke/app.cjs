// Humo desde CommonJS: require() de los paquetes publicados.
const assert = require('node:assert/strict');
const { createTenancy, TenantId } = require('@tenancy-node/core');
const { database } = require('@tenancy-node/db');
const noop = () => {};
const logger = { debug: noop, info: noop, warn: noop, error: noop, child() { return logger; } };

(async () => {
  assert.equal(typeof database, 'function');
  assert.equal(TenantId.create('abc').value, 'abc');
  const t = createTenancy({ logger });
  const tenant = await t.tenants.create({ id: 'cjs-ok' });
  assert.equal(tenant.id.value, 'cjs-ok');
  await t.close();
  console.log('cjs ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
