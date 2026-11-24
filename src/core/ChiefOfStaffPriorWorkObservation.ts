import { chiefOfStaffInboundVerdict } from './chiefOfStaffOwner.js';
import type { ChiefOfStaffPrSearch } from './ChiefOfStaffPrSearch.js';

export type PriorWorkObservationOutcome = 'matched' | 'no-match' | 'limited' | 'unavailable' | 'busy';

export interface DeliveredChiefOfStaffTurn {
  topicId: number;
  senderId: number;
  text: string;
  replay: boolean;
  agentAuthored: boolean;
}

type TurnAuthority = Omit<DeliveredChiefOfStaffTurn, 'text'>;

interface ObservationDependencies {
  enabled(): boolean;
  chiefOfStaffTopic(): number | null;
  owner(): number | undefined;
  lookup: Pick<ChiefOfStaffPrSearch, 'search'>;
  report(outcome: PriorWorkObservationOutcome): void;
}

function distinctiveLiteral(text: string): string | undefined {
  // A literal is only a retrieval hint. The observer never decides the intent
  // of a Telegram message or substitutes its wording.
  const prefix = text.slice(0, 1024);
  return /(?:^|[^\w])(#\d{1,8})(?!\w)/u.exec(prefix)?.[1]
    ?? /(?:^|[^\w.-])([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*\.[a-z]{2,24})(?![\w-])/iu.exec(prefix)?.[1];
}

/** Bounded, non-blocking shadow read. There is no injection or action handle. */
export class ChiefOfStaffPriorWorkObservation {
  private running = false;

  constructor(private readonly deps: ObservationDependencies) {}

  observe(turn: DeliveredChiefOfStaffTurn): void {
    try {
      const { text, ...authority } = turn;
      if (!this.eligible(authority)) return;
      const literal = distinctiveLiteral(text);
      if (!literal) return;
      if (this.running) {
        this.report('busy');
        return;
      }
      this.running = true;
      setImmediate(() => { void this.run(authority, literal); }).unref();
    } catch {
      // An observation dependency cannot change an already accepted delivery.
      this.report('unavailable');
    }
  }

  private eligible(turn: TurnAuthority): boolean {
    return this.deps.enabled() && !turn.replay && !turn.agentAuthored
      && chiefOfStaffInboundVerdict({
        topicId: turn.topicId, senderId: turn.senderId,
        cosTopicId: this.deps.chiefOfStaffTopic(), owner: this.deps.owner(),
      }) === 'owner';
  }

  private async run(turn: TurnAuthority, literal: string): Promise<void> {
    try {
      if (!this.eligible(turn)) return;
      const result = await this.deps.lookup.search(literal);
      if (!this.eligible(turn)) return;
      if (result.knownMatchCount === null) this.report('unavailable');
      else if (result.items.length > 0) this.report('matched');
      else if (result.matchCount === null || result.coverage.open.status !== 'fresh'
        || result.coverage.merged.status !== 'fresh') this.report('limited');
      else this.report('no-match');
    } catch {
      this.report('unavailable');
    } finally {
      this.running = false;
    }
  }

  private report(outcome: PriorWorkObservationOutcome): void {
    try { this.deps.report(outcome); } catch { /* @silent-fallback-ok: shadow observation never changes delivery. */ }
  }
}
