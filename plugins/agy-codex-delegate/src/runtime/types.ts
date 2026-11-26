import { z } from 'zod';

export const SettingsSchema = z.strictObject({
  model: z.string().trim().max(160).optional(),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  approvalPolicy: z.enum(['untrusted', 'on-failure', 'on-request', 'never']).optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const TaskInputSchema = z.strictObject({
  requestId: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(48_000),
  acceptance: z.string().trim().min(1).max(12_000),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;
export type Phase =
  'queued' | 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type Task = {
  id: string;
  owner: string;
  grant: string;
  requestId: string;
  inputHash: string;
  title: string;
  cwd: string;
  phase: Phase;
  threadId?: string;
  turnId?: string;
  recordPath?: string;
  round: number;
  revision: number;
  deliveredRevision?: number;
  accepted?: boolean;
  continuation?: { requestId: string; hash: string };
  pendingInputHash?: string;
  notificationId?: string;
  pendingAsync?: { itemId: string; threadId: string; turnId: string };
  cancelRequested?: boolean;
  codexHome?: string;
  deleting?: boolean;
  config: Settings;
  actual?: Record<string, unknown>;
  error?: string;
  updatedAt: number;
};
export type Grant = {
  dispatchHash?: string;
  id: string;
  owner: string;
  cwd: string;
  inputHash: string;
  transcriptPath: string;
  createdAt: number;
  closed?: boolean;
  witnessedNative?: boolean;
};
export type Binding = {
  owner: string;
  grant?: string;
  cwd: string;
  issuedAt: number;
  userHash: string;
  automatic?: boolean;
};
export type State = {
  schema: 1;
  enabled: boolean;
  config: Settings;
  grants: Grant[];
  tasks: Task[];
  deletingOwners?: string[];
  automaticInputs?: { owner: string; textHash: string }[];
};
export type NativeQuestion = {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
  approval: boolean;
};
export type NativeSnapshot = { phase: Phase; question?: NativeQuestion; result?: string; error?: string };
export type NativeRun = {
  start(task: Task, text: string, update: (value: Partial<Task>) => Promise<void>): Promise<void>;
  snapshot(): NativeSnapshot;
  answer(id: string | number, answer: unknown): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
};
export type NativeFactory = {
  run(environment?: NodeJS.ProcessEnv): NativeRun;
  read(task: Task): Promise<{ result?: string; phase?: Phase; question?: NativeQuestion }>;
  remove(task: Task): Promise<void>;
  defaults(cwd: string): Promise<Record<string, unknown>>;
};
export const terminal = (phase: Phase) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(phase);
