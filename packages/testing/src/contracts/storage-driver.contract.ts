import type { StorageDriver } from '@tenancy-node/core';
import { beforeEach, describe, expect, it } from 'vitest';

type Factory<T> = () => T | Promise<T>;
const text = (data: Uint8Array | undefined) =>
  data === undefined ? undefined : Buffer.from(data).toString('utf8');

/** Suite que todo `StorageDriver` debe pasar (local, S3...). */
export function storageDriverContract(name: string, factory: Factory<StorageDriver>): void {
  describe(`StorageDriver contract: ${name}`, () => {
    let storage: StorageDriver;
    beforeEach(async () => {
      storage = await factory();
    });

    it('puts, gets, checks and deletes files (text and binary)', async () => {
      await storage.put('bolivar/docs/hola.txt', 'hola ñandú ⚽', { contentType: 'text/plain' });
      const binary = new Uint8Array([0, 1, 2, 250, 255]);
      await storage.put('bolivar/bin/data.bin', binary);
      expect(text(await storage.get('bolivar/docs/hola.txt'))).toBe('hola ñandú ⚽');
      expect([...(await storage.get('bolivar/bin/data.bin'))!]).toEqual([...binary]);
      expect(await storage.exists('bolivar/docs/hola.txt')).toBe(true);
      await storage.put('bolivar/docs/hola.txt', 'cambiado');
      expect(text(await storage.get('bolivar/docs/hola.txt'))).toBe('cambiado');
      await storage.delete('bolivar/docs/hola.txt');
      expect(await storage.exists('bolivar/docs/hola.txt')).toBe(false);
      expect(await storage.get('bolivar/docs/hola.txt')).toBeUndefined();
      await storage.delete('bolivar/docs/nunca-existio.txt');
    });

    it('lists by prefix without mixing tenants', async () => {
      await storage.put('bolivar/a.txt', '1');
      await storage.put('bolivar/sub/b.txt', '22');
      await storage.put('bolivar2/c.txt', '333');
      await storage.put('tigre/a.txt', '4444');
      const files = await storage.list('bolivar/');
      expect(files.map((f) => [f.key, f.size])).toEqual([
        ['bolivar/a.txt', 1],
        ['bolivar/sub/b.txt', 2],
      ]);
      expect(await storage.list('nadie/')).toEqual([]);
    });

    it('deletes everything under a prefix only', async () => {
      await storage.put('bolivar/a.txt', '1');
      await storage.put('bolivar/sub/b.txt', '2');
      await storage.put('bolivar2/c.txt', '3');
      await storage.deletePrefix('bolivar/');
      expect(await storage.list('bolivar/')).toEqual([]);
      expect(await storage.exists('bolivar2/c.txt')).toBe(true);
    });

    it('builds a URL for a key', async () => {
      await storage.put('bolivar/logo.png', 'x');
      expect(await storage.url('bolivar/logo.png')).toMatch(/logo\.png/);
    });
  });
}
