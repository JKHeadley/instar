---
name: design-review
description: Review any plan, design, architecture or spec on the frontier design model and other providers' models before asking the operator to approve it. Runs the constitution check, ONE recording driver run that attempts every reviewer, and lens passes, revising until a round changes nothing that would be built. Produces the provenance line the approval request must carry. Use for every design that will be sent for approval; Instar's own specs use /spec-converge.
metadata:
  user_invocable: "true"
---

# /design-review

Before you ask your operator to approve a plan, design, architecture or spec, it is reviewed here. The operator's request is held (rule B26) unless it carries the review record's line, so this is not optional for an approval ask. Sharing a first draft without asking for approval does not need it.

Instar's own specs go through `/spec-converge`, which uses the same driver.

## Step 0 — the document

Work on a file. A plan that exists only in a chat message is written to a file in the project first (the session that holds it writes it, so the record shows who wrote it). Files in the agent state folder cannot be recorded; put the plan in the project.

## Step 1 — run on the design model

Read your own session record:

```bash
AUTH="${INSTAR_AUTH_TOKEN:-$(node .instar/scripts/secret-get.mjs authToken 2>/dev/null)}"
curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-Session-Id: $INSTAR_SESSION_ID" "$INSTAR_SERVER_URL/design/lane"
```

The answer says which design model this machine would use for your framework and whether a session started now would get it (`wouldRoute`), and `self` describes this session (`onDesignModel`, `reviewHandoff`).

- If this session is already on the design model, or was started with `reviewHandoff`, or `wouldRoute` is false: run the loop here, in place.
- Otherwise hand the document to ONE design session and stop:

```bash
curl -s -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' "$INSTAR_SERVER_URL/sessions/spawn" \
  -d '{"name":"design-review-<short-slug>","workKind":"design","reviewHandoff":true,"prompt":"Run /design-review on <absolute path>. <what the operator asked for, in one paragraph>"}'
```

If the spawn fails, or the child ends without finishing, run the loop here. A session started with `reviewHandoff` always runs in place, so there is one hand-off at most.

## Step 2 — each round

1. **Constitution check:** `POST /spec/conformance-check` with `{"markdown": <the document text>}`. Fix what it flags.
2. **One driver run** (this is what makes the record; it attempts every reviewer the agent works through):

```bash
node .claude/skills/spec-converge/scripts/cross-model-review.mjs --spec <path> --all --record
```

   It prints the record: `status`, `timesReviewed`, the `line` and its `reference`, and each reviewer's verdict. Read each reviewer's findings in `passes`. A live secret in the text stops the run before anything is sent: remove it and run again. A refusal names its cause and the next step.
3. **Lens passes:** spawn subagents with the reviewer templates in `.claude/skills/spec-converge/templates/` (security, scalability, adversarial, integration, decision-completeness, lessons-aware). Choose the ones that fit; lessons-aware and decision-completeness most often change a short plan. Lenses improve the design; they are not recorded.
4. **One coherent revision** addressing every finding that changes what would be built.

A wording-only edit after the last round needs one more driver run, not a full round.

## Step 3 — when to stop

Stop when a round finds nothing that changes what would be built. When two rounds in a row brought no improvement (fewer or less serious findings), and at every sixth round, stop and choose one, saying which in your output and in the request:

- **continue**, stating why progress is real;
- **cut scope**;
- **ask** with the reviewers' verdicts as they stand.

No count ends a review.

## Step 4 — the request

Get the line as it is now (never type it from memory):

```bash
curl -s -G -H "Authorization: Bearer $AUTH" -H "X-Instar-Session-Id: $INSTAR_SESSION_ID" --data-urlencode "path=<absolute path>" "$INSTAR_SERVER_URL/design/review"
```

Put `line` in the approval request word for word, with the constitution check result. The reference at its end is a lookup key into the review records; the first time you send one, tell your operator that. If the document changes after the last run, run the driver once more before asking.
