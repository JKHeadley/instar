/**
 * Splits a top-level JSON array into its elements without holding the whole file
 * (docs/specs/import-from-claude-chatgpt.md §E: large conversations.json files are read incrementally,
 * and one conversation is capped at 50 MB). Each object element is parsed on its own; an element over
 * the cap is skipped and reported, never buffered.
 */
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

export const MAX_ELEMENT_CHARS = 50 * 1024 * 1024;

export type ArrayItem =
  | { kind: 'value'; value: unknown }
  | { kind: 'skipped'; reason: 'too-big' | 'unreadable' | 'not-an-object' };

export async function* jsonArrayItems(stream: Readable, maxElementChars: number = MAX_ELEMENT_CHARS): AsyncGenerator<ArrayItem> {
  const decoder = new StringDecoder('utf8');
  let depth = 0; // 0 before '[', 1 inside the array, 2+ inside an element
  let started = false;
  let inString = false;
  let escape = false;
  let parts: string[] = [];
  let partLen = 0;
  let oversize = false;
  let segStart = -1;

  const flushSegment = (chunk: string, end: number) => {
    if (segStart < 0 || oversize) return;
    const piece = chunk.slice(segStart, end);
    partLen += piece.length;
    if (partLen > maxElementChars) { oversize = true; parts = []; return; }
    parts.push(piece);
  };

  for await (const raw of stream) {
    const chunk = typeof raw === 'string' ? raw : decoder.write(raw as Buffer);
    const out: ArrayItem[] = [];
    if (depth >= 2) segStart = 0;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (depth === -1) {
        if (!/\s/.test(c)) throw new Error('trailing-data');
        continue;
      }
      if (inString) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        if (depth === 1) out.push({ kind: 'skipped', reason: 'not-an-object' });
        inString = true;
        continue;
      }
      if (!started) {
        if (c === '[') { started = true; depth = 1; continue; }
        if (/\s/.test(c)) continue;
        throw new Error('not-an-array');
      }
      if (c === '{' || c === '[') {
        if (depth === 1) {
          if (c === '[') { out.push({ kind: 'skipped', reason: 'not-an-object' }); }
          parts = []; partLen = 0; oversize = false; segStart = i;
        }
        depth++;
        continue;
      }
      if (c === '}' || c === ']') {
        depth--;
        if (depth === 1) {
          flushSegment(chunk, i + 1);
          segStart = -1;
          if (oversize) out.push({ kind: 'skipped', reason: 'too-big' });
          else if (c === '}') {
            try { out.push({ kind: 'value', value: JSON.parse(parts.join('')) }); }
            catch { out.push({ kind: 'skipped', reason: 'unreadable' }); } // @silent-fallback-ok: counted and listed in the preview
          }
          parts = []; partLen = 0; oversize = false;
        } else if (depth === 0) {
          if (c !== ']') throw new Error('not-an-array');
          started = false;
          depth = -1; // Keep consuming the stream so a concatenated second export cannot be hidden.
        }
        continue;
      }
    }
    if (depth >= 2) flushSegment(chunk, chunk.length);
    segStart = -1;
    for (const item of out) yield item;
  }
  if (!started && depth !== -1) throw new Error('not-an-array');
  if (depth > 0) throw new Error('ended-early');
}
