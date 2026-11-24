import type { AppConversationService } from './AppConversationService.js';
import { isAppConversationKey } from './appConversationText.js';
import type { AuthorizedProjectListSnapshot } from './ProjectListComparison.js';

interface BindingObservation {
  keys: Array<{ conversationKey: string; hasInitiativePointer: boolean }>;
  /** The exact bound, current, complete binding inventory is still usable. */
  release(): boolean;
}

export interface ChiefOfStaffComparisonOwnerBoundary {
  app: Pick<AppConversationService, 'liveConversation'>;
  /** Positive native owner provenance and current destination access, including erasure. */
  mayReadNativeOwnerApp(nativeKey: string): boolean;
  /** Synchronous proof that this same owner, home and enrolled native App view remain current. */
  isCurrent(): boolean;
}

export interface ChiefOfStaffProjectComparisonOptions {
  journal: { read(signal: AbortSignal): Promise<BindingObservation | null> };
  /**
   * Issue this only for the positively enrolled disposable view. The journal
   * work and its release proof must be independent of hidden rows for this
   * owner. A general owner role or a lack of replies from peers is insufficient.
   */
  ownerBoundary(): ChiefOfStaffComparisonOwnerBoundary | null;
  maxBindings?: number;
}

const DEFAULT_MAX_BINDINGS = 250;

function project(
  keys: BindingObservation['keys'], boundary: ChiefOfStaffComparisonOwnerBoundary,
): AuthorizedProjectListSnapshot | null {
  const items: AuthorizedProjectListSnapshot['items'] = [];
  const seen = new Set<string>();
  let coverage: AuthorizedProjectListSnapshot['coverage'] = 'complete';
  let relationsComplete = true;
  for (const binding of keys) {
    const id = binding.conversationKey;
    // This helper cannot prove coverage of a binding outside the enrolled
    // native App-only fixture. Do not open any alternate title source.
    if (!id.startsWith('app:') || !isAppConversationKey(id.slice(4)) || seen.has(id)) return null;
    seen.add(id);
    const nativeKey = id.slice(4);
    if (boundary.mayReadNativeOwnerApp(nativeKey) !== true) continue;
    const row = boundary.app.liveConversation(nativeKey);
    if (!row || row.tombstoned || row.ownerPerson !== null) continue;
    if (row.conversationKey !== nativeKey || !row.createdAt || typeof row.title !== 'string' || !row.title.trim()) {
      coverage = 'partial';
      relationsComplete = false;
      continue;
    }
    if (binding.hasInitiativePointer !== false) {
      // Existing initiativeId strings carry neither an attested target nor
      // continuity. Do not expose the value, manufacture a link, or infer one.
      relationsComplete = false;
      items.push({ id, title: row.title });
    } else {
      items.push({ id, title: row.title, relation: { state: 'none' } });
    }
  }
  return { coverage, items, relationsComplete };
}

function sameProjection(a: AuthorizedProjectListSnapshot, b: AuthorizedProjectListSnapshot | null): boolean {
  return b !== null && a.coverage === b.coverage && a.relationsComplete === b.relationsComplete && a.items.length === b.items.length
    && a.items.every((row, index) => {
      const other = b.items[index];
      return row.id === other.id && row.title === other.title && row.relation?.state === other.relation?.state;
    });
}

/** Read-only composition for the approved disposable owner-native App slice. */
export function createChiefOfStaffProjectComparisonSource(options: ChiefOfStaffProjectComparisonOptions) {
  const maxBindings = options.maxBindings ?? DEFAULT_MAX_BINDINGS;
  if (!Number.isSafeInteger(maxBindings) || maxBindings < 1) throw new RangeError('Invalid project binding limit');

  return {
    async read(signal: AbortSignal) {
      try {
        if (signal.aborted) return null;
        const boundary = options.ownerBoundary();
        if (!boundary || boundary.isCurrent() !== true) return null;
        // Preserve the journal reader's worker lifetime, including cancellation.
        const observation = await options.journal.read(signal);
        if (!observation || signal.aborted || observation.keys.length > maxBindings
          || boundary.isCurrent() !== true || observation.release() !== true) return null;
        const keys = observation.keys.map(({ conversationKey, hasInitiativePointer }) => ({ conversationKey, hasInitiativePointer }));
        const snapshot = project(keys, boundary);
        if (!snapshot || signal.aborted || boundary.isCurrent() !== true) return null;

        return {
          snapshot,
          release(): boolean {
            try {
              if (signal.aborted || boundary.isCurrent() !== true || observation.release() !== true) return false;
              // The caller's final release section has no await. Changes to
              // previously denied rows have no effect unless their authorized
              // projection has changed.
              return sameProjection(snapshot, project(keys, boundary))
                && boundary.isCurrent() === true && !signal.aborted;
            } catch {
              return false;
            }
          },
        };
      } catch {
        return null;
      }
    },
  };
}
