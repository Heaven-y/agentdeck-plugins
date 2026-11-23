import { lstat, mkdir, readFile, rename, rmdir, readdir } from 'node:fs/promises';
import path from 'node:path';
async function ordinary(file: string, directory = false) {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())))
    throw new Error('旧数据路径无效');
  return info;
}
/** 升级时逐文件迁入；已经迁入的文件不再复制，用户 known_hosts 继续使用原文件。 */
export async function migrateData(hostDataDir: string, dataDir: string) {
  const source = path.resolve(hostDataDir),
    target = path.resolve(dataDir);
  if (source === target || !path.isAbsolute(hostDataDir) || !path.isAbsolute(dataDir)) throw new Error('数据目录无效');
  await ordinary(source, true);
  await ordinary(target, true);
  await ordinary(path.join(target, 'credentials'), true);
  const files: Array<[string, string]> = [];
  const servers = path.join(source, 'servers.json');
  if (await ordinary(servers)) files.push([servers, path.join(target, 'servers.json')]);
  const credentials = path.join(source, 'credentials');
  if (await ordinary(credentials, true)) {
    for (const name of await readdir(credentials)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(credentials, name);
      await ordinary(file);
      files.push([file, path.join(target, 'credentials', name)]);
    }
  }
  // 先核对全部目标，避免覆盖已有档案；中途终止后下次从剩余源文件继续。
  for (const [old, next] of files)
    if (await ordinary(next)) {
      if (!(await readFile(old)).equals(await readFile(next))) throw new Error('插件与旧版存在不同的服务器数据');
    }
  for (const [old, next] of files) {
    await mkdir(path.dirname(next), { recursive: true, mode: 0o700 });
    if (await ordinary(next)) {
      // 等价副本只保留插件目录内的一份。
      const { unlink } = await import('node:fs/promises');
      await unlink(old);
    } else await rename(old, next);
  }
  if (await ordinary(credentials, true)) if ((await readdir(credentials)).length === 0) await rmdir(credentials);
}
