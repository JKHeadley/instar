# Antigravity CLI — new door evaluation (in progress, 2026-07-02)

## What it is
Google's replacement for Gemini CLI (Gemini CLI + Code Assist stopped serving AI Pro/Ultro/free on 2026-06-18). Homebrew cask `antigravity-cli`, binary `agy` at `/opt/homebrew/bin/agy`, v1.0.16. OAuth login (Google account). Has a real headless print mode: `agy -p "<prompt>" --model "<name>"`.

## Auth (done)
Signed in as **echo@sagemindai.io** (NO Google AI plan → free tier). OAuth driven through a clone of the live MCP browser profile (`mcp-chrome-cfd41c8`) + vault `google_password_echo`; the flow returns a paste-code that was fed to the CLI's tmux prompt. The app is the official Google cask (the "Make sure you downloaded this from Google" consent is Google's own first-party OAuth screen).

## Models offered (free tier, `agy models`)
- Gemini 3.5 Flash (Low / Medium / High)
- Gemini 3.1 Pro (Low / High)
- **Claude Sonnet 4.6 (Thinking)** — cross-provider!
- **Claude Opus 4.6 (Thinking)** — cross-provider!
- GPT-OSS 120B (Medium)

The cross-provider access (Claude + GPT-OSS through a Google door on a free account) is the surprise.

## Verified live (free tier)
- `agy -p` headless returns clean in ~4s.
- Real calls succeed on Gemini 3.1 Pro AND Claude Sonnet 4.6 (both returned the exact sentinel).
- Gemini 3.1 Pro works here despite being ZERO-quota on the free AI Studio API key (the door has its own entitlement, distinct from API keys).

## Free-tier capacity probe (2026-07-02 ~21:35 PDT)
12 rapid `Gemini 3.1 Pro (Low)` calls: **12/12 OK, 0 rate-limited, 77s total (~6.4s/call)**. The free tier did NOT wall at 12 sequential calls — capacity is generous even unpaid. (Ceiling not yet found; a longer sustained probe would be needed to locate the free RPD wall.)

## Open (research in flight)
- AI Pro / Ultra subsidy through THIS door: per-tier AI-credit quota, what paying adds over free, subsidy ratio vs Claude Max's measured ~6.6×.
- ToS on programmatic/headless + Workspace-account use.
- Whether to wire it in as a formal bench door (awaiting operator go/no-go).

## Benchability
Print mode + model flag = directly benchable as a subscription door (like claude-code / codex-cli / gemini-cli). Would slot into `routes.mjs` as a new `agy` CLI door. Model-name mapping: the `agy` display names ("Gemini 3.1 Pro (Low)") differ from API ids and would need a lookup.

## Invocation surface (verified via `agy --help`)
Print mode is minimal: `agy -p "<prompt>" --model "<display name>"` → plain-text stdout (NO `--output json`, NO `--max-tokens`). Flags: `--print-timeout` (default 5m), `--sandbox`, `--dangerously-skip-permissions`, `--new-project`, `--add-dir`.

**CRITICAL characterization caveat:** `agy` is an AGENT HARNESS (it plans, calls tools like `write_file`, manages a workspace/project), NOT a clean prompt→completion API. This is the SAME shape as `claude-code` — and the Opus-by-door finding proved a coding-agent harness inflates credulity on judge/gate tasks (Opus 0.94 API → 0.72 via Claude Code CLI, a 25pt penalty from the ~20k-token agent framing). So the strong prediction: **Antigravity-door scores on bounded judge/gate tasks will be DEPRESSED by the harness framing, exactly like Claude Code** — it is a door for interactive agent work, likely a POOR door for the sentinel/gate bench. This must be measured, not assumed, but it reframes the door: its value is cheap/subsidized *agent* capacity, not clean judging capacity.

## Ready-to-apply bench wiring (dark until operator go/no-go)
When approved, wiring is ~4 edits — kept here so the flip is instant:
1. `routes.mjs` CLI_DOORS: add `{ door: 'antigravity-cli', binary: 'agy', subsidized: true, family: 'google-antigravity' }`.
2. `run2.mjs` doorKey map (line ~60): add `'antigravity-cli': 'antigravity'`.
3. `run2.mjs` buildInvocation: add `case 'antigravity-cli': return { cmd: route.binary, args: ['-p', promptText, '--model', route.model], cwd: CLEAN_CWD };` (plain-text stdout → response extraction is just trimmed stdout, no JSON parse).
4. Model-name lookup: agy uses DISPLAY names ("Gemini 3.1 Pro (Low)") not API ids — needs a small map in bench-models.json for the antigravity door. Pace like gemini-cli (add to `isPaced`).
Because output is a full agent transcript, response extraction should take the FINAL assistant text block, not raw stdout (the transcript includes "Thought Process" / tool lines) — mirror the claude-code JSON-less extraction path.

## Recommendation (pending operator go)
Bench it as a NEW door on the SAME critical battery to empirically confirm/deny the harness-penalty prediction — that's the scientifically valuable result (does a second independent agent-harness door replicate the Claude-Code credulity penalty?). If confirmed, the routing rule generalizes: "never route bounded judging through ANY agent harness door (Claude Code, Antigravity), regardless of the underlying model." That would be a stronger, model-independent statement of hard-rule #1.

## Free-tier capacity — MEASURED (2026-07-02 ~21:45 PDT)
40 back-to-back `Gemini 3.1 Pro (Low)` calls: **40/40 OK, 0 walls, 270s (8.9 rpm sustained)**. The free tier did not throttle across 40 sequential frontier-model calls — capacity is real, not a trickle. (Community estimates ~20 agent-requests/day on free, but light one-shot `-p` calls clearly count softly; a heavy agentic trajectory burns far more.)

## Subsidy verdict — NOT a Claude-Max-style door (deep research, 2026-07-02)
Decisive finding: **Google denominates Antigravity credits at $0.01 = standard API pricing**, so its own transparent valuation of a plan's quota is ~API list. Result:
- **AI Pro $20/mo**: 1,000 credits = ~$10 API-value → **~0.5×** (you pay MORE than the API value of the quota — Pro is below break-even).
- **AI Ultra $100/mo** (5×) / **$200/mo** (20×, repriced down from $250; "Ultra Max" is NOT an official tier): ~25,000 credits = ~$250 API-value on the old $250 tier → **~1.0× break-even**; the $200/20× tier is ~2× better per-dollar than Pro but still ~API pass-through.
- vs **Claude Max's measured ~6.6×**: Anthropic prices Max BELOW API cost; Google prices Antigravity AT API cost then rate-limits it. Not comparable.
- **May 20 2026**: Google removed Pro's 1,000-credit baseline; in-plan usage is now opaque 5-hour rate-limit windows, credits are overage-only ($0.01 each).

**The valuable lane is the FREE tier** (full roster incl. Claude Opus/Sonnet 4.6 + Gemini 3.1 Pro + GPT-OSS, headless `agy -p` sanctioned/documented). Paying buys quota headroom + priority, NOT model access or a cost edge.

## ToS posture — gray-to-red for a pooled bench
- Headless/agentic `agy -p` is a **documented, sanctioned** feature (Google codelab) — NOT the Anthropic-subscription gray zone.
- BUT **Antigravity Additional Terms §6**: "must not… use the Service in connection with products not provided by us" — a pooling/third-party-wrapper harness violates this (live takedown precedent: third-party "Antigravity Manager"). Per-account enforcement, NO native multi-account, third-party routing measurably raises suspension risk.
- **sagemindai.io Workspace account is the WRONG vehicle**: the consumer Antigravity route on Workspace is being REMOVED July 7 2026 (redirected to paid Gemini Enterprise Agent Platform).
- Pooling one owner's quota across their own agents: no explicit prohibition found — genuinely unresolved (absence ≠ permission).

## Prior corrections
Ultra = 25,000 credits/mo (NOT 12,500); top tier is $199.99 AI Ultra (NOT a separate "Ultra Max"); Pro's 1,000-credit baseline was removed 2026-05-20.

## FINAL RECOMMENDATION
Wire in the **FREE tier** as a $0 supplementary bench lane for its model access (and to test the agent-harness credulity-penalty prediction). Do **NOT** buy AI Pro/Ultra as a subsidized door — the economics are break-even-to-negative and the pooling posture is legally unclear. The genuine Google subsidy lever remains the separate **$10/mo Cloud API credit** in your existing AI Pro plan (activate via the Developer Program), which is real money toward metered Gemini API calls — a different, cleaner lane than the CLI.
