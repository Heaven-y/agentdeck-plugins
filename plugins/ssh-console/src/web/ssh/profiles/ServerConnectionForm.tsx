import type { ManagedServer } from '../../../shared/index';
import { buttonClass } from '../../ui/styles';
import { HostKeyConfirmation } from '../credentials/HostKeyConfirmation';
import { SshPasswordField } from '../credentials/SshPasswordField';
import { useSshConnection } from '../use-ssh-connection';

const PHASES = {
  idle: '尚未连接',
  connecting: '正在验证服务器认证…',
  verified: '服务器已连接',
  error: 'SSH 操作失败',
  disconnecting: '正在断开 SSH…',
  disconnected: 'SSH 已断开，自动连接已暂停',
  updating: '正在取消保存密码…',
} as const;
function needsPasswordInput(server: ManagedServer, connection: ReturnType<typeof useSshConnection>) {
  return server.authMode === 'password' && !connection.hasPassword && !connection.saved && !connection.reusablePassword;
}
function SavedConnectionHint({
  name,
  requested,
  connected,
}: {
  name: string;
  requested?: boolean;
  connected: boolean;
}) {
  if (!requested || connected) return null;
  return (
    <p role="status" className="rounded border border-accent/40 bg-accent/5 p-3 text-sm leading-6">
      已保存“{name}”，可以测试连接。
    </p>
  );
}
export function ServerConnectionForm({
  server,
  connectAfterSave,
}: {
  server: ManagedServer;
  connectAfterSave?: boolean;
}) {
  const connection = useSshConnection({ sshHost: server.alias, authMode: server.authMode });
  const needsPassword = needsPasswordInput(server, connection);
  return (
    <section aria-label="服务器认证与连接" className="space-y-4">
      <SavedConnectionHint name={server.name} requested={connectAfterSave} connected={connection.verified} />
      <p role={connection.phase === 'error' ? 'alert' : 'status'} className="text-sm leading-6">
        {connection.message ?? PHASES[connection.phase]}
      </p>
      <HostKeyConfirmation
        sshHost={server.alias}
        disabled={connection.busy}
        onChecking={connection.reset}
        onTrusted={connection.reset}
      />
      <form
        aria-label="连接服务器"
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void connection.connect();
        }}
      >
        {server.authMode === 'password' ? (
          <SshPasswordField connection={connection} disabled={connection.busy} autoFocus={connectAfterSave} />
        ) : (
          <p className="text-sm text-muted-foreground">使用服务器档案指定的私钥或本机默认私钥。</p>
        )}
        {connection.reusablePassword && (
          <p className="text-xs text-muted-foreground">可复用本次连接的临时密码，留空即可。</p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className={buttonClass('primary')}
            disabled={connection.busy || connection.loadingCredentials || needsPassword}
          >
            {connection.busy ? '正在处理…' : '连接服务器'}
          </button>
          <button
            type="button"
            className={buttonClass('danger')}
            disabled={connection.busy || connection.phase === 'disconnected'}
            onClick={() => void connection.disconnect()}
          >
            断开服务器
          </button>
        </div>
      </form>
      <p className="text-xs leading-5 text-muted-foreground">断开服务器会结束该服务器的所有终端。</p>
    </section>
  );
}
