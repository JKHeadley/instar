/**
 * The topic summary table's single writer (context-budget-layered-summaries
 * §6: "the single writer of the topic summary table", "Never two writers";
 * §18 wiring integrity: "H3 is the summary table's only writer when
 * `contextBudget.enabled` is on").
 *
 * `TopicMemory.saveTopicSummary` has exactly ONE caller in `src/`: `write`
 * below (a ratchet test greps for it). Every writer names itself, and the
 * owner predicate decides which writer the table belongs to:
 *
 *  - layers ON (`contextBudget.enabled`, the layer store built at boot): the
 *    table belongs to H3. The legacy writers (`TopicSummarizer`, the
 *    `POST /topic/summary` route) are refused with `summary-written-by-h3`.
 *  - layers OFF (the fleet default): the table belongs to the legacy writers,
 *    exactly as before; an H3 write is refused (`layers-off`), and nothing
 *    builds H3 there anyway.
 *
 * Signal-only toward messages and sessions: this decides only which writer
 * may store a derived summary.
 */
export type SummaryWriter = 'h3' | 'topic-summarizer' | 'post-topic-summary';

export interface SummaryTableBackend {
  saveTopicSummary(topicId: number, summary: string, messageCount: number, lastMessageId: number, purpose?: string | null): void;
}

export type SummaryWriteResult =
  | { written: true; writer: SummaryWriter }
  | { written: false; writer: SummaryWriter; reason: 'summary-written-by-h3' | 'layers-off' };

/** The plain reason a refused legacy writer reports (the 409 body, the log line). */
export const H3_OWNS_REASON = 'With the context layers on, the long-term topic summary is written only by the H3 layer; this writer is turned off so there is never a second writer.';

export class TopicSummaryTable {
  constructor(private readonly backend: SummaryTableBackend, private readonly h3Owns: () => boolean) {}

  /** True when the table belongs to H3 (layers on). */
  ownedByH3(): boolean {
    try { return this.h3Owns() === true; } catch { return false; /* @silent-fallback-ok — an owner predicate that throws reads as layers off, today's behaviour */ }
  }

  /** May this writer write now? (A caller checks before spending on a model call.) */
  admits(writer: SummaryWriter): boolean {
    return writer === 'h3' ? this.ownedByH3() : !this.ownedByH3();
  }

  write(writer: SummaryWriter, topicId: number, summary: string, messageCount: number, lastMessageId: number, purpose?: string | null): SummaryWriteResult {
    const h3 = this.ownedByH3();
    if (writer !== 'h3' && h3) return { written: false, writer, reason: 'summary-written-by-h3' };
    if (writer === 'h3' && !h3) return { written: false, writer, reason: 'layers-off' };
    // A backend failure propagates exactly as it did before this funnel existed (the legacy callers' behaviour is unchanged).
    this.backend.saveTopicSummary(topicId, summary, messageCount, lastMessageId, purpose ?? null);
    return { written: true, writer };
  }
}
