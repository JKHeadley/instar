/**
 * TestWorkspacePrincipalSource — the sanctioned, workspace-scoped principal source
 * for the Slack live-test scenario cast (roadmap 0.3 entry condition).
 *
 * WHY THIS EXISTS (the 2026-07-01 lesson): the June scenario drives seeded the
 * five-seat test cast into the production user registry (`users.json`). The
 * silent-loss registry rebuild removed them, and the fixture-identity guard
 * ("Test Identity Never Enters Production State", silent-loss-refusal-conservation
 * §2.D) now — correctly — refuses to let them back in. Principal resolution for
 * the live-test workspace therefore needs a home that is NOT the production
 * registry. This module is that home.
 *
 * THE PARTITION INVARIANT (the load-bearing design decision):
 *   - The production registry REFUSES fixture identities (the existing guard,
 *     untouched by this module).
 *   - This source ACCEPTS ONLY fixture identities — every cast entry's
 *     slackUserId must match the SAME single matcher the production guard uses
 *     (`matchesTestIdentityToken` from `users/testIdentityMarkers.ts`). A
 *     non-fixture UID is refused at load, loudly.
 *   By construction an identity can live in exactly one of the two stores —
 *   a real employee's UID can never be smuggled into the cast to gain a role
 *   outside the audited registration path, and standing up a NEW test cast
 *   structurally forces the fixture-marker list to be updated first (which is
 *   what keeps the production guard aware of the new fixtures). The single
 *   matcher can never drift into two lists.
 *
 * THE SELF-DECLARATION MARKER (fail-closed to ignoring the cast): the config
 * object MUST self-declare `testWorkspace: true`. Without that marker the source
 * refuses to load a SINGLE principal — it disables itself, emits ONE loud log
 * line, and every lookup returns null (production resolution is byte-identical to
 * having no cast at all). The marker exists so a cast config can never be
 * activated by accident: sanctioning a live-test workspace is a deliberate,
 * self-evident opt-in, never an implicit side effect of the block existing.
 *
 * SCOPING (fail-closed): the cast resolves ONLY while the Slack adapter's
 * VERIFIED connected team id (captured from Slack's own `auth.test` response at
 * adapter start — never from config alone) equals the configured test
 * `workspaceId`. Before verification, on verification failure, or when the
 * adapter is connected to any other workspace, every lookup returns null and
 * the resolver falls through to its existing safe default (unregistered guest).
 *
 * READ-ONLY BY DESIGN: this source never writes anything — not users.json, not
 * a state file. It is consulted ONLY by the permission gate's principal
 * resolver (production-registry-first via {@link ChainedUserLookup}); it is
 * invisible to UserManager, sender auth (`authorizedUserIds`), cross-machine
 * replication, and every other identity surface.
 *
 * Note on imports: `testIdentityMarkers.ts` is dependency-light (node builtins +
 * a type-only core import), so reusing its matcher keeps the permission module
 * free of runtime core dependencies — and keeps ONE fixture matcher, not two.
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.2.1;
 * runbook: docs/specs/SLACK-ORG-TEST-WORKSPACE-RUNBOOK.md.
 */

import { matchesTestIdentityToken } from '../users/testIdentityMarkers.js';
import { ORG_ROLES } from './types.js';
import type { ResolvedUserRecord, UserLookup } from './SlackPrincipalResolver.js';

/** One seat of the live-test scenario cast (configured in the Slack config block). */
export interface TestCastEntry {
  /** The seat's REAL Slack user id in the live-test workspace (must be a fixture-marker id). */
  slackUserId: string;
  /** Display name for conversational messages — never a basis for authority. */
  name?: string;
  /** The org role this seat plays (owner / admin / member / contributor / …). */
  orgRole: string;
}

/** Why a configured cast entry was refused at load. */
export interface RejectedCastEntry {
  slackUserId: string;
  reason:
    | 'missing-slack-user-id'
    | 'not-a-fixture-identity'
    | 'invalid-role'
    | 'duplicate'
    | 'cast-cap-exceeded';
}

/**
 * Hard ceiling on cast seats. The scenario cast is five seats today; the cap
 * exists so the test-cast path can never quietly become a shadow user registry.
 */
export const MAX_TEST_CAST_SEATS = 12;

export interface TestWorkspacePrincipalSourceOpts {
  /** The sanctioned live-test workspace/team id (T…) this cast is scoped to. */
  workspaceId: string;
  /**
   * The REQUIRED self-declaration marker. The source refuses to load ANY
   * principal unless this is exactly `true` — fail-closed to ignoring the cast
   * (one loud log line, never a crash, never a production-registry effect).
   */
  testWorkspace: boolean;
  /** The configured cast seats. Invalid entries are refused (see {@link RejectedCastEntry}). */
  principals: TestCastEntry[];
  /**
   * Supplier of the adapter's VERIFIED connected team id (from `auth.test`).
   * Returning null/undefined (not yet verified, verification failed) keeps the
   * source inert — fail-closed to the resolver's unregistered-guest default.
   */
  getVerifiedWorkspaceId: () => string | null | undefined;
}

/** Why the whole source was disabled at construction (loads zero principals). */
export type TestCastDisabledReason = 'missing-testWorkspace-marker';

export class TestWorkspacePrincipalSource implements UserLookup {
  private readonly bySlackId = new Map<string, ResolvedUserRecord>();
  private readonly workspaceId: string;
  private readonly getVerifiedWorkspaceId: () => string | null | undefined;
  /** Entries refused at load (surfaced loudly by the wiring site). */
  readonly rejected: RejectedCastEntry[] = [];
  /**
   * True when the whole source refused to load (the self-declaration marker was
   * absent). A disabled source holds ZERO principals and resolves everything to
   * null — production resolution is byte-identical to having no cast configured.
   */
  readonly disabled: boolean = false;
  /** Why the source disabled itself (only set when {@link disabled} is true). */
  readonly disabledReason?: TestCastDisabledReason;

  constructor(opts: TestWorkspacePrincipalSourceOpts) {
    if (!opts.workspaceId || typeof opts.workspaceId !== 'string' || !opts.workspaceId.trim()) {
      throw new Error('TestWorkspacePrincipalSource requires a non-empty workspaceId (the sanctioned live-test workspace)');
    }
    // Stored TRIMMED (second-pass review note): Slack's own `team_id` never
    // carries whitespace, so a config value with a stray space would otherwise
    // make the scope equality permanently false — an inert cast (fail-closed,
    // but a silent config foot-gun the boot log alone would have to catch).
    this.workspaceId = opts.workspaceId.trim();
    this.getVerifiedWorkspaceId = opts.getVerifiedWorkspaceId;

    // THE SELF-DECLARATION GATE (fail-closed): without an explicit
    // `testWorkspace: true` the cast is IGNORED entirely — zero principals
    // loaded, one loud line, no throw, no production impact. The loud line lives
    // HERE (not only at the wiring site) so the fail-closed guarantee holds for
    // EVERY caller — Structure > Willpower.
    if (opts.testWorkspace !== true) {
      this.disabled = true;
      this.disabledReason = 'missing-testWorkspace-marker';
      console.warn(
        `[slack] TestWorkspacePrincipalSource IGNORED for workspace ${this.workspaceId} — the testCast config is ` +
        `missing its required "testWorkspace: true" self-declaration. Loading ZERO cast principals (fail-closed; the ` +
        `production user registry is unaffected). Add "testWorkspace": true to sanction the live-test cast.`,
      );
      return; // no principals admitted
    }

    for (const entry of opts.principals ?? []) {
      const slackUserId = typeof entry?.slackUserId === 'string' ? entry.slackUserId.trim() : '';
      if (!slackUserId) {
        this.rejected.push({ slackUserId: String(entry?.slackUserId ?? ''), reason: 'missing-slack-user-id' });
        continue;
      }
      // THE PARTITION INVARIANT: only fixture-marker identities are admitted.
      // Same single matcher as the production guard — never a second list.
      if (!matchesTestIdentityToken(slackUserId)) {
        this.rejected.push({ slackUserId, reason: 'not-a-fixture-identity' });
        continue;
      }
      if (!entry.orgRole || !(ORG_ROLES as readonly string[]).includes(entry.orgRole)) {
        this.rejected.push({ slackUserId, reason: 'invalid-role' });
        continue;
      }
      if (this.bySlackId.has(slackUserId)) {
        this.rejected.push({ slackUserId, reason: 'duplicate' });
        continue;
      }
      if (this.bySlackId.size >= MAX_TEST_CAST_SEATS) {
        this.rejected.push({ slackUserId, reason: 'cast-cap-exceeded' });
        continue;
      }
      this.bySlackId.set(slackUserId, {
        // Namespaced id so a cast principal is visibly a test seat in every
        // ledger row / audit surface it appears in.
        id: `test-cast:${slackUserId}`,
        name: entry.name?.trim() || slackUserId,
        permissions: [entry.orgRole],
        orgRole: entry.orgRole,
      });
    }
  }

  /** Number of admitted cast seats. */
  get size(): number {
    return this.bySlackId.size;
  }

  /**
   * Resolve a cast seat — ONLY while the verified connected workspace equals the
   * sanctioned test workspace. Any uncertainty (no verified id yet, supplier
   * throw, mismatch) resolves null: fail-closed to unregistered guest.
   */
  resolveFromSlackUserId(slackUserId: string): ResolvedUserRecord | null {
    // A disabled source (missing marker) holds no principals — this is redundant
    // with the empty map but makes the fail-closed contract explicit.
    if (this.disabled) return null;
    let verified: string | null | undefined;
    try {
      verified = this.getVerifiedWorkspaceId();
    } catch {
      // Fail-closed: an errored verification supplier keeps the cast inert.
      return null;
    }
    if (!verified || verified !== this.workspaceId) return null;
    return this.bySlackId.get(slackUserId) ?? null;
  }
}

/**
 * ChainedUserLookup — production-registry-first principal resolution.
 *
 * Sources are consulted in order; the first non-null record wins. The wiring
 * site puts the production registry FIRST, so a genuinely registered user can
 * never be shadowed or role-escalated by a cast entry, and the cast is only
 * ever a fallback for identities the production registry does not know.
 * A throwing source is skipped (resolution must never break the message path).
 */
export class ChainedUserLookup implements UserLookup {
  constructor(private readonly sources: UserLookup[]) {}

  resolveFromSlackUserId(slackUserId: string): ResolvedUserRecord | null {
    for (const source of this.sources) {
      try {
        const record = source.resolveFromSlackUserId(slackUserId);
        if (record) return record;
      } catch {
        // A faulty source must never break principal resolution — fall through
        // to the next source (ultimately the unregistered-guest default).
      }
    }
    return null;
  }
}
