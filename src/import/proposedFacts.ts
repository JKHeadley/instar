/**
 * Memory facts proposed from an import (docs/specs/import-from-claude-chatgpt.md §B.9). Deterministic,
 * not a model: a model judging imported text is itself the injection target. Every candidate is shown to
 * the person next to its source line; anything that reads as an instruction to an AI is flagged and
 * shown unticked with the reason. Nothing is stored unless the person ticks it.
 */
import { removeSecrets } from './exportParsers.js';

export interface ProposedFact {
  text: string;
  source: string;
  /** Set when the line reads like an instruction; such facts start unticked. */
  flag: string | null;
  ticked: boolean;
}

const MAX_FACT_CHARS = 300;
const INSTRUCTION = /^\s*(always|never|ignore|disregard|forget|you must|you should|you are|you will|do not|don't|system\b|assistant\b|from now on)\b/i;
const ADDRESSED = /\b(ignore (all|any|previous|prior)|system prompt|as an ai|you are (an?|the) (ai|assistant|model)|your instructions)\b/i;
const URL = /\bhttps?:\/\/|\bwww\./i;

/** One candidate fact per line or bullet of the memory text, de-duplicated. */
export function proposeFacts(memoryText: string): ProposedFact[] {
  const seen = new Set<string>();
  const out: ProposedFact[] = [];
  for (const rawLine of memoryText.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (line.length < 3) continue;
    const { text: clean } = removeSecrets(line);
    const text = clean.length > MAX_FACT_CHARS ? `${clean.slice(0, MAX_FACT_CHARS - 1)}…` : clean;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let flag: string | null = null;
    if (INSTRUCTION.test(text) || ADDRESSED.test(text)) flag = 'reads like an instruction';
    else if (URL.test(text)) flag = 'contains a link';
    else if (clean.length > MAX_FACT_CHARS) flag = 'long; check it is about you';
    out.push({ text, source: clean.slice(0, 1000), flag, ticked: flag === null });
  }
  return out;
}

/** Pulls the memory text out of a Claude memories.json (shape varies: strings anywhere in it). */
export function memoryTextFromClaudeExport(raw: unknown): string {
  const lines: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6) return;
    if (typeof v === 'string') { lines.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/uuid|^id$|_id$|_at$|^created|^updated/i.test(k)) continue; // ids and times are not memories
        walk(x, depth + 1);
      }
    }
  };
  walk(raw, 0);
  return lines.join('\n');
}
