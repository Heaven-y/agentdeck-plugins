import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { migrateData } from '../../src/server/migrate';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-migration-'));
  roots.push(root);
  const old = path.join(root, 'host');
  const next = path.join(root, 'plugin');
  await mkdir(path.join(old, 'credentials'), { recursive: true });
  await writeFile(path.join(old, 'servers.json'), '[]\n');
  const name = 'a'.repeat(64) + '.json';
  await writeFile(path.join(old, 'credentials', name), 'synthetic-encrypted-record');
  return { old, next, name };
}
it('迁入档案和原密文，源文件移除，重试不创建副本', async () => {
  const f = await fixture();
  await migrateData(f.old, f.next);
  await migrateData(f.old, f.next);
  expect(await readFile(path.join(f.next, 'servers.json'), 'utf8')).toBe('[]\n');
  expect(await readFile(path.join(f.next, 'credentials', f.name), 'utf8')).toBe('synthetic-encrypted-record');
  await expect(readFile(path.join(f.old, 'servers.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(f.old, 'credentials', f.name))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('已有数据不同时保留两边原件并停止迁移', async () => {
  const f = await fixture();
  await mkdir(f.next);
  await writeFile(path.join(f.next, 'servers.json'), '["new"]');
  await expect(migrateData(f.old, f.next)).rejects.toThrow('不同');
  expect(await readFile(path.join(f.old, 'servers.json'), 'utf8')).toBe('[]\n');
  expect(await readFile(path.join(f.next, 'servers.json'), 'utf8')).toBe('["new"]');
});
