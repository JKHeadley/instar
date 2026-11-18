<!-- bump: patch -->
## What Changed

Stage 2 of the frontier design and review standard (`docs/specs/frontier-design-review-standard.md`).

- **Driver recording mode:** `cross-model-review.mjs --spec <file> --all --record` runs every reviewer the agent works through in one go and records what each concluded. A live secret in the text stops the run before anything is sent. The Claude reviewer asks for the design model (Fable 5.2) and falls back once to the agent's default Claude model if the plan refuses it. A provider that is signed in on the machine but is not one of the agent's frameworks is not used. A report the server cannot take is spooled and delivered later.
- **Review records:** `POST /design/review/runs`, `GET /design/review?path=` (status, which models are on record as having written the file, each reviewer's verdict, and the provenance line with its record reference), `GET /design/review/runs?since=` for peers. The server reads and hashes the file itself and only accepts files in the project, the agent home or the session's working folder.
- **`GET /design/lane`:** whether a design session started now would run on the design model.
- **`/design-review` skill:** the review loop for any plan or design, installed on every agent.
- The Claude hardening preflight can now answer "inconclusive" (retried, never run unhardened), and a provider refusing the requested model is recognised as "not on the plan".

## What to Tell Your User

Before your agent asks you to approve a plan, it can now run one review command that sends the plan to the strongest model and to the other providers it already uses, and keeps a record of what each one concluded. The approval request can then carry one line, written from that record, saying who reviewed the plan and what they found. Nothing is sent to a provider your agent does not already use, and a plan containing a password or key is never sent anywhere.

## Summary of New Capabilities

- `/design-review` (new skill), `cross-model-review.mjs --all --record`, `GET /design/review`, `POST /design/review/runs`, `GET /design/review/runs`, `GET /design/lane`.

## Evidence

- Unit: `tests/unit/designReviewRecord.test.ts`, `tests/unit/designReviewRun.test.ts`, touched suites 495/495.
- Integration: `tests/integration/design-review-routes.test.ts` 12/12.
- E2E: `tests/e2e/design-review-routes-lifecycle.test.ts`.
- Live on a throwaway agent with real Claude Fable 5.2 and GPT-6 Astra reviews: recorded run and line, secret refusal, edit detection, spool and restart intake, outside provider not enabled, and a full `/design-review` hand-off to a Fable 5.2 design session.
