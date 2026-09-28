import { InvalidTenantDataError, InvalidTenantStatusTransitionError } from '../errors/errors.js';
import { TenantId } from '../value-objects/tenant-id.js';
import { canTransition, type TenantStatus } from './tenant-status.js';
import { Theme, type ThemeProps } from './theme.js';

export type TenantData = Record<string, unknown>;

/** Dónde vive la base de datos del tenant. La asigna el aprovisionamiento. */
export interface TenantDatabase {
  /** Servidor de base de datos ('default', 'mysql-2'). */
  serverId: string;
  /** Nombre de la base ('tenant_bolivar'). */
  name: string;
  /** Schema, solo en PostgreSQL modo schema. */
  schema: string | null;
  /** Usuario propio del tenant; `null` = credenciales compartidas. */
  username: string | null;
  /** Contraseña cifrada (AES-256-GCM); nunca en texto plano. */
  passwordEncrypted: string | null;
}

/** Estado completo y serializable de un tenant. Lo usan los repositorios. */
export interface TenantSnapshot {
  id: string;
  name: string;
  status: TenantStatus;
  plan: string | null;
  data: TenantData;
  theme: ThemeProps | null;
  database: TenantDatabase | null;
  maintenanceMessage: string | null;
  provisionedAt: Date | null;
  suspendedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CreateTenantProps {
  id: TenantId;
  name: string;
  plan?: string | null;
  data?: TenantData;
  theme?: Theme | null;
  now: Date;
}

export interface TenantChanges {
  name?: string;
  plan?: string | null;
  /** Se combina (merge superficial) con los datos actuales. `undefined` en una llave la elimina. */
  data?: TenantData;
}

const MAX_NAME_LENGTH = 150;
const MAX_PLAN_LENGTH = 50;

/** Un tenant: un cliente de la aplicación con sus propios recursos aislados. */
export class Tenant {
  private constructor(
    readonly id: TenantId,
    private _name: string,
    private _status: TenantStatus,
    private _plan: string | null,
    private _data: TenantData,
    private _theme: Theme | null,
    private _database: TenantDatabase | null,
    private _maintenanceMessage: string | null,
    private _provisionedAt: Date | null,
    private _suspendedAt: Date | null,
    readonly createdAt: Date,
    private _updatedAt: Date,
    private _deletedAt: Date | null,
  ) {}

  /** Crea un tenant nuevo en estado `provisioning`. */
  static create(props: CreateTenantProps): Tenant {
    return new Tenant(
      props.id,
      validateName(props.name),
      'provisioning',
      validatePlan(props.plan ?? null),
      validateData(props.data ?? {}),
      props.theme ?? null,
      null,
      null,
      null,
      null,
      props.now,
      props.now,
      null,
    );
  }

  /** Reconstruye un tenant guardado. */
  static restore(snapshot: TenantSnapshot): Tenant {
    return new Tenant(
      TenantId.create(snapshot.id),
      snapshot.name,
      snapshot.status,
      snapshot.plan,
      structuredClone(snapshot.data),
      snapshot.theme ? Theme.create(snapshot.theme) : null,
      snapshot.database ? { ...snapshot.database } : null,
      snapshot.maintenanceMessage,
      snapshot.provisionedAt,
      snapshot.suspendedAt,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.deletedAt,
    );
  }

  get name(): string {
    return this._name;
  }
  get status(): TenantStatus {
    return this._status;
  }
  get plan(): string | null {
    return this._plan;
  }
  get data(): Readonly<TenantData> {
    return this._data;
  }
  get theme(): Theme | null {
    return this._theme;
  }
  get database(): Readonly<TenantDatabase> | null {
    return this._database;
  }
  get maintenanceMessage(): string | null {
    return this._maintenanceMessage;
  }
  get provisionedAt(): Date | null {
    return this._provisionedAt;
  }
  get suspendedAt(): Date | null {
    return this._suspendedAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
  get deletedAt(): Date | null {
    return this._deletedAt;
  }
  get isActive(): boolean {
    return this._status === 'active' && this._deletedAt === null;
  }
  get isDeleted(): boolean {
    return this._deletedAt !== null;
  }

  /** Aplica cambios de datos. Devuelve la lista de campos que cambiaron. */
  update(changes: TenantChanges, now: Date): string[] {
    const changed: string[] = [];
    if (changes.name !== undefined && changes.name !== this._name) {
      this._name = validateName(changes.name);
      changed.push('name');
    }
    if (changes.plan !== undefined && changes.plan !== this._plan) {
      this._plan = validatePlan(changes.plan);
      changed.push('plan');
    }
    if (changes.data !== undefined) {
      const merged: TenantData = { ...this._data };
      for (const [key, value] of Object.entries(changes.data)) {
        if (value === undefined) delete merged[key];
        else merged[key] = value;
      }
      this._data = validateData(merged);
      changed.push('data');
    }
    if (changed.length > 0) this.touch(now);
    return changed;
  }

  changeTheme(theme: Theme | null, now: Date): void {
    this._theme = theme;
    this.touch(now);
  }

  /** Registra en qué servidor y base quedó el tenant. */
  assignDatabase(database: TenantDatabase, now: Date): void {
    this._database = { ...database };
    this.touch(now);
  }

  markProvisioning(now: Date): void {
    this.transition('provisioning', now);
  }

  markProvisioned(now: Date): void {
    this.transition('active', now);
    this._provisionedAt = now;
  }

  markFailed(now: Date): void {
    this.transition('failed', now);
  }

  activate(now: Date): void {
    this.transition('active', now);
    this._suspendedAt = null;
    this._maintenanceMessage = null;
  }

  suspend(now: Date): void {
    this.transition('suspended', now);
    this._suspendedAt = now;
  }

  putInMaintenance(message: string | null, now: Date): void {
    this.transition('maintenance', now);
    this._maintenanceMessage = message;
  }

  markDeleting(now: Date): void {
    this.transition('deleting', now);
  }

  markDeleted(now: Date): void {
    if (this._status !== 'deleting') {
      throw new InvalidTenantStatusTransitionError(this.id.value, this._status, 'deleted');
    }
    this._deletedAt = now;
    this.touch(now);
  }

  toSnapshot(): TenantSnapshot {
    return {
      id: this.id.value,
      name: this._name,
      status: this._status,
      plan: this._plan,
      data: structuredClone(this._data),
      theme: this._theme ? this._theme.toJSON() : null,
      database: this._database ? { ...this._database } : null,
      maintenanceMessage: this._maintenanceMessage,
      provisionedAt: this._provisionedAt,
      suspendedAt: this._suspendedAt,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
      deletedAt: this._deletedAt,
    };
  }

  private transition(to: TenantStatus, now: Date): void {
    if (this._deletedAt !== null || !canTransition(this._status, to)) {
      throw new InvalidTenantStatusTransitionError(this.id.value, this._status, to);
    }
    this._status = to;
    this.touch(now);
  }

  private touch(now: Date): void {
    this._updatedAt = now;
  }
}

function validateName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    throw new InvalidTenantDataError(
      'name',
      `must have between 1 and ${MAX_NAME_LENGTH} characters`,
    );
  }
  return trimmed;
}

function validatePlan(plan: string | null): string | null {
  if (plan === null) return null;
  if (typeof plan !== 'string' || plan.length === 0 || plan.length > MAX_PLAN_LENGTH) {
    throw new InvalidTenantDataError(
      'plan',
      `must have between 1 and ${MAX_PLAN_LENGTH} characters`,
    );
  }
  return plan;
}

function validateData(data: TenantData): TenantData {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new InvalidTenantDataError('data', 'must be a plain object');
  }
  try {
    return structuredClone(data);
  } catch {
    throw new InvalidTenantDataError('data', 'must be serializable');
  }
}
