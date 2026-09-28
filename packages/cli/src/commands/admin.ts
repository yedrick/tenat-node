import { randomBytes } from 'node:crypto';
import { hasDatabase } from '../config-loader.js';
import {
  EXIT,
  UsageError,
  intOption,
  requirePositional,
  stringOption,
  type Command,
} from '../command.js';

async function loadAdmin() {
  try {
    return await import('@tenancy-node/admin-api');
  } catch {
    throw new UsageError('Install @tenancy-node/admin-api to use the admin commands');
  }
}

export const adminServeCommand: Command = {
  name: 'admin:serve',
  summary: 'Levanta la Admin API en su propio proceso y puerto (por defecto solo en 127.0.0.1)',
  usage: 'tenancy admin:serve [--port=4000] [--host=127.0.0.1] [--ui] [--insecure-cookies]',
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    ui: { type: 'boolean' },
    'insecure-cookies': { type: 'boolean' },
  },
  help: {
    port: 'Puerto (por defecto 4000)',
    host: 'Interfaz (por defecto 127.0.0.1: se entra por VPN o túnel SSH)',
    'insecure-cookies': 'Cookies sin Secure (solo desarrollo local por http)',
    ui: 'Servir también la interfaz del panel en /admin (requiere @tenancy-node/admin-ui)',
  },
  async run({ args, out, io, tenancy, signal }) {
    const secret = io.env.TENANCY_ADMIN_SECRET;
    if (!secret || secret.length < 32)
      throw new UsageError('Set TENANCY_ADMIN_SECRET (at least 32 characters)');
    const t = await tenancy();
    if (!hasDatabase(t))
      throw new UsageError('The admin API needs the database plugin (@tenancy-node/db)');
    const { serveAdmin } = await loadAdmin();
    const host = stringOption(args, 'host') ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      out.warn(
        `El panel queda expuesto en ${host}: asegúrate de ponerlo detrás de HTTPS y de una red privada.`,
      );
    }
    const server = await serveAdmin(t, {
      port: intOption(args, 'port', 4000, 0),
      host,
      sessionSecret: secret,
      secureCookies: args.values['insecure-cookies'] !== true,
      ui: args.values.ui === true,
      allowedHosts: [...t.centralDomains, 'localhost', '127.0.0.1', '::1', host],
    });
    out.success(`Admin API en ${server.url} (documentación: ${server.url}/openapi.json)`);
    if (server.api.uiPath) out.success(`Panel en ${server.url.replace(/\/api$/, '')}/`);
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await server.close();
    out.success('Admin API detenida');
    return EXIT.ok;
  },
};

export const adminUserCommand: Command = {
  name: 'admin:user',
  summary: 'Crea un usuario del panel (o le cambia la contraseña)',
  usage:
    'tenancy admin:user <email> [--role=owner|admin|support] [--name=..] [--password-env=VAR] [--reset-password]',
  options: {
    role: { type: 'string' },
    name: { type: 'string' },
    'password-env': { type: 'string' },
    'reset-password': { type: 'boolean' },
  },
  help: {
    role: 'Rol (por defecto owner)',
    'password-env':
      'Variable de entorno con la contraseña. Si falta, se genera una y se muestra una sola vez',
    'reset-password': 'El usuario ya existe: cambiarle la contraseña y cerrar sus sesiones',
  },
  async run({ args, out, io, tenancy }) {
    const email = requirePositional(args, 0, 'email');
    const role = stringOption(args, 'role') ?? 'owner';
    const { ROLES, AdminUsers, MIN_PASSWORD_LENGTH } = await loadAdmin();
    if (!(ROLES as readonly string[]).includes(role))
      throw new UsageError(`--role must be one of ${ROLES.join(', ')}`);
    const variable = stringOption(args, 'password-env');
    const provided = variable ? io.env[variable] : undefined;
    if (variable && provided === undefined)
      throw new UsageError(`Environment variable ${variable} is not set`);
    if (provided !== undefined && provided.length < MIN_PASSWORD_LENGTH)
      throw new UsageError(`The password must have at least ${MIN_PASSWORD_LENGTH} characters`);
    const password = provided ?? randomBytes(18).toString('base64url');

    const t = await tenancy();
    if (!hasDatabase(t))
      throw new UsageError('The admin users live in the central database: add @tenancy-node/db');
    const central = t.database.central();
    const users = new AdminUsers(central);
    if (args.values['reset-password']) {
      const row = await users.findRowByEmail(email);
      if (!row) throw new UsageError(`No admin user with email ${email}`);
      await users.setPassword(Number(row.id), password);
      await central.db
        .deleteFrom('admin_sessions')
        .where('admin_user_id', '=', Number(row.id))
        .execute();
      out.success(`contraseña de ${email} cambiada (sus sesiones se cerraron)`);
    } else {
      const user = await users.create({
        email,
        name: stringOption(args, 'name') ?? email.split('@')[0]!,
        password,
        role: role as never,
      });
      out.success(`usuario ${user.email} creado con rol ${user.role}`);
    }
    await central.db
      .insertInto('audit_log')
      .values({
        admin_user_id: null,
        action: args.values['reset-password']
          ? 'admin_user.password_reset_cli'
          : 'admin_user.create_cli',
        target_type: 'admin_user',
        target_id: email,
        changes: JSON.stringify({ role }),
        ip: null,
        created_at: new Date(),
      })
      .execute();
    if (!provided)
      out.line(
        `Contraseña generada (guárdala, no se vuelve a mostrar): ${out.paint('bold', password)}`,
      );
    out.data({ email, role, ...(provided ? {} : { password }) });
    return EXIT.ok;
  },
};
