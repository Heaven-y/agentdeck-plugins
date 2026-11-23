import { sshApi, sshKeys } from '../ssh/api';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus, Server } from 'lucide-react';

import { buttonClass } from '../ui/styles';
import { ConsoleServerPicker } from './navigation/ConsoleServerPicker';
import { ConsoleServerTabs } from './navigation/ConsoleTabs';
import { ConsoleServerPanel } from './navigation/ConsoleServerPanel';
import { consoleError, useConsoleVisible, type ConsoleServerTab } from './navigation/console-state';

export type SshConsolePageProps = {
  visible: boolean;
  onManageServers(): void;
};
/** 控制台以服务器为单位：打开时没有选中任何服务器，由用户从标签条或选择器决定。 */
function useConsoleNavigation() {
  const [tabs, setTabs] = useState<ConsoleServerTab[]>([]);
  const [selected, setSelected] = useState<string>();
  const open = (alias: string) => {
    setTabs((current) =>
      current.some((item) => item.serverId === alias) ? current : [...current, { serverId: alias, directory: '~' }],
    );
    setSelected(alias);
  };
  const close = (alias: string) => {
    const next = tabs.filter((item) => item.serverId !== alias);
    setTabs(next);
    if (selected === alias) setSelected(next[0]?.serverId);
  };
  return { tabs, selected, setSelected, open, close };
}

export default function SshConsolePage({ visible, onManageServers }: SshConsolePageProps) {
  const active = useConsoleVisible(visible);
  const navigation = useConsoleNavigation();
  const [picker, setPicker] = useState(false);
  const servers = useQuery({
    queryKey: sshKeys.sshHosts,
    queryFn: ({ signal }) => sshApi.listSshHosts(signal),
    enabled: active,
    staleTime: 10000,
    retry: false,
  });
  return (
    <section aria-label="SSH Console" hidden={!visible} className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <ConsoleServerTabs
          tabs={navigation.tabs}
          servers={servers.data ?? []}
          selected={navigation.selected}
          select={navigation.setSelected}
          close={navigation.close}
        />
        <button type="button" className={`${buttonClass('outline')} ml-auto shrink-0`} onClick={() => setPicker(true)}>
          <Plus aria-hidden className="size-3.5" />
          连接其他服务器
        </button>
      </div>
      {servers.error && (
        <p role="alert" className="px-5 py-3 text-sm text-destructive-foreground">
          {consoleError(servers.error)}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {navigation.tabs.map((tab) => (
          <ConsoleServerPanel
            key={tab.serverId}
            tab={tab}
            server={servers.data?.find((item) => item.alias === tab.serverId)}
            active={active && navigation.selected === tab.serverId}
            shown={navigation.selected === tab.serverId}
            manage={onManageServers}
          />
        ))}
        {!navigation.tabs.length && (
          <div className="m-auto flex max-w-md flex-col items-center gap-3.5 p-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-surface-subtle text-muted-foreground">
              <Server aria-hidden className="size-6" />
            </div>
            <div className="space-y-1">
              <p className="text-base font-semibold tracking-tight">选择服务器开始</p>
              <p className="text-[13px] leading-6 text-muted-foreground">连接后查看资源、浏览文件或打开终端。</p>
            </div>
            <button type="button" className={`${buttonClass('primary')} mt-0.5`} onClick={() => setPicker(true)}>
              打开服务器
            </button>
          </div>
        )}
      </div>
      {visible && picker && (
        <ConsoleServerPicker
          servers={servers.data ?? []}
          close={() => setPicker(false)}
          select={(alias) => {
            navigation.open(alias);
            setPicker(false);
          }}
          manage={() => {
            setPicker(false);
            onManageServers();
          }}
        />
      )}
    </section>
  );
}
