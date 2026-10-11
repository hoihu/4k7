/**
 * Progress of a datasheet import, the same for every agent: which page it reads, and how many
 * pins of the part it has written while the (long) submit_part call streams in.
 */
import type { RunSink } from './types.ts';

/** Progress line for a file tool call of the importer ("Reading page 69"). Tool names and inputs differ per agent. */
export function describeTool(name = '', input: unknown): string {
  const i = (input ?? {}) as { file_path?: string; filePath?: string; path?: string; pattern?: string };
  const file = i.file_path ?? i.filePath ?? i.path ?? '';
  switch (name.toLowerCase()) {
    case 'read':
    case 'view': {
      const page = /page-0*(\d+)\.txt$/.exec(file);
      if (page) return `Reading page ${page[1]}`;
      return `Reading ${file.split('/').pop() || 'the datasheet'}`;
    }
    case 'grep':
      return `Searching for “${i.pattern ?? ''}”`;
    case 'glob':
      return 'Listing pages';
    default:
      return name;
  }
}

/** Counts the pins in the streamed arguments of submit_part and reports every 20. */
export function pinCounter(sink: RunSink): { start(): void; add(json: string): void } {
  let written: { json: string; reported: number } | null = null;
  return {
    start() {
      written = { json: '', reported: 0 };
      sink.emit({ kind: 'status', text: 'Writing the part…' });
    },
    add(json) {
      if (!written) return;
      written.json += json;
      const pins = (written.json.match(/"number"\s*:/g) ?? []).length;
      if (pins >= written.reported + 20) {
        written.reported = pins - (pins % 20);
        sink.emit({ kind: 'status', text: `Writing the part: ${written.reported} pins…` });
      }
    },
  };
}
