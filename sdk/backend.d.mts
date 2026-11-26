import type { BackendRequest, HostServices } from './browser.js';
export type PluginBackendContext = {
  dataDir: string;
  hostDataDir: string;
  host: HostServices;
};
export function definePlugin<T>(definition: {
  initialize(context: PluginBackendContext): T | Promise<T>;
  request(state: T, input: BackendRequest, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
  dispose?(state: T): void | Promise<void>;
}): void;
