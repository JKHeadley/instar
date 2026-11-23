/**
 * Reads a Claude or ChatGPT export zip in two passes (docs/specs/import-from-claude-chatgpt.md §B.10, §D):
 * previewExport() counts what would be copied and writes nothing; applyExport() writes, and runs only
 * after the person has seen the preview. Both stream the zip, so a large export never sits in memory.
 */
import { findEntry, listEntries, openEntry, ZipRefused, type ZipEntry } from './safeZip.js';
import { jsonArrayItems } from './jsonArrayStream.js';
import {
  parseChatGptConversation, parseClaudeConversation, parseClaudeProject,
  type ImportedConversation, type ExportSource,
} from './exportParsers.js';
import { memoryTextFromClaudeExport, proposeFacts, type ProposedFact } from './proposedFacts.js';
import type { ImportedHistoryStore } from './ImportedHistoryStore.js';

export const MAX_CONVERSATIONS = 50_000;
const FLUSH_EVERY = 500;

export interface ImportPreview {
  from: ExportSource;
  chats: number;
  messages: number;
  projects: number;
  splitMessages: number;
  redactions: number;
  droppedBranches: number;
  skipped: { tooBig: number; unreadable: number; overLimit: number };
  /** File names the person can drop in (Claude doesn't export project files). */
  projectFiles: string[];
  facts: ProposedFact[];
  /** The plain summary the person reads before confirming. */
  summary: string;
}

/** Which app the export came from, from its files. */
export function detectSource(entries: ZipEntry[]): ExportSource {
  if (findEntry(entries, 'chat.html') || findEntry(entries, 'message_feedback.json') || findEntry(entries, 'shared_conversations.json')) return 'chatgpt';
  if (findEntry(entries, 'users.json') || findEntry(entries, 'projects.json') || findEntry(entries, 'memories.json')) return 'claude';
  throw new ZipRefused("This doesn't look like a Claude or ChatGPT export. It has no conversations file the importer knows.");
}

function parserFor(from: ExportSource): (raw: unknown) => ImportedConversation | null {
  return from === 'claude' ? parseClaudeConversation : parseChatGptConversation;
}

async function readWholeJson(zipPath: string, e: ZipEntry, maxBytes: number): Promise<unknown> {
  if (e.size > maxBytes) return null;
  const chunks: Buffer[] = [];
  try { for await (const c of openEntry(zipPath, e)) chunks.push(c as Buffer); } catch { return null; } // @silent-fallback-ok: an unreadable optional file is reported as none
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { return null; } // @silent-fallback-ok: an unreadable optional file is reported as none
}

interface Walk {
  from: ExportSource;
  onConversation: (c: ImportedConversation) => void;
  onSkipped: (why: 'tooBig' | 'unreadable' | 'overLimit') => void;
}

async function walkConversations(zipPath: string, entries: ZipEntry[], w: Walk): Promise<void> {
  const e = findEntry(entries, 'conversations.json');
  if (!e) throw new ZipRefused('This export has no conversations file (conversations.json).');
  const parse = parserFor(w.from);
  let n = 0;
  try {
    for await (const item of jsonArrayItems(openEntry(zipPath, e))) {
      if (item.kind === 'skipped') { w.onSkipped(item.reason === 'too-big' ? 'tooBig' : 'unreadable'); continue; }
      if (n >= MAX_CONVERSATIONS) { w.onSkipped('overLimit'); continue; }
      const conv = parse(item.value);
      if (!conv) { w.onSkipped('unreadable'); continue; }
      n++;
      w.onConversation(conv);
    }
  } catch (err) {
    if (err instanceof ZipRefused) throw err;
    throw new ZipRefused("The conversations file in this export couldn't be read. Try exporting again.");
  }
}

async function readProjects(zipPath: string, entries: ZipEntry[], from: ExportSource) {
  const e = from === 'claude' ? findEntry(entries, 'projects.json') : undefined;
  if (!e || e.size === 0) return []; // an empty optional file means no projects
  const out = [];
  try {
    for await (const item of jsonArrayItems(openEntry(zipPath, e))) {
      if (item.kind !== 'value') continue;
      const p = parseClaudeProject(item.value);
      if (p) out.push(p);
    }
  } catch (err) {
    if (err instanceof ZipRefused) throw err;
    throw new ZipRefused("The projects file in this export couldn't be read. Try exporting again.");
  }
  return out;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export async function previewExport(zipPath: string): Promise<ImportPreview> {
  const entries = listEntries(zipPath);
  const from = detectSource(entries);
  const p: ImportPreview = {
    from, chats: 0, messages: 0, projects: 0, splitMessages: 0, redactions: 0, droppedBranches: 0,
    skipped: { tooBig: 0, unreadable: 0, overLimit: 0 }, projectFiles: [], facts: [], summary: '',
  };
  await walkConversations(zipPath, entries, {
    from,
    onConversation: (c) => {
      p.chats++;
      p.messages += new Set(c.messages.map((m) => m.key.replace(/#\d+$/, ''))).size;
      p.splitMessages += c.stats.splitMessages;
      p.redactions += c.stats.redactions;
      p.droppedBranches += c.stats.droppedBranches;
    },
    onSkipped: (why) => { p.skipped[why]++; },
  });
  const projects = await readProjects(zipPath, entries, from);
  p.projects = projects.length;
  for (const pr of projects) { p.redactions += pr.redactions; p.projectFiles.push(...pr.fileNames); }
  const mem = from === 'claude' ? findEntry(entries, 'memories.json') : undefined;
  if (mem) p.facts = proposeFacts(memoryTextFromClaudeExport(await readWholeJson(zipPath, mem, 5 * 1024 * 1024)));

  const app = from === 'claude' ? 'Claude' : 'ChatGPT';
  const lines = [`We'll copy ${plural(p.chats, 'chat', 'chats')}${p.projects ? ` and ${plural(p.projects, 'project', 'projects')}` : ''} from ${app}. They stay on this computer.`];
  if (p.redactions) lines.push(`${plural(p.redactions, 'thing that looked like a password or key was', 'things that looked like passwords or keys were')} removed.`);
  if (p.splitMessages) lines.push(`${plural(p.splitMessages, 'very long message', 'very long messages')} will be shown in parts.`);
  if (p.droppedBranches) lines.push(`${plural(p.droppedBranches, 'earlier draft reply', 'earlier draft replies')} (ones you regenerated) won't be copied.`);
  const skipped = p.skipped.tooBig + p.skipped.unreadable + p.skipped.overLimit;
  if (skipped) lines.push(`${plural(skipped, 'chat', 'chats')} couldn't be copied (too big or unreadable).`);
  if (p.projectFiles.length) lines.push(`${app}'s export leaves out your project files (${plural(p.projectFiles.length, 'file', 'files')}); you can drop them in afterwards.`);
  if (p.facts.length) lines.push(`${plural(p.facts.length, 'thing', 'things')} ${app} remembered about you will be shown for you to keep or skip.`);
  p.summary = lines.join(' ');
  return p;
}

export interface ApplyResult { chatsAdded: number; chatsUpdated: number; messagesAdded: number; projects: number }

/** Writes the export into the imported store. Call only after the person confirmed the preview. */
export async function applyExport(zipPath: string, store: ImportedHistoryStore): Promise<ApplyResult> {
  const entries = listEntries(zipPath);
  const from = detectSource(entries);
  const r: ApplyResult = { chatsAdded: 0, chatsUpdated: 0, messagesAdded: 0, projects: 0 };
  let seen = 0;
  await walkConversations(zipPath, entries, {
    from,
    onConversation: (c) => {
      const { added, isNew } = store.addConversation(c);
      r.messagesAdded += added;
      if (isNew) r.chatsAdded++;
      else if (added) r.chatsUpdated++;
      if (++seen % FLUSH_EVERY === 0) store.flush();
    },
    onSkipped: () => {},
  }).finally(() => store.flush());
  for (const p of await readProjects(zipPath, entries, from)) { store.addProject(p); r.projects++; }
  store.flush();
  return r;
}
