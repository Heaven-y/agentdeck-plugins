import { useEffect, useRef, useState } from 'react';
import { TerminalPasteDialog } from './TerminalPasteDialog';
import { prepareTerminalPaste } from './paste';
import { createConsoleTerminalRuntime } from './terminal-runtime';
import { ConsoleTerminalSearch } from './ConsoleTerminalSearch';
import type { TerminalSearchResults } from './terminal-search';

export function ConsoleTerminalPane({
  serverId,
  terminalId,
  visible,
  focused,
}: {
  serverId: string;
  terminalId: string;
  visible: boolean;
  focused: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const runtime = useRef<ReturnType<typeof createConsoleTerminalRuntime> | undefined>(undefined);
  const [status, setStatus] = useState('正在恢复终端…');
  const [paste, setPaste] = useState<string>();
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<TerminalSearchResults | null>(null);
  const closeSearch = () => {
    runtime.current?.search('');
    setSearching(false);
    runtime.current?.focus();
  };
  useEffect(() => {
    const instance = createConsoleTerminalRuntime({
      host: host.current!,
      serverId,
      terminalId,
      status: setStatus,
      searchResults: setSearchResults,
      paste: (text) => {
        try {
          prepareTerminalPaste(text);
          if (/[\r\n]/.test(text)) setPaste(text);
          else instance.paste(text);
        } catch (reason) {
          setStatus((reason as Error).message);
        }
      },
    });
    runtime.current = instance;
    return () => {
      instance.dispose();
      runtime.current = undefined;
    };
  }, [serverId, terminalId]);
  useEffect(() => {
    runtime.current?.setVisible(visible);
    if (visible && focused && !pane.current?.contains(document.activeElement)) runtime.current?.focus();
  }, [visible, focused]);
  return (
    <section
      ref={pane}
      hidden={!visible}
      aria-label={`终端 ${terminalId}`}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded border border-border bg-background"
      onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          setSearching(true);
        }
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && ['c', 'v'].includes(event.key.toLowerCase())) {
          event.preventDefault();
          event.stopPropagation();
          if (event.key.toLowerCase() === 'c') void runtime.current?.copy();
          else void runtime.current?.readClipboard();
        }
      }}
    >
      <p
        role="status"
        className={status.startsWith('已连接 ·') ? 'sr-only' : 'shrink-0 px-2 py-1 text-xs text-muted-foreground'}
      >
        {status}
      </p>
      {searching && (
        <ConsoleTerminalSearch
          find={(text, backwards, incremental) => runtime.current?.search(text, backwards, incremental) ?? false}
          results={searchResults}
          close={closeSearch}
        />
      )}
      <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden px-1 pt-1" />
      {visible && paste !== undefined && (
        <TerminalPasteDialog
          text={paste}
          cancel={() => setPaste(undefined)}
          confirm={() => {
            runtime.current?.paste(paste);
            setPaste(undefined);
            runtime.current?.focus();
          }}
        />
      )}
    </section>
  );
}
