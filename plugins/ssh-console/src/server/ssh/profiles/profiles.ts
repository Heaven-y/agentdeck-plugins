import type { ManagedServer } from '../../../shared/index';
import type { SshPool } from '../transport/pool';
import { ServerTargetsError, serverDestination, type ServerTargets } from './targets';

type Deps = {
  targets: ServerTargets;
  pool: Pick<SshPool, 'disconnect' | 'forgetServerCredentials' | 'readServerPassword' | 'commitServerEdit'>;
};
export type ServerProfileEdit = { input: unknown; expected: ManagedServer; revision: string; password?: string | null };
function editedPassword(current: ManagedServer, next: ManagedServer, password?: string | null) {
  if (password !== undefined || next.authMode !== 'password') return password;
  // 新目标不继承旧输入，也不自动捡起该目的地以前遗留的保存项。
  const changed = current.authMode !== next.authMode || serverDestination(current) !== serverDestination(next);
  return changed ? null : undefined;
}
/** 服务器档案写队列；服务器独立于项目，是否可改只看档案共享状态与凭证。 */
export function createServerProfiles(deps: Deps) {
  return {
    list: deps.targets.list,
    save: deps.targets.save,
    importOptions: () => deps.targets.importOptions(),
    readPassword(alias: string, expected: ManagedServer, stillCurrent: () => boolean = () => true) {
      return deps.targets.withExpected(alias, expected, (current) =>
        deps.pool.readServerPassword(current, stillCurrent),
      );
    },
    createWithPassword(input: unknown, password: string, stillCurrent: () => boolean = () => true) {
      return deps.targets.save(input, (next, commit) =>
        deps.pool.commitServerEdit({ next, password, stillCurrent, commit }),
      );
    },
    edit(alias: string, edit: ServerProfileEdit, stillCurrent: () => boolean = () => true) {
      return deps.targets.update(alias, edit.input, edit.expected, {
        commit: (current, next, commit) =>
          deps.pool.commitServerEdit({
            next,
            expected: { server: current, revision: edit.revision },
            password: editedPassword(current, next, edit.password),
            stillCurrent,
            commit,
          }),
      });
    },
    update(alias: string, input: unknown, expected: ManagedServer) {
      return deps.targets.update(alias, input, expected, () => {
        // 写盘前失效连接，阻止旧请求跨过提交点；写盘失败也要求重新连接。
        deps.pool.disconnect(alias);
        return Promise.resolve();
      });
    },
    remove(alias: string, expected: ManagedServer) {
      return deps.targets.remove(alias, expected, (current) => deps.pool.forgetServerCredentials(current));
    },
    /** 认证/断开期间只校验档案仍存在；普通连接测试只复用连接，不终止它。 */
    connection<T>(alias: string, _changing: boolean, operation: () => Promise<T>) {
      return (async () => {
        if (!(await deps.targets.get(alias))) throw new ServerTargetsError('target_missing');
        return operation();
      })();
    },
  };
}
export type ServerProfiles = ReturnType<typeof createServerProfiles>;
