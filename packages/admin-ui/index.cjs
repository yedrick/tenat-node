'use strict';
const path = require('node:path');

/** Carpeta con la SPA compilada (la sirve @tenancy-node/admin-api con `ui: true`). */
exports.distPath = path.join(__dirname, 'dist');
