---
title: "TelegramLifeline sends bearer auth on /internal/* forwards"
slug: "telegram-lifeline-auth"
author: "echo"
created: "2026-04-18"
review-convergence: "2026-04-18T21:35:00.000Z"
review-iterations: 0
review-completed-at: "2026-04-18T21:35:00.000Z"
review-report: "not-required — emergency regression fix, scope is a 4-line client-side header addition restoring previously-working functionality"
approved: true
approved-by: "justin-urgent-deploy-verbal"
approved-at: "2026-04-18T21:30:00.000Z"
approval-note: "User explicitly authorized emergency deploy: 'please do whatever you need to make sure it gets deployed so the bug is fixed. Skip testing if you need to (I know its working). This is a huge bug and needs to be deployed to all instar agents.' Normal spec-converge ceremony skipped because the fix is a surgical client-side restoration of a header that PR3 silently required but never added in the caller."
---

# TelegramLifeline sends bearer auth on /internal/* forwards

## Problem statement

Release v0.28.53 shipped the PR3 security hardening that tightened `/internal/*` server middleware to require bearer auth (previously localhost-only). The hardening was landed in `src/server/middleware.ts` at commit `42cb9ee`, but the only in-tree client that calls those routes — `src/lifeline/TelegramLifeline.ts` — was not updated to send the bearer token. As a result, every inbound Telegram message on every agent running 0.28.53 gets a 401 from `/internal/telegram-forward` and is silently dropped before reaching the session. The user's symptom: "my messages in telegram don't seem to be reaching you" across every topic.

## Goal

Restore inbound Telegram routing on v0.28.53+. Messages from users via Telegram topics must land in the bound session as they did on pre-0.28.53 releases.

## Solution

In `src/lifeline/TelegramLifeline.ts`, change `forwardToServer()` and `handleCallbackQuery()` to build their headers as a mutable object and conditionally add `Authorization: Bearer <token>` when `this.projectConfig.authToken` is set. Body, method, abort signal, and timeout remain unchanged. The header is additive and backwards-compatible: server versions whose middleware does not require auth on `/internal/*` ignore it.

No migration, no new state, no new surface. The fix is the minimum possible intervention — restore the missing auth header on two fetch calls — and does not reshape the lifeline or its contract.

## Known limitations

- Agents with no `authToken` configured will continue to fail the bearer check on `/internal/*` on server versions that enforce it. This matches the documented non-support for unauthenticated configurations post-PR3.
- A follow-up unit test asserting the bearer header is present in `forwardToServer` and `handleCallbackQuery` fetch calls is tracked but not included in this patch, per the user's explicit "skip testing — I know it's working" instruction during the urgent-deploy request.

## Review notes

This spec is tagged `review-convergence` with `review-iterations: 0` because the standard /spec-converge flow was skipped under explicit user emergency authorization. The side-effects review in `upgrades/side-effects/telegram-lifeline-auth.md` provides the full over-block / under-block / interactions / rollback analysis. The change is narrow enough (two fetch call sites, header-object construction only) that multi-model review would not surface additional failure modes not already covered in the side-effects artifact.
