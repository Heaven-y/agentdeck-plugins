import { lazy, useState } from 'react';
import { ServerManagerDialog } from './ssh/ServerManagerDialog';
const SshConsolePage = lazy(() => import('./console/SshConsolePage'));
export default function SshConsoleWorkspace({ visible }: { visible: boolean }) {
  const [serversOpen, setServersOpen] = useState(false);
  return (
    <>
      {serversOpen && <ServerManagerDialog onClose={() => setServersOpen(false)} />}
      <div className="h-full min-h-0">
        <SshConsolePage visible={visible} onManageServers={() => setServersOpen(true)} />
      </div>
    </>
  );
}
