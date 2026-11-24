/**
 * Running the agent tools. Every engine (the in-app loop, Claude Code through the server) calls
 * the same executor; it answers with a ToolOutcome that each engine passes on in its own format.
 */
import { CalcCall, TOOL_NAMES } from '@4k7/schema';
import { CalcError, calcBoard, runCalc } from './calc.ts';
import { compactTx, describeTx } from './format.ts';
import type { KernelPort } from './types.ts';

export interface ToolImage {
  /** base64, without a data: prefix */
  data: string;
  mimeType: string;
}

export interface ToolOutcome {
  /** What the model reads. */
  content: string;
  /** Pictures that go with it (a schematic, a datasheet page). */
  images?: ToolImage[];
  isError: boolean;
  /** For the chat's activity list: what was done, and how it went. */
  label: string;
  detail: string;
}

export type ToolExecutor = (name: string, input: unknown) => Promise<ToolOutcome>;

/** The tools that need only the kernel: design_query, design_edit and calc. Null for any other tool. */
export async function runKernelTool(kernel: KernelPort, name: string, input: unknown): Promise<ToolOutcome | null> {
  try {
    switch (name) {
      case TOOL_NAMES.query: {
        const out = await kernel.query(input);
        const op = (input as { op?: string })?.op ?? '?';
        const isError = !!(out && typeof out === 'object' && 'error' in out);
        // a text answer (a guide) goes as it is
        return { content: typeof out === 'string' ? out : JSON.stringify(out), isError, label: `query · ${op}`, detail: summariseQuery(input, out) };
      }
      case TOOL_NAMES.edit: {
        const r = await kernel.transact(input);
        const tx = input as { summary?: string; ops?: unknown[]; dry_run?: boolean };
        const label = `${tx.dry_run ? 'dry-run' : 'edit'} · ${tx.ops?.length ?? 0} ops · ${tx.summary ?? ''}`;
        return { content: JSON.stringify(compactTx(r)), isError: r.status !== 'ok', label, detail: describeTx(r) };
      }
      case TOOL_NAMES.calc: {
        const parsed = CalcCall.safeParse(input);
        if (!parsed.success) return { content: `Invalid calc input: ${parsed.error.message}`, isError: true, label: 'calc', detail: 'invalid input' };
        const { summary } = await kernel.snapshot();
        const on = calcBoard(summary, parsed.data.board);
        const out = runCalc(parsed.data, summary.valueSeries, on.stackup, on.currentRise, on.ask);
        return { content: JSON.stringify(out), isError: false, label: `calc · ${parsed.data.fn}`, detail: Object.entries(out).filter(([k]) => k !== 'note').map(([k, v]) => `${k}=${v}`).join(', ') };
      }
      default:
        return null;
    }
  } catch (e) {
    const msg = e instanceof CalcError || e instanceof Error ? e.message : String(e);
    return { content: `Tool failed: ${msg}`, isError: true, label: name, detail: msg };
  }
}

/** A tool no engine knows. */
export function unknownTool(name: string): ToolOutcome {
  return { content: `Unknown tool ${name}`, isError: true, label: name, detail: 'unknown tool' };
}

function summariseQuery(input: unknown, out: unknown): string {
  if (Array.isArray(out)) return `${out.length} result(s)`;
  if (out && typeof out === 'object' && 'error' in out) return String((out as { error: unknown }).error);
  const op = (input as { op?: string })?.op;
  if (op === 'get_guide') return String((input as { topic?: unknown }).topic);
  if (op === 'list_blocks' && out && typeof out === 'object' && 'blocks' in out) return `${(input as { project?: unknown }).project}: ${(out as { blocks: unknown[] }).blocks.length} block(s)`;
  if (op === 'get_diagnostics' && out && typeof out === 'object' && Array.isArray((out as { diagnostics?: unknown }).diagnostics)) return `${(out as { diagnostics: unknown[] }).diagnostics.length} result(s)`;
  return op === 'get_summary' ? 'design summary' : 'ok';
}
