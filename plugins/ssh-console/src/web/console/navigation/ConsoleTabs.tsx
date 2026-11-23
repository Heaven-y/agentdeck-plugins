import { Tab, TabList, TabProvider } from '@ariakit/react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ManagedServer } from '../../../shared/index';
import type { ConsoleServerTab, ConsoleView } from './console-state';

export const consoleViews = [
  { id: 'overview', label: '概览' },
  { id: 'processes', label: '进程' },
  { id: 'files', label: '文件' },
  { id: 'terminals', label: '终端' },
] as const;

export function ConsoleServerTabs({
  tabs,
  servers,
  selected,
  select,
  close,
}: {
  tabs: ConsoleServerTab[];
  servers: ManagedServer[];
  selected?: string;
  select(id: string): void;
  close(id: string): void;
}) {
  if (!tabs.length) return null;
  return (
    <TabProvider
      selectedId={selected}
      setSelectedId={(id) => {
        if (id) select(id);
      }}
    >
      <TabList aria-label="服务器标签" className="flex min-w-0 gap-2 overflow-x-auto">
        {tabs.map((tab) => {
          const server = servers.find((item) => item.alias === tab.serverId);
          const active = selected === tab.serverId;
          return (
            <div
              key={tab.serverId}
              data-active={active || undefined}
              className={`group flex max-w-80 shrink-0 items-center rounded-lg border ${active ? 'border-border-strong bg-background' : 'border-border text-muted-foreground'}`}
            >
              <Tab
                id={tab.serverId}
                aria-label={server?.name ?? '服务器'}
                aria-controls={`console-server-${encodeURIComponent(tab.serverId)}`}
                className="flex h-8 min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs font-medium outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive"
              >
                <span className="truncate">{server?.name ?? '服务器'}</span>
                {server && (
                  <span className="hidden max-w-40 truncate text-[11px] font-normal text-muted-foreground sm:inline">
                    {server.username}@{server.hostname}
                  </span>
                )}
              </Tab>
              <button
                type="button"
                className={`mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-control-hover hover:text-foreground focus-visible:outline-interactive ${active ? 'opacity-80 hover:opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100'}`}
                aria-label={`关闭服务器标签 ${server?.name ?? tab.serverId}`}
                title="关闭标签，保留服务器上的终端"
                onClick={() => close(tab.serverId)}
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          );
        })}
      </TabList>
    </TabProvider>
  );
}

export function ConsoleViewTabs({
  view,
  prefix,
  select,
  action,
}: {
  view: ConsoleView;
  prefix: string;
  select(view: ConsoleView): void;
  action?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4">
      <TabProvider
        selectedId={`${prefix}-${view}`}
        setSelectedId={(id) => {
          const selected = consoleViews.find((item) => `${prefix}-${item.id}` === id);
          if (selected) select(selected.id);
        }}
      >
        <TabList aria-label="SSH 控制台视图" className="flex min-w-0 gap-1 overflow-x-auto">
          {consoleViews.map(({ id, label }) => (
            <Tab
              key={id}
              id={`${prefix}-${id}`}
              aria-controls={`${prefix}-panel`}
              className="flex h-10 items-center gap-1.5 border-b-2 border-transparent px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground aria-selected:border-interactive aria-selected:text-foreground focus-visible:outline-interactive"
            >
              {label}
            </Tab>
          ))}
        </TabList>
      </TabProvider>
      {action}
    </div>
  );
}
