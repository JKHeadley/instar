/**
 * `find` suggests where a claim may have come from. Spec section 2. It filters to eligible records
 * for the person, widens by date and topic when the note names them, searches through TopicMemory,
 * and has the judge rerank a capped set. A miss is `no-literal-match`, never absence, and it never
 * produces a label: a suggestion is only ever shown.
 */
import type { TopicMemory } from '../../memory/TopicMemory.js';
import type { AttributionJudge } from './AttributionJudge.js';
import type { ChannelReaders } from './channelReaders.js';
import { formatMarker, type SourceChannel, type SourceRef } from './marker.js';
import { checkEligibility, type IdentityMap } from './recordEligibility.js';

export interface FindOptions {
  person: string;
  claim: string;
  around?: { date?: string; topicId?: number };
}

export interface FindCandidate { ref: SourceRef; text: string; marker: string; strength: string; machine: string }

export interface FindResult {
  suggestions: FindCandidate[];
  note: 'found' | 'no-literal-match';
  failed: string[];
}

const SEARCHED_CHANNELS: SourceChannel[] = ['slack', 'imessage', 'whatsapp'];
const MAX_CANDIDATES = 12;

const COMMON = new Set(['about', 'after', 'again', 'always', 'before', 'corrected', 'never', 'should', 'standing', 'their', 'there', 'these', 'those', 'where', 'which', 'would', 'rule', 'said', 'told', 'asked']);

/** The claim's distinctive words: what a literal search can actually match. */
export function searchWords(claim: string, person: string): string[] {
  const name = person.toLowerCase();
  const words = claim.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{3,}/gu) ?? [];
  return [...new Set(words)].filter((word) => !COMMON.has(word) && word !== name).slice(0, 6);
}

function refFor(channel: SourceChannel, key: string, timestamp: unknown): SourceRef | null {
  const at = key.indexOf('/');
  if (at < 0 || typeof timestamp !== 'string') return null;
  return { channel, conversation: key.slice(0, at), message: key.slice(at + 1), date: timestamp.slice(0, 10) };
}

export interface LocalFindDeps {
  readers: ChannelReaders;
  identity: IdentityMap;
  topicMemory?: () => TopicMemory | null | undefined;
  machine: string;
}

/** Eligible candidates on this machine. This is what a peer answers with. */
export async function findLocal(deps: LocalFindDeps, options: FindOptions): Promise<FindCandidate[]> {
  const words = searchWords(options.claim, options.person);
  if (words.length === 0) return [];
  const candidates: FindCandidate[] = [];

  const consider = (channel: SourceChannel, key: string, row: Record<string, unknown>) => {
    const ref = refFor(channel, key, row.timestamp);
    if (!ref || typeof row.text !== 'string') return;
    if (options.around?.date && !ref.date.startsWith(options.around.date.slice(0, 7))) return;
    const eligibility = checkEligibility({
      channel,
      conversation: ref.conversation,
      row,
      person: options.person,
      identity: deps.identity,
      authorship: channel === 'telegram' ? deps.readers.authorshipOf(row) : undefined,
    });
    if (!eligibility.eligible) return;
    candidates.push({ ref, text: row.text.slice(0, 600), marker: formatMarker(ref), strength: eligibility.strength, machine: deps.machine });
  };

  const memory = deps.topicMemory?.();
  if (memory?.isReady()) {
    const wanted = new Set<string>();
    for (const word of words) {
      for (const hit of memory.search(word, { limit: 30, ...(options.around?.topicId !== undefined ? { topicId: options.around.topicId } : {}) })) {
        if (hit.fromUser) wanted.add(`${hit.topicId}/${hit.messageId}`);
      }
    }
    for (const [key, row] of await deps.readers.readMany('telegram', wanted)) consider('telegram', key, row);
  } else {
    for (const [key, row] of await deps.readers.searchLog('telegram', words)) consider('telegram', key, row);
  }
  for (const channel of SEARCHED_CHANNELS) {
    for (const [key, row] of await deps.readers.searchLog(channel, words)) consider(channel, key, row);
  }
  return candidates;
}

/** Local plus peers' candidates, reranked by the judge. Reports which machines did not answer. */
export async function findSources(
  deps: LocalFindDeps & { judge: AttributionJudge; askPeers?: (options: FindOptions) => Promise<Array<{ machine: string; answered: boolean; candidates?: FindCandidate[] }>> },
  options: FindOptions,
): Promise<FindResult> {
  const [local, peers] = await Promise.all([findLocal(deps, options), deps.askPeers?.(options) ?? Promise.resolve([])]);
  const failed = peers.filter((peer) => !peer.answered).map((peer) => peer.machine);
  const seen = new Set<string>();
  const merged: FindCandidate[] = [];
  for (const candidate of [...local, ...peers.flatMap((peer) => peer.candidates ?? [])]) {
    if (seen.has(candidate.marker)) continue;
    seen.add(candidate.marker);
    merged.push(candidate);
  }
  const capped = merged.slice(0, MAX_CANDIDATES);
  if (capped.length === 0) return { suggestions: [], note: 'no-literal-match', failed };
  const ranked = await deps.judge.rerank(options.claim, capped.map((candidate) => candidate.text));
  const suggestions = (ranked ?? []).map((index) => capped[index]);
  return { suggestions, note: suggestions.length ? 'found' : 'no-literal-match', failed };
}
