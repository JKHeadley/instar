/**
 * What a write would change. Spec section 5: the judge sees the resulting document's changed
 * blocks with their headings, and only changed lines can be refused. Edit is diffed against
 * `old_string` and Write against the file on disk, both by comparing the whole document.
 */
export interface PlannedWrite {
  path: string;
  before: string;
  after: string;
  /** The text an Edit replaced. Proves the parent of a reworded claim. */
  oldText?: string;
}

export type ReadFile = (filePath: string) => string;

function applyEdit(text: string, oldString: string, newString: string, replaceAll: boolean): string {
  if (!oldString) return newString + text;
  return replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Codex's patch format: one or more `*** Add|Update|Delete File:` sections with hunks. */
export function planApplyPatch(patch: string, read: ReadFile): PlannedWrite[] {
  const plans: PlannedWrite[] = [];
  const sections = patch.split(/^(?=\*\*\* (?:Add|Update|Delete) File: )/m).filter((part) => part.startsWith('*** '));
  for (const section of sections) {
    const lines = section.split('\n');
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[0]);
    if (!head) continue;
    const [, kind, filePath] = head;
    if (kind === 'Delete') continue;
    const before = kind === 'Add' ? '' : read(filePath.trim());
    let after = before;
    const removed: string[] = [];
    const added: string[] = [];
    let hunkOld: string[] = [];
    let hunkNew: string[] = [];
    const flush = () => {
      if (!hunkOld.length && !hunkNew.length) return;
      const oldBlock = hunkOld.join('\n');
      const newBlock = hunkNew.join('\n');
      // A hunk that no longer applies still shows the added lines at the end of the document.
      after = oldBlock && after.includes(oldBlock) ? after.replace(oldBlock, () => newBlock) : `${after}${after && !after.endsWith('\n') ? '\n' : ''}${newBlock}`;
      hunkOld = [];
      hunkNew = [];
    };
    for (const line of lines.slice(1)) {
      if (line.startsWith('@@') || line.startsWith('*** ')) { flush(); continue; }
      if (line.startsWith('+')) { hunkNew.push(line.slice(1)); added.push(line.slice(1)); }
      else if (line.startsWith('-')) { hunkOld.push(line.slice(1)); removed.push(line.slice(1)); }
      else if (line.startsWith(' ')) { hunkOld.push(line.slice(1)); hunkNew.push(line.slice(1)); }
    }
    flush();
    plans.push({ path: filePath.trim(), before, after, ...(removed.length ? { oldText: removed.join('\n') } : {}) });
  }
  return plans;
}

export function planWrites(toolName: string, toolInput: Record<string, unknown>, read: ReadFile): PlannedWrite[] {
  const tool = toolName.replace(/^functions\./, '');
  if (tool === 'apply_patch') {
    const patch = str(toolInput.input) || str(toolInput.patch) || str(toolInput.command) || (Array.isArray(toolInput.command) ? toolInput.command.filter((part) => typeof part === 'string').join('\n') : '');
    return planApplyPatch(patch, read);
  }
  const filePath = str(toolInput.file_path);
  if (!filePath) return [];
  const before = read(filePath);
  if (tool === 'Write') return [{ path: filePath, before, after: str(toolInput.content) }];
  if (tool === 'Edit') {
    const oldText = str(toolInput.old_string);
    return [{ path: filePath, before, after: applyEdit(before, oldText, str(toolInput.new_string), toolInput.replace_all === true), oldText }];
  }
  if (tool === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    let after = before;
    const old: string[] = [];
    for (const edit of toolInput.edits as Array<Record<string, unknown>>) {
      old.push(str(edit.old_string));
      after = applyEdit(after, str(edit.old_string), str(edit.new_string), edit.replace_all === true);
    }
    return [{ path: filePath, before, after, oldText: old.join('\n') }];
  }
  return [];
}

/** Lines of `after` not in `before`, counting repeats, so reordering alone changes nothing. */
export function changedLines(before: string, after: string): number[] {
  const counts = new Map<string, number>();
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  const changed: number[] = [];
  after.split('\n').forEach((line, i) => {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else if (line.trim()) changed.push(i);
  });
  return changed;
}

const HEADING = /^#{1,6}\s/;
const MAX_LINES_UNDER_HEADING = 40;

export interface ChangedBlocks {
  /** The changed blocks, each with its heading, joined by blank lines. */
  text: string;
  /**
   * The lines that can be refused. A changed heading re-attributes what sits under it, so those
   * lines count too: otherwise renaming a section to "Justin's standing rules" could never fail.
   */
  refusable: string[];
}

export function changedBlocks(after: string, changed: number[]): ChangedBlocks {
  const lines = after.split('\n');
  const ranges: Array<{ start: number; end: number; heading: number | null }> = [];
  const refusable = new Set<string>();
  for (const at of changed) {
    refusable.add(lines[at].trim());
    let heading: number | null = null;
    for (let i = at; i >= 0; i -= 1) if (HEADING.test(lines[i])) { heading = i; break; }
    let start = at;
    let end = at;
    if (HEADING.test(lines[at])) {
      for (end = at; end + 1 < lines.length && end - at < MAX_LINES_UNDER_HEADING && !HEADING.test(lines[end + 1]); end += 1) {
        if (lines[end + 1].trim()) refusable.add(lines[end + 1].trim());
      }
    } else {
      while (start > 0 && lines[start - 1].trim() && !HEADING.test(lines[start - 1])) start -= 1;
      while (end + 1 < lines.length && lines[end + 1].trim() && !HEADING.test(lines[end + 1])) end += 1;
    }
    ranges.push({ start, end, heading });
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  const blocks = merged.map(({ start, end, heading }) => {
    const body = lines.slice(start, end + 1).join('\n');
    return heading !== null && heading < start ? `${lines[heading]}\n${body}` : body;
  });
  return { text: blocks.join('\n\n'), refusable: [...refusable] };
}
