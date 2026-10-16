/**
 * The conversation a project file keeps (opt-in, see @4k7/schema conversation.ts): taken off the
 * design when a file is read, put back after it when one is written.
 */
import { CONVERSATION_FORMAT, type ChatItem, type Conversation, type ConversationSession, type Design, type ProjectFile } from '@4k7/schema';

/**
 * How large the conversation may make the file (characters of JSON). The server takes up to 64 MB
 * a write, and the design must always fit: past this, the oldest attachments are left out.
 */
export const CONVERSATION_BUDGET = 40 * 1024 * 1024;

/** A project file read: the design for the kernel, and the conversation it keeps (null: none). */
export function readProject(file: ProjectFile): { design: Design; conversation: Conversation | null } {
  const { conversation, ...design } = file;
  if (!conversation || !Array.isArray(conversation.sessions)) return { design, conversation: null };
  if (conversation.format > CONVERSATION_FORMAT) throw new Error('its conversation was written by a newer version of the app');
  return { design, conversation };
}

/**
 * The project file: the design's JSON (canonical, from the kernel) with the conversation after it.
 * The design's text is kept as it is, so a file diffs the same with or without one.
 */
export function projectJson(designJson: string, conversation: Conversation | null): string {
  if (!conversation) return designJson;
  const body = JSON.stringify(conversation, null, 2).replace(/\n/g, '\n  ');
  return designJson.replace(/\n}\n?$/, `,\n  "conversation": ${body}\n}\n`);
}

/**
 * The conversation as the file keeps it: the oldest attachments left out (their message stays)
 * until it is within `budget`. `omitted` counts the files left out.
 */
export function fitConversation(c: Conversation, budget = CONVERSATION_BUDGET): { conversation: Conversation; omitted: number } {
  let size = JSON.stringify(c).length;
  if (size <= budget) return { conversation: c, omitted: 0 };
  let omitted = 0;
  const sessions = c.sessions.map((s) => ({
    items: s.items.map((it) => {
      if (!it.files?.length || size <= budget) return it;
      return {
        ...it,
        files: it.files.map((f) => {
          if (size <= budget || f.omitted) return f;
          size -= f.data.length;
          omitted++;
          return { ...f, data: '', omitted: true as const };
        }),
      };
    }),
  }));
  return { conversation: { ...c, sessions }, omitted };
}

/**
 * Sessions from a file, as earlier conversations: nothing streams any more, and a proposal that
 * was pending when the file was written is gone (a pending changeset is not saved).
 */
export function restoredSessions(c: Conversation | null): ConversationSession[] {
  return (c?.sessions ?? [])
    .filter((s) => s.items?.length)
    .map((s) => ({
      items: s.items.map((it): ChatItem => ({
        ...it,
        status: 'done',
        ...(it.changeset?.state === 'pending' ? { changeset: { state: 'unreviewed', note: 'Not reviewed: the project was closed with these changes pending.' } } : {}),
      })),
    }));
}
