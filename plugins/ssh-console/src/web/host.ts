import type { StoreApi } from 'zustand';
import type { PluginContext } from '../../../../sdk/browser';
export type Context = PluginContext;
export function connectTheme(store: StoreApi<{ theme: 'light' | 'dark' }>) {
  return window.agentdeck.onContext((context) => {
    store.setState({ theme: context.theme });
    document.documentElement.dataset.theme = context.theme;
    for (const [key, value] of Object.entries(context.colors)) document.documentElement.style.setProperty(key, value);
  });
}
