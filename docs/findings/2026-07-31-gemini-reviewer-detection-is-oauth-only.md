---
title: "The gemini cross-model reviewer is detected by OAuth creds alone, so a host authed by API key is reported unavailable — the exact false-unavailable the module says it exists to prevent"
date: 2026-07-31
author: echo
machine: Mac Mini
severity: medium
status: open
kind: finding
relates:
  - "src/core/crossModelReviewer.ts"
  - "skills/spec-converge/SKILL.md"
---

## The claim

`detectGeminiReviewer` decides the gemini reviewer is authed by exactly one test: whether
`~/.gemini/oauth_creds.json` parses and carries a non-empty `access_token` or `refresh_token`.

The gemini CLI accepts **more auth methods than that**. Its own error text, reproduced verbatim on
this machine on 2026-07-31, enumerates them:

```
Please set an Auth method in your ~/.gemini/settings.json or specify one of the following
environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA
```

So on a host authed by `GEMINI_API_KEY` (or Vertex, or Code Assist) the CLI **works** and the
detector reports `gemini-not-authed`. The cross-model pass is then skipped for that family and a
`gemini-cli:false` observation is written into the durable framework-activation baseline.

## Why this is the module's own named failure mode

The file already identifies this exact class, in the comment above the creds-path resolver:

> **DELIBERATELY no env-var override**: the gemini CLI (verified v0.25.2) resolves creds at
> `~/.gemini/oauth_creds.json` UNCONDITIONALLY — there is no `GEMINI_HOME`. […] (false-unavailable
> on an authed host -> the gemini pass silently skipped AND a false `gemini-cli:false` recorded
> into the activation baseline — the exact suppression Piece 3 exists to prevent).

The authors were guarding against a false-unavailable caused by a **wrong creds path**. The same
false-unavailable arrives through a **different auth method**, and that door is open.

This matters more than a normal detection miss because the recorded `gemini-cli:false` is not
inert: the skill's Phase 3 mandatory-check reads the activation history as the standing-framework
baseline, and the "externals unavailable" floor is described as legitimate only for an agent that
*"has been genuinely single-framework across the whole lookback — a recorded standing fact."* A
false negative here manufactures exactly that standing fact.

## Evidence

Measured on this machine, 2026-07-31:

| probe | result |
|---|---|
| `detectCodexReviewer()` | `{available:true, framework:'codex-cli', model:'gpt-5.5'}` |
| a real codex external review of a live spec | `status:'ok'`, substantive findings, **32s** |
| `detectGeminiReviewer()` | `{available:false, reason:'gemini-not-authed'}` |
| `~/.gemini/oauth_creds.json` | absent |
| gemini CLI invoked directly | fails in ~1s with the auth-method list above |

Detection is currently **correct on this host** — there is genuinely no auth of any kind here. The
defect is latent: it fires on a host that is authed by a method other than cached OAuth.

## Proposed fix

Treat the auth methods the CLI itself accepts as authed, keeping the OAuth check as the first and
strongest signal:

1. Cached OAuth creds (today's check) — unchanged.
2. A non-empty `GEMINI_API_KEY` in the environment.
3. `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_GENAI_USE_GCA` set truthy.
4. An `auth` method configured in `~/.gemini/settings.json`.

Report the satisfying method in the detection result so a later `degraded` round can be attributed
to the right cause.

### Why a set-but-invalid key is the safe direction

Admitting an invalid key produces a round that fails and is recorded `degraded`. The skill already
treats **`degraded-all-rounds`** as loudly as `unavailable` — *"converged having never once
received a real external opinion"* — so nothing is silently lost.

The current behaviour is the unsafe direction: a **valid** key produces a silently skipped family
plus a false standing fact that suppresses future passes. Detecting-and-degrading is strictly more
honest than not-detecting.

## Honest limits

- I could not execute the fixed path end-to-end: I hold no Gemini API key, so "the CLI succeeds
  with `GEMINI_API_KEY` set" is taken from the CLI's own error text, not from a successful call.
  The detection logic itself is testable without a key (the existing tests already inject
  `geminiOauthCredsPath`; an env fixture is the same shape), but the **live** call is not.
- This finding is scoped to detection. It does not claim the gemini review pass itself works — on
  this machine that remains unproven, because no auth of any kind exists here.
- I installed the gemini CLI on this machine while investigating; before that, detection reported
  `gemini-not-installed`. Nothing else changed.
