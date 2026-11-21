/**
 * The plan step (opt-in per project): an external agent shows a numbered plan with propose_plan before a larger
 * task, the user accepts or rejects it with a comment in the chat, and wait_for_review gives the agent the decision.
 * See docs/design/ai-loop.md §6.
 */
import type { ChatPlan } from '@4k7/schema';

/** What propose_plan answers when the project has the plan step off. */
export const PLAN_STEP_OFF =
  'The plan step is off for this project (Settings → General → Plan step), so no plan is shown. Go ahead with the task and propose the changes when they are done.';

/** The reply wait_for_review gives for a decided plan. */
export function planResult(accepted: boolean, comment: string): string {
  const c = comment.trim();
  if (accepted) return `plan accepted${c ? `. The user's comment: ${c}` : ''}. Carry it out${c ? ', taking the comment into account' : ''}; propose the changes when they are done.`;
  return c
    ? `plan rejected. The user's comment: ${c}. Send a revised plan with propose_plan, then wait_for_review; do not change the design before a plan is accepted.`
    : 'plan rejected without a comment. Ask the user what to change before you send a new plan.';
}

/** The plan waiting for the user's decision (one at a time), and the agent's wait_for_review on it. */
export class PlanReview {
  /** The chat item that shows the pending plan. */
  #item: { plan?: ChatPlan } | null = null;
  #waiters: ((result: string) => void)[] = [];
  /** A decision made before the agent asked for it, kept for the next wait_for_review. */
  #unread: string | null = null;

  get pending(): boolean {
    return this.#item?.plan?.state === 'pending';
  }

  /** Show a plan on the item (a chat message); a plan still pending is superseded by it. */
  show(item: { plan?: ChatPlan }, input: { steps: string[]; summary?: string }): string {
    this.#close('superseded', 'the plan was replaced by a newer one.');
    item.plan = { steps: input.steps, ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}), state: 'pending' };
    this.#item = item;
    this.#unread = null;
    return `Showed the user a plan of ${input.steps.length} step${input.steps.length === 1 ? '' : 's'}. Call wait_for_review for their decision before you change the design.`;
  }

  /** The user accepts or rejects the pending plan. */
  decide(accepted: boolean, comment = '') {
    const plan = this.#item?.plan;
    if (!this.#item || plan?.state !== 'pending') return;
    this.#item.plan = { ...plan, state: accepted ? 'accepted' : 'rejected', ...(comment.trim() ? { comment: comment.trim() } : {}) };
    this.#item = null;
    this.#answer(planResult(accepted, comment));
  }

  /** The conversation ends (cleared, another project opened) with a plan pending: it stays undecided. */
  drop() {
    this.#close('unreviewed', 'the conversation was closed before the user decided on the plan. Ask them how to go on.');
    this.#unread = null;
  }

  /**
   * wait_for_review on the plan: the decision (at once if it is already made), or "still pending" after the timeout.
   * Null when no plan is pending or decided unread, so the changeset's review is waited for instead.
   */
  wait(timeoutS: number): Promise<string> | null {
    if (this.#unread !== null) {
      const r = this.#unread;
      this.#unread = null;
      return Promise.resolve(r);
    }
    if (!this.pending) return null;
    return new Promise<string>((resolve) => {
      const done = (r: string) => {
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== done);
        resolve('still pending: the user has not decided on the plan yet. Call wait_for_review again or continue talking to the user.');
      }, timeoutS * 1000);
      this.#waiters.push(done);
    });
  }

  #close(state: 'superseded' | 'unreviewed', why: string) {
    const plan = this.#item?.plan;
    if (this.#item && plan?.state === 'pending') {
      this.#item.plan = { ...plan, state };
      this.#answer(`plan ${state}: ${why}`);
    }
    this.#item = null;
  }

  #answer(result: string) {
    const waiters = this.#waiters.splice(0);
    if (waiters.length) for (const w of waiters) w(result);
    else this.#unread = result;
  }
}
