import { describe, expect, it } from 'vitest';
import { Kernel, canonicalJson } from '@4k7/kernel';
import { emptyDesign, type ChatItem, type Conversation, type ProjectFile } from '@4k7/schema';
import { fitConversation, projectJson, readProject, restoredSessions } from '../src/lib/conversation.ts';

const at = '2026-10-16T09:00:00.000Z';
const user = (id: number, text: string, files?: ChatItem['files']): ChatItem => ({ id, role: 'user', at, text, segments: [], status: 'done', ...(files ? { files } : {}) });
const agent = (id: number, text: string, extra: Partial<ChatItem> = {}): ChatItem => ({ id, role: 'agent', at, segments: [{ type: 'text', text }], status: 'done', ...extra });
const conv = (...sessions: ChatItem[][]): Conversation => ({ format: 1, sessions: sessions.map((items) => ({ items })) });

describe('project file with a conversation', () => {
  const design = canonicalJson(emptyDesign('blinky'));
  const c = conv([user(1, 'A 555 blinker, "two LEDs"\nplease'), agent(2, 'Done.', { changeset: { state: 'accepted', note: '3 of 3 committed as #1' } })]);

  it('keeps the design text as it is, the conversation after it', () => {
    const text = projectJson(design, c);
    expect(text.startsWith(design.replace(/\n}\n$/, ''))).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    const back = readProject(JSON.parse(text) as ProjectFile);
    expect(back.conversation).toEqual(c);
    expect(back.design).toEqual(emptyDesign('blinky'));
  });

  it('writes the design alone without one, and reads it so', () => {
    expect(projectJson(design, null)).toBe(design);
    expect(readProject(JSON.parse(design) as ProjectFile).conversation).toBeNull();
  });

  it('gives the kernel the design without the conversation', () => {
    const k = new Kernel();
    k.load(readProject(JSON.parse(projectJson(design, c)) as ProjectFile).design);
    expect(k.exportDesign()).toBe(design);
  });

  it('refuses a conversation from a newer version', () => {
    expect(() => readProject({ ...emptyDesign(), conversation: { format: 2 as 1, sessions: [] } })).toThrow(/newer version/);
  });
});

describe('fitConversation', () => {
  const file = (n: number, kb: number) => ({ n, name: `p${n}.png`, mime: 'image/png', data: 'A'.repeat(kb * 1024) });

  it('leaves a conversation within the budget as it is', () => {
    const c = conv([user(1, 'hi', [file(1, 10)])]);
    expect(fitConversation(c, 1 << 20)).toEqual({ conversation: c, omitted: 0 });
  });

  it('leaves out the oldest attachments first, keeping their messages', () => {
    const c = conv([user(1, 'old', [file(1, 300)])], [user(2, 'mid', [file(2, 300)]), user(3, 'new', [file(3, 300)])]);
    const { conversation, omitted } = fitConversation(c, 500 * 1024);
    expect(omitted).toBe(2);
    const files = conversation.sessions.flatMap((s) => s.items.flatMap((i) => i.files ?? []));
    expect(files.map((f) => [f.n, !!f.omitted, f.data.length])).toEqual([
      [1, true, 0],
      [2, true, 0],
      [3, false, 300 * 1024],
    ]);
    expect(conversation.sessions[1]!.items.map((i) => i.text)).toEqual(['mid', 'new']);
    expect(c.sessions[0]!.items[0]!.files![0]!.data.length).toBe(300 * 1024); // the chat's own copy is untouched
  });
});

describe('restoredSessions', () => {
  it('ends what was streaming and marks a pending proposal as not reviewed', () => {
    const c = conv([], [user(1, 'go'), agent(2, 'Proposed.', { status: 'streaming', changeset: { state: 'pending' } })]);
    const [s, ...rest] = restoredSessions(c);
    expect(rest).toEqual([]); // an empty session is dropped
    expect(s!.items[1]!.status).toBe('done');
    expect(s!.items[1]!.changeset?.state).toBe('unreviewed');
  });
});
