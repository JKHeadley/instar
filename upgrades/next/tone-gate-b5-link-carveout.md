## What Changed

The outbound tone gate (`MessagingToneGate`) no longer false-positives on user-facing share links. Its `B5_API_ENDPOINT` rule was firing on **any** URL with a host, port, and path — because the `api-endpoint` detector flags every URL and the rule blocked a link "handed to the user to call/open." That swept up the normal way an agent shares a rendered doc: private-view links (`/view/<id>?token=…`), Cloudflare tunnel URLs, published/Telegraph pages, and dashboard links.

B5 is now intent-judged: it blocks only a URL handed to the user as an API to **call** themselves (`curl`/`POST`/"hit this endpoint"), and explicitly **passes** a URL meant to be **opened/clicked/visited** in a browser — even though it has a host, a port, and a path. Worked examples on both sides were added so the model judges by call-vs-open intent, not by URL shape, and the `ALWAYS ALLOWED` list now names the exact link classes that must never be blocked. The fix is entirely in the gate's LLM-authority prompt; the brittle detector is unchanged (it stays a broad signal), so no new blocking authority is introduced.

## What to Tell Your User

If your agent had started blocking its own "here's your link" messages — saying its safety gate was treating a view/doc link as an exposed endpoint — that's fixed. Signed view links, tunnel URLs, and published pages now pass through cleanly. A genuine "run this curl command yourself" instruction is still held back, as intended.

## Summary of New Capabilities

No new capabilities or endpoints — this is a correctness fix to an existing internal gate. Agents simply stop having their legitimate share links blocked.

## Evidence

- `src/core/MessagingToneGate.ts` — rewritten `B5_API_ENDPOINT` rule (call-vs-open, worked examples both sides) + strengthened `ALWAYS ALLOWED` URL line.
- `tests/unit/MessagingToneGate.test.ts` — `describe('B5 link carve-out (prompt teaches call-vs-open)')`: 5 tests covering intent-not-shape wording, the named click/open link classes, a retained BLOCK worked example for a call-target, the ALWAYS-ALLOWED browser-open phrasing, and end-to-end plumbing on both verdicts.
- `tests/unit/GateSignalDetectors.test.ts` — documents that the `api-endpoint` detector intentionally fires on click/open destinations too (the authority judges call-vs-open).
- Local: `npx vitest run` on both files → 57 passed; `npm run build` → OK.
- Live reproduction during development: a Telegram reply quoting a literal `http://localhost:4042/foo` was blocked by the pre-fix gate — the bug, observed first-hand.
