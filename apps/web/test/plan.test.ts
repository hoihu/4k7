import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProposePlanInput, type ChatPlan } from '@4k7/schema';
import { PLAN_STEP_OFF, PlanReview } from '../src/lib/plan.ts';

afterEach(() => vi.useRealTimers());

const steps = ['U1 TPS54331 buck, 12 V → 3.3 V', 'USB-C connector on the left edge', 'ESP32 module with its flash'];

describe('propose_plan input', () => {
  it('takes plain-text steps and an optional summary', () => {
    expect(ProposePlanInput.parse({ steps, summary: 'Sensor board' })).toEqual({ steps, summary: 'Sensor board' });
    expect(ProposePlanInput.safeParse({ steps: [] }).success).toBe(false);
    expect(ProposePlanInput.safeParse({ steps: ['ok'] }).success).toBe(false);
    expect(ProposePlanInput.safeParse({ steps: 'one' }).success).toBe(false);
  });
});

describe('the plan step', () => {
  it('shows the plan and gives wait_for_review the acceptance with its comment', async () => {
    const plans = new PlanReview();
    const item: { plan?: ChatPlan } = {};
    expect(plans.show(item, { steps, summary: ' Sensor board ' })).toMatch(/plan of 3 steps.*wait_for_review/);
    expect(item.plan).toEqual({ steps, summary: 'Sensor board', state: 'pending' });
    const waiting = plans.wait(60)!;
    plans.decide(true, '  put the USB on the right ');
    expect(await waiting).toMatch(/^plan accepted\. The user's comment: put the USB on the right\. Carry it out/);
    expect(item.plan).toMatchObject({ state: 'accepted', comment: 'put the USB on the right' });
    expect(plans.pending).toBe(false);
    expect(plans.wait(60)).toBeNull(); // nothing left: wait_for_review goes on to the changeset
  });

  it('keeps a decision made before the agent waits for it', async () => {
    const plans = new PlanReview();
    const item: { plan?: ChatPlan } = {};
    plans.show(item, { steps });
    plans.decide(false, 'use 4 layers');
    expect(await plans.wait(60)).toMatch(/^plan rejected\. The user's comment: use 4 layers\. Send a revised plan with propose_plan/);
    expect(item.plan).toMatchObject({ state: 'rejected', comment: 'use 4 layers' });
    expect(plans.wait(60)).toBeNull();
  });

  it('asks what to change when rejected without a comment', async () => {
    const plans = new PlanReview();
    plans.show({}, { steps });
    plans.decide(false);
    expect(await plans.wait(60)).toMatch(/rejected without a comment\. Ask the user what to change/);
  });

  it('answers "still pending" after the timeout and keeps the plan open', async () => {
    vi.useFakeTimers();
    const plans = new PlanReview();
    plans.show({}, { steps });
    const waiting = plans.wait(5)!;
    vi.advanceTimersByTime(5000);
    expect(await waiting).toMatch(/^still pending/);
    expect(plans.pending).toBe(true);
  });

  it('supersedes a pending plan with a newer one, and drops it when the conversation ends', async () => {
    const plans = new PlanReview();
    const first: { plan?: ChatPlan } = {};
    const second: { plan?: ChatPlan } = {};
    plans.show(first, { steps });
    const waiting = plans.wait(60)!;
    plans.show(second, { steps: steps.slice(0, 2) });
    expect(await waiting).toMatch(/^plan superseded/);
    expect(first.plan?.state).toBe('superseded');
    expect(plans.pending).toBe(true);
    plans.drop();
    expect(second.plan?.state).toBe('unreviewed');
    expect(plans.wait(60)).toBeNull();
    plans.decide(true); // nothing pending: no effect
    expect(second.plan?.state).toBe('unreviewed');
  });

  it('tells the agent clearly when the project has the plan step off', () => {
    expect(PLAN_STEP_OFF).toMatch(/plan step is off for this project/);
  });
});
