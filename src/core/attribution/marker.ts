/**
 * The source marker: how a statement credited to a person points at the logged
 * message it came from. Spec: docs/specs/attribution-paper-trail.md section 1.
 *
 * Sourced:   Justin: "exact words" [source: telegram 102965/123160 2026-10-08]
 * Unsourced: ... [source unknown]  or  ... [my inference]
 *
 * Parsing is exact and needs no model. Whether a marker is TRUE is decided later,
 * by SourceResolver and the judge; a marker is only ever a claim.
 */

export const SOURCE_CHANNELS = ['telegram', 'slack', 'imessage', 'whatsapp', 'app', 'threadline'] as const;
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

export interface SourceRef {
  channel: SourceChannel;
  conversation: string;
  message: string;
  /** The record's UTC date. Lets a ref be classified after its row has rotated out. */
  date: string;
}

export interface ParsedMarker {
  ref: SourceRef;
  raw: string;
  index: number;
}

export interface MalformedMarker {
  raw: string;
  index: number;
  reason: 'unknown-channel' | 'bad-shape' | 'bad-date';
}

export type SourceLabel = 'source-unknown' | 'my-inference';

const ID = "[A-Za-z0-9._:+%-]{1,128}";
const WELL_FORMED = new RegExp(`^\\[source: ([a-z]+) (${ID})/(${ID}) (\\d{4}-\\d{2}-\\d{2})\\]$`);
// Case-sensitive and bracketed, so prose about sources is not read as a marker.
const CANDIDATE = /\[source: [^\]\n]{0,300}\]/g;
const LABEL = /\[(source unknown|my inference)\]/g;

function validDate(value: string): boolean {
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** Percent-encodes an id so any platform's id fits the grammar. */
export function encodeSourceId(id: string): string {
  return id.replace(/[^A-Za-z0-9._:+-]/g, (ch) =>
    Array.from(Buffer.from(ch, 'utf8'))
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      .join(''),
  );
}

export function decodeSourceId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export function formatMarker(ref: SourceRef): string {
  return `[source: ${ref.channel} ${encodeSourceId(ref.conversation)}/${encodeSourceId(ref.message)} ${ref.date}]`;
}

export function parseMarkers(text: string): { markers: ParsedMarker[]; malformed: MalformedMarker[] } {
  const markers: ParsedMarker[] = [];
  const malformed: MalformedMarker[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const parts = WELL_FORMED.exec(raw);
    if (!parts) {
      malformed.push({ raw, index, reason: 'bad-shape' });
      continue;
    }
    const [, channel, conversation, message, date] = parts;
    if (!(SOURCE_CHANNELS as readonly string[]).includes(channel)) {
      malformed.push({ raw, index, reason: 'unknown-channel' });
      continue;
    }
    if (!validDate(date)) {
      malformed.push({ raw, index, reason: 'bad-date' });
      continue;
    }
    markers.push({
      raw,
      index,
      ref: {
        channel: channel as SourceChannel,
        conversation: decodeSourceId(conversation),
        message: decodeSourceId(message),
        date,
      },
    });
  }
  return { markers, malformed };
}

export function findLabels(text: string): Array<{ label: SourceLabel; index: number }> {
  return Array.from(text.matchAll(LABEL), (match) => ({
    label: match[1] === 'source unknown' ? ('source-unknown' as const) : ('my-inference' as const),
    index: match.index ?? 0,
  }));
}

/** Normalizes for the exact-words check: whitespace, curly quotes and case only. */
export function normalizeQuote(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function quoteIsInRecord(quote: string, recordText: string): boolean {
  const needle = normalizeQuote(quote);
  return needle.length > 0 && normalizeQuote(recordText).includes(needle);
}
