import { describe, expect, it } from 'vitest';
import {
  DomainName,
  HexColor,
  InvalidColorError,
  InvalidDomainError,
  InvalidTenantDataError,
  InvalidTenantIdError,
  InvalidTenantStatusTransitionError,
  InvalidThemeError,
  Tenant,
  TenantId,
  TenancyError,
  Theme,
  canTransition,
  isTenantStatus,
} from '../src/index.js';

const now = new Date('2026-01-01T00:00:00.000Z');

describe('TenantId', () => {
  it.each(['bolivar', 'ab', 'club-1', 'a_b', '9lives', 'a'.repeat(40)])('accepts %s', (id) => {
    expect(TenantId.create(id).value).toBe(id);
  });

  it.each(['a', '', 'Bolivar', '-abc', '_abc', 'a b', 'a;drop', 'ñandu', 'a'.repeat(41), 'x`y'])(
    'rejects %j',
    (id) => {
      expect(() => TenantId.create(id)).toThrow(InvalidTenantIdError);
      expect(TenantId.tryCreate(id)).toBeUndefined();
    },
  );

  it('compares and serializes', () => {
    expect(TenantId.create('abc').equals(TenantId.create('abc'))).toBe(true);
    expect(JSON.stringify({ id: TenantId.create('abc') })).toBe('{"id":"abc"}');
    expect(String(TenantId.create('abc'))).toBe('abc');
    expect(TenantId.tryCreate(undefined)).toBeUndefined();
  });

  it('errors carry a stable code', () => {
    try {
      TenantId.create('X');
    } catch (error) {
      expect(error).toBeInstanceOf(TenancyError);
      expect((error as TenancyError).code).toBe('TENANCY_INVALID_TENANT_ID');
      expect((error as TenancyError).name).toBe('InvalidTenantIdError');
    }
  });
});

describe('DomainName', () => {
  it('normalizes case and trailing dot', () => {
    expect(DomainName.create(' Bolivar.TuApp.com. ').value).toBe('bolivar.tuapp.com');
  });

  it.each(['', 'a..b', '-a.com', 'a-.com', 'a b.com', 'x'.repeat(64) + '.com', 'bad_domain.com'])(
    'rejects %j',
    (value) => {
      expect(() => DomainName.create(value)).toThrow(InvalidDomainError);
      expect(DomainName.tryCreate(value)).toBeUndefined();
    },
  );

  it('knows its first label and parents', () => {
    const d = DomainName.create('bolivar.tuapp.com');
    expect(d.firstLabel).toBe('bolivar');
    expect(d.isWithin(DomainName.create('tuapp.com'))).toBe(true);
    expect(d.isWithin(DomainName.create('app.com'))).toBe(false);
    expect(d.equals(DomainName.create('BOLIVAR.tuapp.com'))).toBe(true);
    expect(JSON.stringify(d)).toBe('"bolivar.tuapp.com"');
    expect(DomainName.tryCreate(null)).toBeUndefined();
    expect(String(d)).toBe('bolivar.tuapp.com');
  });
});

describe('HexColor', () => {
  it('accepts hex colors and uppercases them', () => {
    expect(HexColor.create('#e4002b').value).toBe('#E4002B');
    expect(HexColor.create('#fff').value).toBe('#FFF');
    expect(HexColor.create('#ffffff80').toString()).toBe('#FFFFFF80');
    expect(HexColor.create('#abc').equals(HexColor.create('#ABC'))).toBe(true);
    expect(JSON.stringify(HexColor.create('#abc'))).toBe('"#ABC"');
  });

  it.each(['red', '#ggg', 'e4002b', '#12345', '#fff;}body{', 'url(x)'])('rejects %j', (value) => {
    expect(() => HexColor.create(value)).toThrow(InvalidColorError);
  });
});

describe('Theme', () => {
  const base = { primary: '#E4002B', secondary: '#FFD100' };

  it('creates, serializes and merges', () => {
    const theme = Theme.create({
      ...base,
      font: 'Inter',
      radius: 'md',
      mode: 'dark',
      custom: { 'nav-height': '64px' },
    });
    expect(theme.toJSON()).toEqual({
      ...base,
      font: 'Inter',
      radius: 'md',
      mode: 'dark',
      custom: { 'nav-height': '64px' },
    });
    const merged = theme.merge({ primary: '#000', font: null, accent: '#111' });
    expect(merged.toJSON()).toMatchObject({ primary: '#000', accent: '#111' });
    expect(merged.font).toBeUndefined();
    expect(theme.primary.value).toBe('#E4002B');
    expect(theme.equals(Theme.create(theme.toJSON()))).toBe(true);
  });

  it('includes every optional field', () => {
    const full = {
      ...base,
      accent: '#111111',
      background: '#FFFFFF',
      text: '#000000',
      logo: 'logos/logo.png',
      favicon: 'https://cdn.example.com/f.ico',
    };
    expect(Theme.create(full).toJSON()).toEqual(full);
  });

  it.each([
    [{ font: 'Inter; } body { display:none' }, 'font'],
    [{ logo: 'x" onerror="alert(1)' }, 'logo'],
    [{ radius: 'xl' }, 'radius'],
    [{ mode: 'neon' }, 'mode'],
    [{ custom: { Bad: '1' } }, 'custom.Bad'],
    [{ custom: { ok: 'red; } body {' } }, 'custom.ok'],
    [{ custom: { ok: 'url(https://evil)' } }, 'custom.ok'],
    [{ custom: { ok: '1 /* x */' } }, 'custom.ok'],
    [{ custom: [] }, 'custom'],
    [
      { custom: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`v${i}`, '1'])) },
      'custom',
    ],
  ])('rejects unsafe input %j', (patch, field) => {
    try {
      Theme.create({ ...base, ...(patch as object) });
      expect.fail('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidThemeError);
      expect((error as InvalidThemeError).field).toBe(field);
    }
  });

  it('rejects invalid colors', () => {
    expect(() => Theme.create({ ...base, accent: 'blue' })).toThrow(InvalidColorError);
  });
});

describe('Tenant', () => {
  const create = () =>
    Tenant.create({ id: TenantId.create('bolivar'), name: ' Club Bolívar ', now });

  it('starts provisioning with trimmed name', () => {
    const t = create();
    expect(t.status).toBe('provisioning');
    expect(t.name).toBe('Club Bolívar');
    expect(t.isActive).toBe(false);
    expect(t.createdAt).toEqual(now);
  });

  it('follows the status lifecycle', () => {
    const t = create();
    const later = new Date('2026-02-01T00:00:00.000Z');
    t.markProvisioned(later);
    expect(t.isActive).toBe(true);
    expect(t.provisionedAt).toEqual(later);
    t.putInMaintenance('Back soon', later);
    expect(t.status).toBe('maintenance');
    expect(t.maintenanceMessage).toBe('Back soon');
    t.suspend(later);
    expect(t.suspendedAt).toEqual(later);
    t.activate(later);
    expect(t.suspendedAt).toBeNull();
    expect(t.maintenanceMessage).toBeNull();
    t.markDeleting(later);
    t.markDeleted(later);
    expect(t.isDeleted).toBe(true);
    expect(t.updatedAt).toEqual(later);
  });

  it('rejects invalid transitions', () => {
    const t = create();
    expect(() => t.suspend(now)).toThrow(InvalidTenantStatusTransitionError);
    expect(() => t.markDeleted(now)).toThrow(InvalidTenantStatusTransitionError);
    t.markFailed(now);
    t.markProvisioning(now);
    t.markDeleting(now);
    t.markDeleted(now);
    expect(() => t.activate(now)).toThrow(InvalidTenantStatusTransitionError);
  });

  it('updates fields, merging data and reporting changes', () => {
    const t = Tenant.create({
      id: TenantId.create('bolivar'),
      name: 'B',
      now,
      data: { a: 1, b: 2 },
    });
    const later = new Date('2026-03-01T00:00:00.000Z');
    expect(t.update({ name: 'B', plan: null }, later)).toEqual([]);
    expect(t.updatedAt).toEqual(now);
    expect(t.update({ name: 'New', plan: 'pro', data: { b: undefined, c: 3 } }, later)).toEqual([
      'name',
      'plan',
      'data',
    ]);
    expect(t.data).toEqual({ a: 1, c: 3 });
    expect(t.plan).toBe('pro');
    expect(t.updatedAt).toEqual(later);
  });

  it('validates name, plan and data', () => {
    expect(() => Tenant.create({ id: TenantId.create('ab'), name: '  ', now })).toThrow(
      InvalidTenantDataError,
    );
    expect(() => Tenant.create({ id: TenantId.create('ab'), name: 'x'.repeat(151), now })).toThrow(
      InvalidTenantDataError,
    );
    expect(() => Tenant.create({ id: TenantId.create('ab'), name: 'x', plan: '', now })).toThrow(
      InvalidTenantDataError,
    );
    expect(() =>
      Tenant.create({
        id: TenantId.create('ab'),
        name: 'x',
        data: [] as unknown as Record<string, unknown>,
        now,
      }),
    ).toThrow(InvalidTenantDataError);
    expect(() =>
      Tenant.create({ id: TenantId.create('ab'), name: 'x', data: { f: () => 1 }, now }),
    ).toThrow(InvalidTenantDataError);
  });

  it('round-trips through snapshots without sharing data', () => {
    const t = Tenant.create({
      id: TenantId.create('bolivar'),
      name: 'B',
      now,
      data: { nested: { x: 1 } },
      theme: Theme.create({ primary: '#000', secondary: '#fff' }),
    });
    const snapshot = t.toSnapshot();
    const restored = Tenant.restore(snapshot);
    (snapshot.data.nested as { x: number }).x = 2;
    expect(restored.data).toEqual({ nested: { x: 1 } });
    expect(restored.theme?.primary.value).toBe('#000');
    t.changeTheme(null, now);
    expect(t.theme).toBeNull();
  });
});

describe('TenantStatus', () => {
  it('knows valid statuses and transitions', () => {
    expect(isTenantStatus('active')).toBe(true);
    expect(isTenantStatus('gone')).toBe(false);
    expect(canTransition('active', 'suspended')).toBe(true);
    expect(canTransition('deleting', 'active')).toBe(false);
  });
});
