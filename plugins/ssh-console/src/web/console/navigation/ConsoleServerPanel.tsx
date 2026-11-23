import { sshApi, sshKeys } from '../../ssh/api';
import { lazy, Suspense, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ManagedServer } from '../../../shared/index';

import { buttonClass } from '../../ui/styles';
import { DetailDialog } from '../../ui/DetailDialog';
import { ServerConnectionForm } from '../../ssh/profiles/ServerConnectionForm';
import { ConsoleViewTabs } from './ConsoleTabs';
import { ConsoleResources } from '../monitoring/ConsoleResources';
import { ConsoleFiles } from '../files/ConsoleFiles';
import type { ConsoleServerTab, ConsoleView } from './console-state';

const ConsoleTerminals = lazy(() => import('../terminal/ConsoleTerminals'));
export function ConsoleServerPanel({
  tab,
  server,
  active,
  shown,
  manage,
}: {
  tab: ConsoleServerTab;
  server?: ManagedServer;
  active: boolean;
  shown: boolean;
  manage(): void;
}) {
  const id = useId();
  const [view, setView] = useState<ConsoleView>('overview');
  const [terminalLoaded, setTerminalLoaded] = useState(false);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const credentials = useQuery({
    queryKey: sshKeys.sshCredentials(tab.serverId),
    queryFn: ({ signal }) => sshApi.sshCredentials(tab.serverId, signal),
    enabled: active,
    refetchInterval: active ? 10000 : false,
    retry: false,
  });
  const connected = credentials.data?.connected === true;
  const enabled = active && connected;
  const select = (next: ConsoleView) => {
    setView(next);
    if (next === 'terminals') setTerminalLoaded(true);
    if (next === 'files') setFilesLoaded(true);
  };
  return (
    <section
      id={`console-server-${encodeURIComponent(tab.serverId)}`}
      hidden={!shown}
      className="flex min-h-0 flex-1 flex-col"
    >
      <ConsoleViewTabs
        prefix={id}
        view={view}
        select={select}
        action={
          <button
            type="button"
            className={`${buttonClass('ghost')} shrink-0 text-xs`}
            onClick={() => (server ? setConnectOpen(true) : manage())}
          >
            <span aria-hidden className={`size-1.5 rounded-full ${connected ? 'bg-success' : 'bg-muted-foreground'}`} />
            {connected ? '已连接' : '连接服务器'}
          </button>
        }
      />
      {!connected && (
        <div className="m-auto flex flex-col items-center gap-3 p-6">
          {credentials.isError && (
            <p role="alert" className="text-sm text-destructive-foreground">
              连接状态读取失败
            </p>
          )}
          <button
            type="button"
            className={buttonClass('outline')}
            onClick={() => (server ? setConnectOpen(true) : manage())}
          >
            连接服务器
          </button>
        </div>
      )}
      {connected && (
        <ConsoleServerContent
          id={id}
          tab={tab}
          view={view}
          enabled={enabled}
          terminalLoaded={terminalLoaded}
          filesLoaded={filesLoaded}
        />
      )}
      {active && connectOpen && server && (
        <DetailDialog title={`连接 ${server.name}`} onClose={() => setConnectOpen(false)}>
          <ServerConnectionForm server={server} />
        </DetailDialog>
      )}
    </section>
  );
}

function ConsoleServerContent({
  id,
  tab,
  view,
  enabled,
  terminalLoaded,
  filesLoaded,
}: {
  id: string;
  tab: ConsoleServerTab;
  view: ConsoleView;
  enabled: boolean;
  terminalLoaded: boolean;
  filesLoaded: boolean;
}) {
  return (
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${view}`} className="flex min-h-0 flex-1 flex-col">
      {(view === 'overview' || view === 'processes') && (
        <ConsoleResources serverId={tab.serverId} directory={tab.directory} view={view} active={enabled} />
      )}
      {filesLoaded && (
        <div hidden={view !== 'files'} className="flex min-h-0 flex-1 flex-col">
          <ConsoleFiles serverId={tab.serverId} initialDirectory={tab.directory} active={enabled && view === 'files'} />
        </div>
      )}
      {terminalLoaded && (
        <div hidden={view !== 'terminals'} className="flex min-h-0 flex-1 flex-col">
          <Suspense
            fallback={
              <p role="status" className="p-5 text-sm">
                正在打开终端…
              </p>
            }
          >
            <ConsoleTerminals
              serverId={tab.serverId}
              directory={tab.directory}
              visible={enabled && view === 'terminals'}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
