import { beforeEach } from 'vitest';
beforeEach(() => {
  const host = globalThis.window ?? (globalThis.window = {} as Window & typeof globalThis);
  Object.defineProperty(host, 'agentdeck', {
    configurable: true,
    value: {
      backend: {
        request: async (
          input: { method: string; url: string; body?: unknown },
          options?: { signal?: AbortSignal | null },
        ) => {
          const response = await fetch(input.url, {
            method: input.method,
            cache: 'no-store',
            signal: options?.signal,
            ...(input.body === undefined
              ? {}
              : { body: JSON.stringify(input.body), headers: { 'content-type': 'application/json' } }),
          });
          return { status: response.status, body: response.status === 204 ? null : await response.json() };
        },
      },
      clipboard: { readText: async () => '', writeText: async () => {} },
      onContext: () => () => {},
    },
  });
});
