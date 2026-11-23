import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Workspace from './Workspace';
import { connectTheme } from './host';
import { useUiPreferences } from './ui/appearance/ui-preferences';
import './styles.css';
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
connectTheme(useUiPreferences);
function Page() {
  const [visible, setVisible] = useState(false);
  useEffect(() => window.agentdeck.onContext((context) => setVisible(context.visible)), []);
  return (
    <QueryClientProvider client={client}>
      <Workspace visible={visible} />
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
