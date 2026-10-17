import type { PlanSettingsRepository, PlatformSettingsRepository } from '@tenancy-node/core';
import { beforeEach, describe, expect, it } from 'vitest';

type Factory<T> = () => T | Promise<T>;

/** Suite que todo `PlanSettingsRepository` y `PlatformSettingsRepository` debe pasar. */
export function settingsRepositoryContract(
  name: string,
  factory: Factory<{ plans: PlanSettingsRepository; platform: PlatformSettingsRepository }>,
): void {
  describe(`Settings repositories contract: ${name}`, () => {
    let repos: { plans: PlanSettingsRepository; platform: PlatformSettingsRepository };
    const t0 = new Date('2026-10-18T10:00:00.000Z');
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

    beforeEach(async () => {
      repos = await factory();
    });

    it('saves, replaces, lists in creation order and deletes plan overrides', async () => {
      const basico = {
        planId: 'basico',
        label: 'Básico ✨',
        price: { currency: 'BOB', monthly: 199.5, yearly: null },
        features: ['agenda', 'caja'],
        limits: { usuarios: 5, sucursales: null },
        highlight: true,
        archived: false,
        createdAt: at(0),
        updatedAt: at(0),
        updatedBy: 'ana@tuapp.com',
      };
      const clinica = {
        planId: 'clinica',
        label: 'Clínica',
        description: null,
        features: '*' as const,
        public: false,
        archived: false,
        createdAt: at(5),
        updatedAt: at(5),
        updatedBy: null,
      };
      await repos.plans.save(clinica);
      await repos.plans.save(basico);
      expect(await repos.plans.list()).toEqual([basico, clinica]);
      await repos.plans.save({ ...clinica, archived: true, updatedAt: at(9), updatedBy: 'beto' });
      expect((await repos.plans.list())[1]).toEqual({
        ...clinica,
        archived: true,
        updatedAt: at(9),
        updatedBy: 'beto',
      });
      expect(await repos.plans.delete('basico')).toBe(true);
      expect(await repos.plans.delete('basico')).toBe(false);
      expect((await repos.plans.list()).map((o) => o.planId)).toEqual(['clinica']);
    });

    it('saves and replaces the platform settings', async () => {
      expect(await repos.platform.get()).toBeUndefined();
      const settings = {
        name: 'IONIX',
        logo: 'platform/logo-abc.png',
        favicon: null,
        primary: '#0F766E',
        contact: { whatsapp: '59170000000', email: 'ventas@ionix.bo' },
        salesNotifyTo: ['jefe@ionix.bo'],
      };
      await repos.platform.save(settings, { updatedAt: at(1), updatedBy: 'ana' });
      expect(await repos.platform.get()).toEqual({ settings, updatedAt: at(1), updatedBy: 'ana' });
      await repos.platform.save(
        { ...settings, name: 'IONIX Pro' },
        { updatedAt: at(2), updatedBy: null },
      );
      expect(await repos.platform.get()).toEqual({
        settings: { ...settings, name: 'IONIX Pro' },
        updatedAt: at(2),
        updatedBy: null,
      });
    });
  });
}
