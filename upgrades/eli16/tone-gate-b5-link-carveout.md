# Tone Gate B5 — Stop Blocking the Links Agents Share — Plain-English Overview

> The one-line version: the outbound safety gate was blocking the very links an agent uses to share a doc with you (private-view links, tunnel URLs, published pages) because they *look* like an API endpoint — so we taught it to judge a link by whether you CLICK it or CALL it, not by its shape.

## The problem in one breath

Every message an agent sends you passes through a small safety gate that blocks technical leakage — things like a raw API endpoint you'd be told to `curl`. One of its rules ("B5") was firing on *any* URL that has a host, a port, and a path. A signed view link like `…/view/abc?token=…` has exactly that shape, so the gate was blocking the agent's normal "here's your rendered doc" link as if it were an exposed endpoint. Multiple agents hit this. It's the gate failing its own standard: a gate with this much power should be smart enough to tell a useful link from a security problem.

## What already exists

- **The outbound tone gate** — a Haiku-backed reviewer that reads each outbound message and either passes it or blocks it, citing exactly one rule. It already has an "ALWAYS ALLOWED" list that *included* "URLs the user can click to visit" — but only as a vague one-liner.
- **A set of brittle detectors** — cheap pattern-matchers that flag "this message contains something that looks like a CLI command / file path / API endpoint." They are deliberately dumb. The `api-endpoint` detector flags *every* URL, because it can't tell a click-target from a call-target. That's fine — it's only a *signal*.
- **The signal-vs-authority split** — the detectors raise signals; the LLM is the *authority* that makes the final call using context. The bug was in the authority's instructions, not the detector.

## What this adds

The fix is entirely in the gate's instructions (its prompt) plus tests — no new code path, no new blocking power. We rewrote the B5 rule so it fires only when a URL is handed to you as an API to **call yourself** (curl/POST/"hit this endpoint"), and we told it explicitly to **never** block a URL you're meant to **open/click/visit** — a private-view link (even one carrying a `?token=`), a Cloudflare tunnel URL, a published or Telegraph page, a dashboard link, a download link. We added worked examples on *both* sides so the model judges by intent, not by the host:port/path shape. The weak "URLs you can click" line in the ALWAYS-ALLOWED list was promoted to name those exact link kinds.

## The new pieces

- **Rewritten B5 rule** — now says, in plain terms: a detected URL alone is never a block; decide from how it's being used. Call-target → block. Open/click destination → pass, even though it has a host, port, and path.
- **Strengthened ALWAYS-ALLOWED line** — names private-view links, tunnel URLs, published/Telegraph pages, dashboard links, and download links as content destinations that are never blocked under B5.

## The safeguards

**Prevents over-blocking (the bug).** The whole point: real, clickable share links now pass. Tests lock the prompt so a future edit can't silently drop the carve-out.

**Prevents under-blocking (the worry).** A genuine "run `curl http://…/commitments`" instruction is still blocked as B5. A worked BLOCK example and a test assert this side of the line, so loosening the click-case doesn't open a hole for call-targets.

**No new authority.** The change only makes the existing smart authority smarter and *reduces* false-positive blocking. The brittle detector is untouched and keeps being just a signal.

## What ships when

It's a single self-contained change — the prompt rewrite, the strengthened allow-line, and the tests ship together in one patch release. Existing agents get it automatically when they update to the new instar version, because the gate is core server code, not an installed template. There's nothing to turn on and nothing to migrate.
