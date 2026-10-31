import { describe, expect, it } from 'vitest';
import { BoardClient } from '../src/lib/boardClient.ts';

describe('the board client', () => {
  it('tells whoever waits for a board when none can be laid', async () => {
    const boards = new BoardClient();
    const waiting = boards.next();
    boards.fail();
    await expect(waiting).resolves.toBeNull();
    expect(boards.busy).toBe(false);
  });
});
