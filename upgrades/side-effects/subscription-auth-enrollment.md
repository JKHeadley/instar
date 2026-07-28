# Side-Effects Review — Mobile-first enrollment wizard (P2.1)

## Scope of change

- `src/core/PendingLoginStore.ts` (new) — durable ledger of in-flight logins (public artifacts only).
- `src/core/EnrollmentWizard.ts` (new) — orchestration: start + auto-reissue-on-expiry + complete.
- `src/core/FrameworkLoginDriver.ts` (new) — concrete LoginDriver: spawn framework login under the account's config home, scrape the public code/URL.
- `src/server/routes.ts` — RouteContext `enrollmentWizard` + 4 routes under `/subscription-pool`.
- `src/server/AgentServer.ts` — `enrollmentWizard?` option + private field + RouteContext plumbing.
- `src/commands/server.ts` — instantiate the store + driver + wizard; pass to AgentServer; background reissue tick (unref'd).
- tests (unit + integration + e2e) + api.md.

## The concern: a wizard that spawns a login process + writes a durable store

The new authority here is (a) spawning a framework login command, and (b) writing
a durable store. The safety design:

- **Spawning is injected + scoped.** The interactive leg (driving the login CLI)
  is the injected `LoginDriver`. The concrete `FrameworkLoginDriver` spawns the
  framework's OWN login command under a per-account `CLAUDE_CONFIG_DIR` — it does
  not extract, read, or transmit any credential. The credential is written by the
  framework's own client into that config home; instar only reads the PUBLIC
  artifact (verification URL + short code) the provider prints to be typed into
  its own page.
- **No secret can enter the store by construction.** `PendingLoginStore`'s record
  type has no token/secret field. There is nothing to smuggle a credential into —
  the same structural guarantee P1.1 enforces for the account registry. The
  integration test asserts no token-like field ever appears in a response body.
- **Dark + operator/internal.** The routes nest under `/subscription-pool`
  (already INTERNAL, not surfaced in /capabilities until graduation) and do
  nothing until an operator starts an enrollment. No live-session path is touched.
- **The background tick is inert + bounded.** The reissue sweep only re-drives
  logins that are already EXPIRED; with no pending logins it is a no-op. The timer
  is `unref()`'d so it never holds the process open.

## Authority / autonomy analysis

- **Tier-2 by association** (spawns a process, writes a store) but ships dark +
  operator-gated. The driving spec (`subscription-auth-p2.1-enrollment.md`) is
  converged + `approved: true` (Justin, Telegram topic 20905, 2026-06-07 — blanket
  approval of the remaining phases under the autonomy directive).
- **No autonomous credential handling.** The agent never holds a token; the
  operator approves at the provider's own page. The wizard's only autonomy is
  re-issuing an EXPIRED public code — which carries no secret and strands nothing.
- **Honest failure.** A driver failure during a reissue is logged + the login is
  left expired for the next sweep (no false "reissued" claim); a scrape timeout
  throws and the login is left for the operator (no fabricated artifact).

## Failure modes considered

- Login code expires before the operator acts → auto-reissued on the next sweep (the headline fix).
- Driver/scrape failure → logged, login left expired, sweep continues (one bad login can't abort it).
- Server restart mid-enrollment → the pending login persisted to disk; it reloads and stays on the surface.
- Wizard unwired (dark) → list/sweep routes answer 200 `{ enabled:false }`, never 503.
- No pending logins → the background sweep is a no-op; the timer is unref'd.

## Blast radius

Contained by the dark/operator-gated rollout + the credential-safety-by-construction
store. With no enrollment started (the default), none of this code executes beyond
an inert sweep over an empty store. The risk surface is the spawn-+-scrape path,
exercised only when an operator explicitly starts an enrollment.

## Framework generality

The wizard is framework-agnostic in shape, framework-specific in effect:

- `EnrollmentWizard` + `PendingLoginStore` are fully generic — they carry
  `provider` + `framework` fields and treat the login artifact uniformly. The
  per-provider default flow kind (`defaultKind`) encodes the only branch: Codex/
  OpenAI = device-code (its endorsed flow); everyone else = url-code-paste (the
  phone-friendly Claude path). Adding a framework is a one-line default + a driver
  case, not a structural change.
- `FrameworkLoginDriver` is where framework specificity lives, and it is honest
  about it: the spawn command + the scrape patterns are per-flow (device-code vs
  url-code-paste), and the pure `parseArtifact` handles both. The two real flows
  (Codex device-code, Claude URL-paste) are implemented; gemini-cli / pi-cli slot
  into the same `framework` union and reuse the same scrape patterns when their
  login flows are wired — no Claude-only assumption is baked into the abstraction.
- Per the constitution's "Framework-Agnostic — and Framework-Optimizing": the
  store + wizard stay neutral across providers; the optimization (which login flow,
  what to scrape) is per-framework in the driver. This matches the standard's
  Claude-first scope (Justin's decision 3) without foreclosing the others.

## Migration / parity

All three new classes are additive (new files; the store is created lazily on
first enrollment). Routes stay under the already-classified `/subscription-pool`
INTERNAL prefix (no CapabilityIndex change until graduation). An optional
`subscriptionPool.enrollment` config block tunes TTL/sweep cadence; absent, shipped
defaults apply. No existing behaviour changes. Ships via dist.
