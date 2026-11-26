export type Agent = 'claude' | 'codex' | 'antigravity';
export type SessionContext = {
  conversationId: string;
  /** session.list 返回的本次打开标识；关闭重开会变化。 */
  openId?: string;
  workspaceId?: string;
  agent: Agent;
  sessionId?: string;
  running: boolean;
};
export type Project = { id: string; name: string; dir: string };
export type PluginContext = {
  visible: boolean;
  theme: 'light' | 'dark';
  colors: Record<string, string>;
  page?: { id: string; title: string; location: 'sidebar' | 'settings' };
  project?: Project | null;
  session?: SessionContext;
};
export type EventName = 'context.changed' | 'turn.started' | 'turn.completed';
export type HostRequest =
  | { method: 'projects.list' }
  | { method: 'sessions.list'; params: { projectId: string; agent: Agent; cursor?: string } }
  | { method: 'sessions.history'; params: { projectId: string; agent: Agent; sessionId: string; before?: string } };
export type SessionSummary = {
  agent: Agent;
  sessionId: string;
  projectId: string | null;
  title: string;
  updatedAt: string;
  running: boolean;
  directory?: string;
};
export type SessionPage = { items: SessionSummary[]; nextCursor?: string };
export type HistoryPage = {
  session: { agent: Agent; sessionId: string; summary: string; lastModified: number };
  events: Array<{ type: string; [key: string]: unknown }>;
  page: { start: number; before?: string };
  actualModel?: string;
};
export type HostResult<T extends HostRequest> = T['method'] extends 'projects.list'
  ? Project[]
  : T['method'] extends 'sessions.list'
    ? SessionPage
    : HistoryPage;
export type HostServices = {
  request<T extends HostRequest>(input: T, options?: RequestOptions): Promise<HostResult<T>>;
};
export type BackendRequest = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; body?: unknown };
export type RequestOptions = { signal?: AbortSignal | null };
export type PluginStorage = { value: Record<string, unknown>; revision: string };
export type Draft = { text: string; conversationId: string; revision: string };
export type PluginApi = {
  version: number;
  host: HostServices;
  backend: {
    request<T = unknown>(input: BackendRequest, options?: RequestOptions): Promise<{ status: number; body: T }>;
  };
  storage: { get(): Promise<PluginStorage>; set(input: PluginStorage): Promise<PluginStorage> };
  project: { get(): Promise<Project | null> };
  session: {
    get(): Promise<SessionContext | null>;
    list(): Promise<SessionContext[]>;
    resume(input: { conversationId: string; requestId: string; text: string }): Promise<{ accepted: boolean }>;
  };
  composer: { get(): Promise<Draft>; set(input: Pick<Draft, 'text' | 'revision'>): Promise<null> };
  clipboard: { readText(): Promise<string>; writeText(value: string): Promise<void> };
  onContext(listener: (context: PluginContext) => void): () => void;
  onCommand(
    listener: (
      id: string,
      invocation: { id: string; sequence: number; conversationId?: string; session?: SessionContext },
    ) => void | Promise<void>,
  ): () => void;
  onEvent(
    name: EventName,
    listener: (event: { name: EventName; session: SessionContext }) => void | Promise<void>,
  ): () => void;
};
declare global {
  interface Window {
    agentdeck: PluginApi;
  }
}
