import { insertReturningId, type CentralAccess } from '@tenancy-node/db';
import { AdminHttpError } from '../http.js';
import { hashPassword } from './passwords.js';
import { ROLES, type Role } from './permissions.js';

export interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

interface Row {
  id: number | string;
  email: string;
  name: string;
  role: string;
  is_active: boolean | number;
  password_hash: string;
  two_factor_secret_encrypted: string | null;
  last_login_at: Date | string | null;
  created_at: Date | string;
}

export function toUser(row: Row): AdminUser {
  return {
    id: Number(row.id),
    email: row.email,
    name: row.name,
    role: row.role as Role,
    isActive: row.is_active === true || row.is_active === 1,
    twoFactorEnabled: row.two_factor_secret_encrypted !== null,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null,
    createdAt: new Date(row.created_at),
  };
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Usuarios del panel (tabla `tenancy_admin_users`). */
export class AdminUsers {
  constructor(private readonly central: CentralAccess) {}

  private get db() {
    return this.central.db;
  }

  async findRowByEmail(email: string): Promise<Row | undefined> {
    return (await this.db
      .selectFrom('admin_users')
      .selectAll()
      .where('email', '=', normalizeEmail(email))
      .executeTakeFirst()) as Row | undefined;
  }

  async findRow(id: number): Promise<Row | undefined> {
    return (await this.db
      .selectFrom('admin_users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()) as Row | undefined;
  }

  async get(id: number): Promise<AdminUser> {
    const row = await this.findRow(id);
    if (!row) throw new AdminHttpError(404, 'ADMIN_USER_NOT_FOUND', `Admin user ${id} not found`);
    return toUser(row);
  }

  async list(): Promise<AdminUser[]> {
    return (
      (await this.db.selectFrom('admin_users').selectAll().orderBy('id').execute()) as Row[]
    ).map(toUser);
  }

  async create(input: {
    email: string;
    name: string;
    password: string;
    role: Role;
  }): Promise<AdminUser> {
    if (!ROLES.includes(input.role))
      throw new AdminHttpError(422, 'ADMIN_INVALID_ROLE', `Unknown role ${input.role}`);
    const now = new Date();
    const values = {
      email: normalizeEmail(input.email),
      name: input.name.trim(),
      password_hash: await hashPassword(input.password),
      role: input.role,
      is_active: true,
      created_at: now,
      updated_at: now,
    };
    try {
      return this.get(await insertReturningId(this.central.kind, this.db.insertInto('admin_users').values(values)));
    } catch (error) {
      if (this.central.driver.isUniqueViolation(error))
        throw new AdminHttpError(
          409,
          'ADMIN_USER_EXISTS',
          `An admin user with email ${values.email} already exists`,
        );
      throw error;
    }
  }

  async update(
    id: number,
    changes: { name?: string; role?: Role; isActive?: boolean },
  ): Promise<AdminUser> {
    await this.get(id);
    await this.db
      .updateTable('admin_users')
      .set({
        ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
        ...(changes.role !== undefined ? { role: changes.role } : {}),
        ...(changes.isActive !== undefined ? { is_active: changes.isActive } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    return this.get(id);
  }

  async setPassword(id: number, password: string): Promise<void> {
    await this.db
      .updateTable('admin_users')
      .set({ password_hash: await hashPassword(password), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async setTwoFactor(id: number, secretEncrypted: string | null): Promise<void> {
    await this.db
      .updateTable('admin_users')
      .set({ two_factor_secret_encrypted: secretEncrypted, updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async touchLogin(id: number): Promise<void> {
    await this.db
      .updateTable('admin_users')
      .set({ last_login_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async delete(id: number): Promise<void> {
    await this.db.deleteFrom('admin_users').where('id', '=', id).execute();
  }

  async activeOwners(): Promise<number> {
    const row = await this.db
      .selectFrom('admin_users')
      .select((eb) => eb.fn.countAll<number | string>().as('n'))
      .where('role', '=', 'owner')
      .where('is_active', '=', true)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }
}
