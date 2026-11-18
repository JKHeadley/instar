# Design work on the frontier model, reviewed before you are asked — Plain-English Overview

> The one-line version: every plan an agent asks you to approve has been reviewed by the strongest model it can reach and by other providers' models, and arrives with one line saying which models wrote it, which reviewed it and what each concluded — and the system enforces this instead of relying on the agent to remember.

> **Approved** by Justin on 2026-11-17 at 15:32 PST (topic 144319). The build follows on its own branch, in four stages, each proven live before the next. Stage 1 adds the design model to the model registry and the routing of design sessions at spawn.

## The problem in one breath

On November 9 you set a rule: the strongest models design and review, the cheaper ones build. On November 17 the Windows app plan reached you written by the building model in one four-minute pass, with no review. Nothing was broken. The rule lived in a note in my memory, and no part of the system applied it.

## What already exists

- **The model registry.** The reviewed list of which models each agent can reach. It fails loudly when it goes stale.
- **The review loop.** Several reviewers, plus other providers' models as outside readers, repeated until a round finds nothing that would change what gets built. Today it is written only for changes to Instar itself.
- **A frontier "second read".** A reviewer that reads a design on the strongest Claude model. Built in July; on for me, off for other agents.
- **The approval hold.** Since November 15, a request asking you to approve a design is held unless it reports the constitution check. It works on messages and on Work Board cards.
- **A "use the stronger model" mechanism from June.** Built but switched off everywhere. I checked whether to build on it and decided not to: its usage guard refuses everything while the feature is off, and it only looks at one account.

## What this adds

- **Design sessions pick their own model.** When a session is started to write a plan, design or spec, it launches on the design model. The work can be labelled as design; when it is not, one quick check reads the instructions and decides. Building stays on the efficient model.
- **Any design can go through the review loop.** A general version of the loop works on any plan for any project, on any agent. Changes to Instar itself keep the stricter loop they have now.
- **A review record the agent cannot fake by accident.** One command runs every available reviewer and records what each one concluded. There is no way to record a single hand-picked reviewer.
- **A provenance line you can trust.** The system writes the line from those records. A request for your approval that does not carry it, or whose design has changed since the review, is held until the agent runs the review.
- **One named place for "the design model".** The registry says which model that is. Changing it later is one reviewed change that every agent follows. No model name is written into instructions.

A line looks like this:

> On record as written in a session running Claude Fable 5.2. Reviewed 3 times. On this version: Claude Fable 5.2 found no issues, GPT-6 Astra found minor issues. (Review record 3f9a2c1b77d0)

When something is missing or a reviewer found serious problems, the line says that first. The code at the end is a lookup number you can ignore.

## The new pieces

- **The design lane.** One entry per provider in the registry naming the model for design and review. It can only name a model already on the reviewed list.
- **Design routing.** The step, when a session starts, that sends design work to the design model. It can only choose between the design model and the normal default, and it can never stop or delay a session from starting.
- **The review record.** A small file of what the review code actually ran: which reviewer, which model answered, what it concluded. Only the server writes it.
- **The provenance rule.** One more rule beside the existing constitution-check rule. It can only hold a request and tell the agent how to clear it. It never rewrites a message and never asks you for anything.

## The safeguards

**It cannot block work when the strong model is unavailable.** If the design model is not on the plan, or its usage limit is reached, the work runs on the normal model and the line you see says so first.

**It catches today's failure.** A plan drafted by the building model with no review has no record, so the request is held. The agent runs the review, which hands the review and the rewrite to a session on the design model, and the line you then read says which models wrote and reviewed it.

**It ties the record to the exact text.** If the design is edited after its review, the request is held until it is reviewed again.

**It never traps an agent.** Every hold is cleared by the agent alone, with whatever models it has. An agent with one provider still passes, and its line says no outside model reviewed it.

**It does not send designs to providers you did not choose.** Outside reviewers are only the providers the agent already works through. A tool that merely happens to be signed in on the machine is not used. A design containing a live password or key is not sent anywhere.

**It does not limit you.** Sharing a draft with you is never held; only an agent's request for approval is. You can approve anything at any time. The reviewers' verdicts are shown to you, and the decision stays yours: an agent may ask for approval while a reviewer still says "serious issues", and you will see exactly that.

## What it does not do yet

- It routes design work only for sessions started on the same machine with a written brief. Design done inside a long-running conversation, in a scheduled job, or sent to another machine runs on the normal model, and is caught when approval is asked.
- A job that asks for a design and its build together runs on the normal model. Its design is still reviewed before you are asked.
- The very first design on a new agent is written on the normal model and reviewed on the design model, because the system only launches on the design model after one real use of it has succeeded.
- "Which models wrote it" comes from records that age out after a few hours on a busy agent. When they are gone the line says there is no record.

## What ships when

1. The design lane and design routing.
2. The review command, the review record and the general review loop.
3. The provenance rule on messages and Work Board cards.
4. The update path for existing agents, the agent instructions, and the constitution text.

Each step is proven first on a throwaway agent through real Telegram and Slack, then runs on Echo with your real requests, then turns on for every agent once the evidence holds. It reaches existing agents through the normal update, off until that point. On for Echo first; off for other agents until then.

## What you actually need to decide

Approve the spec. Saying yes includes five things worth knowing:

1. **Fable 5.2 becomes the design model, and Gemini 4 Argon the Gemini reviewer,** on your word, although the registry normally promotes a model only after a benchmark.
2. **Design routing outranks a topic's pinned model** (a topic pinned to Opus still gets its designs on the design model), with a per-topic off switch.
3. **One new constitution rule** is added in both books: "Frontier Models Design and Review; Efficient Models Build."
4. **Outside reviewers are limited to providers the agent already works through.** On Echo today that means GPT reviews and Gemini does not, until Gemini is signed in and enabled here. If you would prefer every signed-in provider to review, say so and I will change that one rule.
5. **The July spec that added the frontier second read** was built and has run since, but was never marked approved. This spec changes two things in it (it turns on for every agent under this standard, and it may fall back to the normal model with the reason shown), and your yes covers that.
