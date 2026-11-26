import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { Engine } from '../runtime/engine';

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 只在曾实际存在的原生轨迹和脑目录同时移除后清理；摘要索引缺行不证明删除。 */
export function watchRemovedOwners(engine: Engine) {
  const absent = new Map<string, number>();
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      for (const grant of engine.store.state.grants) {
        const brain = path.dirname(path.dirname(path.dirname(grant.transcriptPath)));
        if (path.basename(brain) !== grant.owner || path.basename(path.dirname(brain)) !== 'brain') continue;
        const root = path.dirname(path.dirname(brain));
        const trajectory = path.join(root, 'conversations', `${grant.owner}.db`);
        try {
          const [record, artifacts] = await Promise.all([exists(trajectory), exists(brain)]);
          if (record && artifacts) {
            absent.delete(grant.owner);
            if (!grant.witnessedNative) {
              grant.witnessedNative = true;
              await engine.store.save();
            }
          } else if (!record && !artifacts && grant.witnessedNative && (await exists(root))) {
            const since = absent.get(grant.owner);
            if (since && Date.now() - since >= 20_000) await engine.removeOwner(grant.owner);
            else absent.set(grant.owner, Date.now());
          } else absent.delete(grant.owner);
        } catch {
          absent.delete(grant.owner);
        }
      }
    } finally {
      checking = false;
    }
  };
  void check();
  return setInterval(() => {
    void check();
  }, 30_000);
}
