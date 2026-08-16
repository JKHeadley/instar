# Codex `auth.json` fixtures

Fixtures for the codex identity oracle (`docs/specs/codex-enrollment-p1.md` §4).

> The predecessor spec `codex-subscription-enrollment-parity.md` is SUPERSEDED and is retained only
> as a review record. Cite the P1 spec.

## Realness (LA1-6 / XC1-5)

`auth.valid.json` was **derived from a real `codex login` artifact**, not hand-authored:
the generator walked the live file and preserved its exact structure — top-level keys,
the `tokens.*` key set, and the id_token's full **claim set** (`amr`, `at_hash`, `aud`,
`auth_provider`, `auth_time`, `email`, `email_verified`, `exp`, `https://api.openai.com/auth`,
`iat`, `iss`, `jti`, `name`, `rat`, `sid`, `sub`) — while replacing every value that is
secret or identifying. Shape drift in a future CLI version therefore shows up as a test
failure rather than passing against a guessed shape.

Two structural facts are preserved **on purpose**, because tests depend on them:

- **`exp - iat == 3600`** — the codex id_token's real one-hour lifetime, measured
  2026-08-03 against codex-cli 0.145.0 on macOS 15.6.1 / arm64. This is the fact behind
  the rule that identity attestation must **not** check `exp` (see below).
- **`iss` / `aud`** are the genuine public constants (`https://auth.openai.com`,
  `app_EMoamEEZ73f0CkXaXp7hrann`). These are published values the spec pins in
  plaintext; they are not secrets.

## Safety

No fixture contains real credential material. The generator asserts this positively —
it enumerates the real signature, real header segment, real access/refresh tokens, real
account id, and every identifying claim value, and fails if any appears in any fixture.
Signatures are fixed placeholders, so **no fixture can pass a real signature check**;
tests must stub the JWKS verifier.

## Cases

| Fixture | Expected verdict |
|---|---|
| `auth.valid.json` | attests `fixture-account@example.test`. **This is the LIVE-token case. Load it through `load.ts`, which re-stamps `iat`/`exp` at RUN time — the committed file on disk is honestly expired.** It is the only fixture that exercises the production path — every fixture used to be expired, which meant a rule that (however accidentally) REQUIRED `exp` to be in the past would have made the whole suite pass while refusing every real, freshly-refreshed login. A frozen future timestamp is the one case the safe-drift rule forbids — and stamping it at GENERATION time into a COMMITTED file is that same forbidden case with extra steps, which is why liveness moved to the loader. |
| `auth.expired-but-valid.json` | **attests** — `exp` is in the past but the signature and claims are intact. **Its payload must DIFFER from `auth.valid.json`'s**: the two were once byte-identical, which made this pin vacuous — any oracle passing the baseline passed the pin by construction, so it could not discriminate the behavior it exists to protect. This is the R4-AUTHOR-1 / XC5-1 regression pin: a signature does not rot, and `jose`'s `jwtVerify` would wrongly reject this (it throws `JWTExpired` unconditionally), which is why the oracle uses `compactVerify` + explicit claim checks. |
| `auth.stale-iat.json` | HOLD — `iat` ~45d old, outside the 30-day `slotRecencyWindow`. Staleness is bounded on `iat`, never `exp`. |
| `auth.contract-drift-aud.json` | `aud-mismatch` — well-formed and signed, but `aud` is not in the FD-6 audience SET. Must be a *distinct* diagnostic, not a generic failure. |
| `auth.contract-drift-shape.json` | `contract-drift` — `tokens.id_token` renamed. The expected shape is absent, so this is "the CLI's login format changed", not "wrong account". |
| `auth.alg-none.json` | rejected — `alg: none`. The pinned `['RS256']` list wins; the header `alg` is never trusted. |
| `auth.alg-hs256.json` | rejected — HS256 confusion (RSA public key abused as an HMAC secret). |
| `auth.jku-foreign-iss.json` | rejected — carries a token-supplied `jku` and a foreign `iss`. Key resolution must ignore both and verify only against the pinned JWKS, then fail `iss`. No SSRF, no key substitution. |
| `auth.email-unverified.json` | unverifiable — `email_verified: false`. |

## Regenerating

`node scripts/generate-codex-auth-fixtures.mjs [--from ~/.codex/auth.json] [--check]`

These are generated, not edited by hand. Regenerate from a real login artifact when the codex CLI's
format changes — and record the new CLI version + platform in the PR, per the compatibility envelope.

`--check` is the CI-safe mode: it proves the committed fixtures are reproducible from the generator,
runs the positive leak assertion, and **verifies that `load.ts` supplies the LIVE-token guarantee**.
With no codex login on the machine, `--check` skips cleanly and says so.

**That last check was retargeted on 2026-08-03, and running it is what proved the original design
wrong.** The requirement is real: if every fixture is expired, a rule that (however accidentally)
REQUIRED `exp` to be in the past would make the whole suite pass while refusing every real,
freshly-refreshed login. The original remedy stamped the LIVE case at GENERATION time — into a file
that is COMMITTED. So the fixture expires exactly one token lifetime (1h) after every regeneration,
and `--check` duly reported `STALE ... expired 44 min ago`. That was not rot; it was the design
working as specified. A committed future timestamp is not "stamped", it is frozen with extra steps,
and **no CI gate asserting its freshness can ever be green on a correct repository** — the worst kind
of gate, red when the system is right.

Liveness now comes from `load.ts` at the moment of USE, the committed artifact stays honestly expired,
and `--check` verifies two POSITIVE properties of the loader rather than sniffing a keyword: that it
re-stamps the LIVE case, **and** that it exempts the others (a loader that stamped everything would
destroy `auth.expired-but-valid.json` and `auth.stale-iat.json` while passing a naive check). All
three failure modes — loader absent, loader stamps everything, loader stops stamping — were verified
to turn the check RED, and the restored state verified green.

## Why these are NOT under `tests/fixtures/captured/<slug>/`

The **Scrape/Parser Fixture Realness** standard is engaged (it is named in the P1 spec's
`lessons-engaged`), but its enforcement mechanism does not fit this artifact: the lint requires
`>= 1 .txt` capture per slug with a matching `.meta.json`, and its registry entry shape is built for
captured TEXT (terminal output, marketing HTML). `auth.json` is a structured JSON credential file, not
a text capture; renaming it `.txt` to satisfy a path check would be conformance theatre.

The standard's actual GUARANTEE — feed the parser the real bytes, never a hand-authored clean string
— is met by a different mechanism of equal strength, and deliberately so:

- derived from a REAL `codex login` artifact, preserving the exact top-level keys, `tokens.*` key set
  and full id_token claim set (shape drift surfaces as a test failure, not a pass against a guess);
- redaction preserves **type and null-ness**, so a value that is `null` on a healthy paid account
  stays `null` — the defect that made an earlier generation of these fixtures able to "prove" an
  entitlement gate that would have refused every real account;
- a positive leak assertion enumerates the real signature/header/sub/email/account-id/user-id/tokens
  and refuses to write if any appears in the output;
- `--check` proves reproducibility and catches staleness.

Extending the lint to cover JSON artifacts would be the alternative, and by that lint's own rule
("adding/removing a registry entry requires a spec change") it is a spec change rather than a
drive-by. Recorded here as a justified exclusion rather than an oversight.

## Loading fixtures in a test

```ts
import { loadCodexAuthFixture, fixtureClaims } from '../fixtures/codex-auth/load.ts';

const live = loadCodexAuthFixture('auth.valid.json');               // genuinely live at run time
const pinned = loadCodexAuthFixture('auth.valid.json', 1800000000); // deterministic instant
```

Pass an explicit instant to pin time — that is the supported way, **never** by editing the committed
fixture. Every non-LIVE fixture is returned byte-for-byte; their frozen timestamps satisfy the
safe-drift rule honestly (an expired token only gets more expired, a stale `iat` only gets staler).
Reading `auth.valid.json` directly instead of through the loader tests the EXPIRED path.
