/**
 * The chat with the agent, and the conversation a project file keeps when the user opts in
 * (Settings → General → Conversation): every message that led to the design, as the chat showed it.
 * It is kept beside the design in the project file, not in it: the kernel never sees it, so undo,
 * changesets and diffs are about the design alone.
 */
import type { Design } from './model.ts';
import type { TokenCount } from './server.ts';

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; label: string; ok: boolean; detail: string }
  | { type: 'verify'; round: number; errors: number; message: string; /** A look over the drawing (new SCH.* warnings), not errors to fix. */ review?: boolean }
  | { type: 'question'; question: string; options: string[]; answered?: string }
  | { type: 'error'; text: string }
  /** Something the server says about the run (e.g. a setting the model does not take). */
  | { type: 'note'; text: string };

/** A picture or PDF the user attached to a chat message (a schematic to recreate, a sketch, a screenshot). */
export interface ChatFile {
  /** Numbered through the conversation (#1, #2…), as the agent's view_attachment knows them. */
  n: number;
  name: string;
  mime: string;
  /** base64, without a data: prefix ('' when the project file left it out, see `omitted`) */
  data: string;
  /** A PDF's page count. */
  pages?: number;
  /** The project file kept the message but not the file (the conversation was too large). */
  omitted?: true;
}

export interface ChatItem {
  id: number;
  role: 'user' | 'agent';
  /** When it was sent (ISO 8601). */
  at: string;
  text?: string;
  refs?: string[];
  files?: ChatFile[];
  segments: Segment[];
  status: 'streaming' | 'done';
  /** Coding agent answering through the server (e.g. "Claude Code", "OpenCode"). */
  source?: string;
  /**
   * This turn produced the proposal that is currently pending (or was decided). `unreviewed`: it
   * was still pending when the project was closed (a pending proposal is not saved).
   */
  changeset?: { state: 'pending' | 'accepted' | 'rejected' | 'superseded' | 'unreviewed'; note?: string };
  /** Tokens this turn used (live while it runs), with the cost: estimated, or as the coding agent reported it. */
  usage?: TokenCount & { costUsd: number; exact: boolean };
}

export const CONVERSATION_FORMAT = 1;

/** The conversation a project file keeps. */
export interface Conversation {
  format: typeof CONVERSATION_FORMAT;
  /**
   * Earliest first. A session is what one agent context saw: a new one starts when the chat is
   * cleared or the project is opened again.
   */
  sessions: ConversationSession[];
}

export interface ConversationSession {
  items: ChatItem[];
}

/** A project file: the design, and the conversation when the project keeps it. */
export type ProjectFile = Design & { conversation?: Conversation };
