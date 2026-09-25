import type { DesignSummary, Diagnostic, DiagnosticCounts, ToolDefinition, TransactionResult } from '@tracewise/schema';

/** Provider-neutral conversation blocks. Assistant messages also keep the raw provider payload. */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
  /** Exact provider content for assistant turns, replayed unchanged (thinking signatures). */
  raw?: unknown;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface StepRequest {
  system: string;
  tools: ToolDefinition[];
  messages: Message[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
}

export interface StepResult {
  content: Block[];
  raw?: unknown;
  stop: StopReason;
  usage?: Usage;
  /** Human-readable detail for refusals / errors. */
  detail?: string;
  /** Model that actually served the request (fallbacks may change it). */
  model?: string;
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  step(req: StepRequest): Promise<StepResult>;
}

/** The agent talks to the kernel through this async port (a Web Worker in the app). */
export interface KernelPort {
  transact(tx: unknown): Promise<TransactionResult>;
  query(q: unknown): Promise<unknown>;
  snapshot(): Promise<{ summary: DesignSummary; diagnostics: Diagnostic[]; counts: DiagnosticCounts; ledger: { id: string; text: string; strength: string }[] }>;
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; id: string; name: string; label: string; ok: boolean; detail: string }
  | { type: 'verify'; round: number; errors: number; message: string }
  | { type: 'question'; question: string; options: string[] }
  | { type: 'usage'; usage: Usage; model?: string }
  | { type: 'done'; reason: 'complete' | 'question' | 'budget' | 'refusal' | 'max_tokens' | 'aborted' | 'error'; message?: string };
