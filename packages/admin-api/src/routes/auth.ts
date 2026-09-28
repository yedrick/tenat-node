import * as v from 'valibot';
import { EncryptionKeyMissingError } from '@tenancy-node/db';
import { dummyVerify, verifyPassword } from '../auth/passwords.js';
import { permissionsOf } from '../auth/permissions.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { normalizeEmail, toUser } from '../auth/users.js';
import type { AdminContext } from '../context.js';
import { AdminHttpError, route, type AdminRequest } from '../http.js';

const LoginBody = v.object({
  email: v.pipe(v.string(), v.email(), v.maxLength(191)),
  password: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  /** Código de 6 dígitos de la app de autenticación (si el usuario tiene 2FA). */
  code: v.optional(v.pipe(v.string(), v.regex(/^\d{6}$/))),
  /** `cookie` (panel web, por defecto) o `token` (automatización: se usa como `Authorization: Bearer`). */
  mode: v.optional(v.picklist(['cookie', 'token']), 'cookie'),
});

export function cookie(ctx: AdminContext, value: string, maxAgeSeconds: number): string {
  const path = ctx.options.prefix.replace(/\/api$/, '') || '/';
  return [
    `${ctx.options.cookieName}=${value}`,
    'HttpOnly',
    'SameSite=Strict',
    `Path=${path}`,
    `Max-Age=${maxAgeSeconds}`,
    ...(ctx.options.secureCookies ? ['Secure'] : []),
  ].join('; ');
}

function currentUser(request: AdminRequest) {
  if (!request.user) throw new AdminHttpError(401, 'ADMIN_UNAUTHENTICATED', 'Login required');
  return request.user;
}

export function authRoutes(ctx: AdminContext) {
  return [
    route({
      method: 'POST',
      path: '/auth/login',
      permission: null,
      tag: 'auth',
      summary: 'Inicia sesión (cookie para el panel o token Bearer para automatizar)',
      body: LoginBody,
      async handler(request) {
        const { email, password, code, mode } = request.body;
        const keys = [`ip:${request.ip ?? '?'}`, `email:${normalizeEmail(email)}`];
        if (keys.some((k) => !ctx.limiter.allowed(k))) {
          const retryAfter = Math.max(...keys.map((k) => ctx.limiter.retryAfterSeconds(k)));
          throw new AdminHttpError(
            429,
            'ADMIN_TOO_MANY_ATTEMPTS',
            'Too many failed login attempts, try again later',
            { retryAfter },
          );
        }
        const row = await ctx.users.findRowByEmail(email);
        const valid = row
          ? await verifyPassword(row.password_hash, password)
          : await dummyVerify(password);
        const user = row ? toUser(row) : undefined;
        const fail = async (reason: string) => {
          for (const k of keys) ctx.limiter.fail(k);
          await ctx.audit.record({
            adminUserId: user?.id ?? null,
            action: 'auth.login_failed',
            changes: { email: normalizeEmail(email), reason },
            ip: request.ip,
          });
          throw new AdminHttpError(401, 'ADMIN_INVALID_CREDENTIALS', 'Invalid email or password');
        };
        if (!row || !user || !valid) return fail('credentials');
        if (!user.isActive) return fail('inactive');
        if (row.two_factor_secret_encrypted) {
          if (!code)
            throw new AdminHttpError(401, 'ADMIN_2FA_REQUIRED', 'Two-factor code required');
          if (!verifyTotp(ctx.central.encrypter.decrypt(row.two_factor_secret_encrypted), code))
            return fail('2fa');
        }
        for (const k of keys) ctx.limiter.reset(k);
        const session = await ctx.sessions.create(
          user.id,
          request.ip,
          (request.headers['user-agent'] as string | undefined) ?? null,
        );
        await ctx.users.touchLogin(user.id);
        await ctx.audit.record({
          adminUserId: user.id,
          action: 'auth.login',
          changes: { mode },
          ip: request.ip,
        });
        const body = { user, permissions: permissionsOf(user.role), expiresAt: session.expiresAt };
        if (mode === 'token') return { body: { ...body, token: session.token } };
        return {
          body: { ...body, csrfToken: ctx.sessions.csrfToken(session.id) },
          headers: {
            'set-cookie': cookie(ctx, session.token, Math.floor(ctx.options.sessionTtlMs / 1000)),
          },
        };
      },
    }),
    route({
      method: 'POST',
      path: '/auth/logout',
      permission: 'self',
      tag: 'auth',
      summary: 'Cierra la sesión actual',
      async handler(request) {
        if (request.sessionId) await ctx.sessions.destroy(request.sessionId);
        await ctx.record(request, { action: 'auth.logout' });
        return { status: 204, headers: { 'set-cookie': cookie(ctx, '', 0) } };
      },
    }),
    route({
      method: 'GET',
      path: '/auth/me',
      permission: 'self',
      tag: 'auth',
      summary: 'Usuario actual, sus permisos y el token CSRF',
      async handler(request) {
        const user = currentUser(request);
        return {
          body: {
            user,
            permissions: permissionsOf(user.role),
            csrfToken: request.sessionId ? ctx.sessions.csrfToken(request.sessionId) : null,
          },
        };
      },
    }),
    route({
      method: 'POST',
      path: '/auth/password',
      permission: 'self',
      tag: 'auth',
      summary: 'Cambia la contraseña y cierra las demás sesiones',
      body: v.object({ current: v.string(), password: v.string() }),
      async handler(request) {
        const user = currentUser(request);
        const row = (await ctx.users.findRow(user.id))!;
        if (!(await verifyPassword(row.password_hash, request.body.current))) {
          throw new AdminHttpError(
            401,
            'ADMIN_INVALID_CREDENTIALS',
            'The current password is not correct',
          );
        }
        await ctx.users.setPassword(user.id, request.body.password);
        await ctx.sessions.destroyForUser(user.id, request.sessionId ?? undefined);
        await ctx.record(request, {
          action: 'auth.password_changed',
          targetType: 'admin_user',
          targetId: user.id,
        });
        return { status: 204 };
      },
    }),
    route({
      method: 'POST',
      path: '/auth/2fa/setup',
      permission: 'self',
      tag: 'auth',
      summary: 'Genera un secreto TOTP (se activa recién con /auth/2fa/enable)',
      async handler(request) {
        const user = currentUser(request);
        // Sin llave no se podría guardar el secreto en /auth/2fa/enable: se avisa antes del QR.
        if (!ctx.central.encrypter.hasKey) throw new EncryptionKeyMissingError();
        const secret = generateTotpSecret();
        return { body: { secret, otpauthUrl: otpauthUrl(secret, user.email, ctx.options.issuer) } };
      },
    }),
    route({
      method: 'POST',
      path: '/auth/2fa/enable',
      permission: 'self',
      tag: 'auth',
      summary: 'Activa 2FA confirmando un código del secreto generado',
      body: v.object({
        secret: v.pipe(v.string(), v.regex(/^[A-Z2-7]{32}$/)),
        code: v.pipe(v.string(), v.regex(/^\d{6}$/)),
      }),
      async handler(request) {
        const user = currentUser(request);
        if (!verifyTotp(request.body.secret, request.body.code))
          throw new AdminHttpError(422, 'ADMIN_INVALID_2FA_CODE', 'The code does not match');
        await ctx.users.setTwoFactor(user.id, ctx.central.encrypter.encrypt(request.body.secret));
        await ctx.record(request, {
          action: 'auth.2fa_enabled',
          targetType: 'admin_user',
          targetId: user.id,
        });
        return { status: 204 };
      },
    }),
    route({
      method: 'POST',
      path: '/auth/2fa/disable',
      permission: 'self',
      tag: 'auth',
      summary: 'Desactiva 2FA (pide la contraseña)',
      body: v.object({ password: v.string() }),
      async handler(request) {
        const user = currentUser(request);
        const row = (await ctx.users.findRow(user.id))!;
        if (!(await verifyPassword(row.password_hash, request.body.password))) {
          throw new AdminHttpError(401, 'ADMIN_INVALID_CREDENTIALS', 'The password is not correct');
        }
        await ctx.users.setTwoFactor(user.id, null);
        await ctx.record(request, {
          action: 'auth.2fa_disabled',
          targetType: 'admin_user',
          targetId: user.id,
        });
        return { status: 204 };
      },
    }),
  ];
}
