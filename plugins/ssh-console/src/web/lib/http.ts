export class ApiError extends Error {
  readonly code?: string;
  constructor(
    readonly status: number,
    message: string,
    details: { code?: string } = {},
  ) {
    super(message);
    this.code = details.code;
  }
}
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  init?.signal?.throwIfAborted();
  const method = init?.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE')
    throw new Error('不支持此请求方式');
  const response = await window.agentdeck.backend.request(
    { method, url, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) },
    { signal: init?.signal },
  );
  init?.signal?.throwIfAborted();
  if (response.status >= 400) {
    const error = response.body as { code?: string; message?: string };
    throw new ApiError(response.status, error.message ?? `请求失败（${response.status}）`, error);
  }
  return response.body as T;
}
