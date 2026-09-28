/**
 * Reglas de arquitectura (hexagonal). Las dependencias apuntan hacia adentro:
 *   domain  <-  ports  <-  application  <-  infraestructura / presentación
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment: 'El dominio no importa nada fuera del dominio (ni node:*, ni paquetes npm).',
      severity: 'error',
      from: { path: '^packages/core/src/domain/' },
      to: { pathNot: '^packages/core/src/domain/' },
    },
    {
      name: 'ports-only-domain',
      comment: 'Los puertos solo conocen el dominio.',
      severity: 'error',
      from: { path: '^packages/core/src/ports/' },
      to: { pathNot: '^packages/core/src/(domain|ports)/' },
    },
    {
      name: 'application-only-domain-and-ports',
      comment: 'Los casos de uso dependen solo del dominio y de los puertos.',
      severity: 'error',
      from: { path: '^packages/core/src/application/' },
      to: { pathNot: '^packages/core/src/(domain|ports|application)/' },
    },
    {
      name: 'core-light-dependencies',
      comment: 'El núcleo solo puede depender de builtins de Node y de valibot.',
      severity: 'error',
      from: { path: '^packages/core/src/' },
      to: {
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-no-pkg',
          'npm-unknown',
          'unknown',
        ],
        pathNot: 'node_modules/valibot/',
      },
    },
    {
      name: 'core-knows-no-plugins',
      comment: 'El núcleo no conoce a los paquetes que lo extienden.',
      severity: 'error',
      from: { path: '^packages/core/src/' },
      to: { path: '^packages/(?!core/)[^/]+/' },
    },
    {
      name: 'db-is-engine-agnostic',
      comment: '@tenancy-node/db habla con los motores solo a través del puerto DatabaseDriver.',
      severity: 'error',
      from: { path: '^packages/db/src/' },
      to: { path: 'node_modules/(mysql2|pg|pg-pool|mariadb)/' },
    },
    {
      name: 'drivers-only-through-public-api',
      comment: 'Los drivers usan la API pública de @tenancy-node/db, no sus archivos internos.',
      severity: 'error',
      from: { path: '^packages/db-[^/]+/src/' },
      to: { path: '^packages/db/src/(?!index\\.ts$)' },
    },
    {
      name: 'ui-only-talks-http',
      comment:
        'La UI del panel solo habla con la Admin API por HTTP: no importa paquetes del backend.',
      severity: 'error',
      from: { path: '^packages/admin-ui/src/' },
      to: { path: '(^packages/(?!admin-ui/)|@tenancy-node/)' },
    },
    {
      name: 'not-resolvable',
      comment: 'Todo import debe resolverse (evita que una regla se salte por un import roto).',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      comment:
        'Sin ciclos en tiempo de ejecución (los ciclos solo de tipos desaparecen al compilar).',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'no-test-imports-in-src',
      severity: 'error',
      from: { path: '^packages/[^/]+/src/' },
      to: { path: '^packages/[^/]+/test/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^packages/[^/]+/(dist|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js'],
    },
  },
};
