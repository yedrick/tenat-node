import { writeFileSync } from 'node:fs';
import os from 'node:os';

/** Datos de la máquina: los números solo se comparan entre corridas en el mismo equipo. */
export function machine() {
  return {
    cpu: os.cpus()[0]?.model.trim(),
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    date: new Date().toISOString(),
  };
}

export function save(name: string, data: unknown): void {
  const file = new URL(`../results/${name}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify({ machine: machine(), ...(data as object) }, null, 2) + '\n');
  console.log(`\nresultados en bench/results/${name}.json`);
}
