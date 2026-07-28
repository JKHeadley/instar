/**
 * telegramPollOwnership — the pure predicate behind the standby-no-poll guard
 * (Multi-Machine; the 2026-05-29 duplicate-poller 409 cure).
 *
 * Telegram allows exactly ONE getUpdates long-poll per bot token. The lifeline
 * is the poller; with two machines both lifelines polled the same token → a
 * permanent 409-conflict war and nondeterministic delivery. A standby machine
 * must run the full server (so it still joins the session pool) but NOT own the
 * Telegram poll. This decision is a per-machine LOCAL config read — no shared/
 * git-synced coordination — so a credential-less standby can honor it.
 *
 * Pulled out as a pure function so the default-true semantics are unit-testable
 * in isolation (TelegramLifeline.start() itself is not cleanly instantiable).
 */

/** The slice of config this decision reads. */
export interface PollOwnershipConfig {
  multiMachine?: { telegramPolling?: boolean };
}

/**
 * Whether THIS machine's lifeline should own the Telegram long-poll.
 *
 * DEFAULT (flag undefined / multiMachine absent) = TRUE (poll), so every
 * existing single-machine agent is unchanged. ONLY an explicit
 * `multiMachine.telegramPolling === false` suppresses the poll (a standby).
 */
export function shouldOwnTelegramPoll(config: PollOwnershipConfig | undefined | null): boolean {
  return config?.multiMachine?.telegramPolling !== false;
}
