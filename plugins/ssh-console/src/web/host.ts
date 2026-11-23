import type { StoreApi } from 'zustand';
export type Context = { visible: boolean; theme: 'light' | 'dark'; colors: Record<string, string> };
declare global {
  interface Window {
    agentdeck: {
      backend: {
        request(
          input: { method: string; url: string; body?: unknown },
          options?: { signal?: AbortSignal | null },
        ): Promise<{ status: number; body: unknown }>;
      };
      clipboard: { readText(): Promise<string>; writeText(value: string): Promise<void> };
      onContext(listener: (context: Context) => void): () => void;
    };
  }
}
export function connectTheme(store: StoreApi<{ theme: 'light' | 'dark' }>) {
  return window.agentdeck.onContext((context) => {
    store.setState({ theme: context.theme });
    document.documentElement.dataset.theme = context.theme;
    for (const [key, value] of Object.entries(context.colors)) document.documentElement.style.setProperty(key, value);
  });
}
