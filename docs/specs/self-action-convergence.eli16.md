# Self-Action Convergence — Plain-English Overview

> The one-line version: teach the brand-new "defect-class" system (which landed today) about the ONE kind of bug we keep fighting — a self-triggered action that spirals out of control under pressure — and give it the automatic test that proves any such action calms down instead of running away.

## The problem in one breath

Instar keeps shipping features that fire an action on their own — restart a session, swap accounts, send a notification, retry a failed thing — and every so often one of them gets stuck firing that action over and over because *the action itself makes the situation worse*. The account-swapper did this in June: it swapped accounts ~72 times a day, each swap killing and restarting a session, which piled cost onto the account it swapped TO, which made that account look overloaded, which triggered the next swap. Twenty different versions of this same runaway have happened since April. Each time we bolt on a one-off brake. Nobody ever built the one test that asks: *"does this loop settle down, or does it run forever?"*

## What already exists

- **The account-swap "three brakes" fix** — a real but partial patch to the ONE swapper. It doesn't stop the underlying pattern, and it doesn't help the next feature that has the same shape.
- **Bounded Blast Radius** — a proven safety pattern that caps how MANY heavy things run at once (the fork-bomb fix). It has a "funnel," a lint that fails the build if you dodge the funnel, and a stress test. But it only covers one kind of resource (spawned subprocesses).
- **The class-closure system (#1347, landed the SAME day as this investigation, currently switched off/quiet)** — this is the big one. It's a brand-new registry of *bug CLASSES* plus a check that, whenever you fix a bug, forces you to say (a) which class it belongs to and (b) which real, live guardrail now makes that whole class of bug get caught automatically. It even grades the guardrail you cite and rejects a citation that points at a dead/unfinished guard. **Right now it only watches "agent-authored" files (prompts, hooks, configs) — not regular product code.**
- **The instar-dev commit gate** — the checkpoint every code change passes through; it already has a couple of "if you touch X, you must explain Y" rules built the exact way this spec needs.

## What this adds

The big realization: **the structural fix isn't missing anymore — it landed today.** The class-closure system is exactly the machine that should govern this whole family of runaway bugs. It just doesn't know about them yet. So this spec doesn't build a parallel new thing — it plugs the runaway-loop problem INTO that new machine, in four small pieces:

- **Name the class.** Add "unbounded / oscillating self-action" to the bug-class registry, with real examples (swap-thrash, the reaper firing 17,503 kill requests a day, the notification floods).
- **Build the guardrail that ends the class.** A single automatic test that takes every self-triggering controller, runs it for many ticks under the worst-possible never-improving pressure, and fails the build if the action count doesn't settle to a small number. This is the exact "live guard" the class-closure system asks a fix to cite — and it grades as the strongest kind (a "ratchet").
- **Force new controllers into the test.** A lint that fails the build if someone adds a new self-triggering controller without registering it in the test — so a new feature *inherits* the safety check instead of earning its own brake after it breaks something.
- **Teach the class-closure check to see product code.** Extend it (which its own design already flagged as a planned next step) so that a change adding a self-triggering action is required to declare its class and cite the guardrail — caught both at commit time and in CI.

## The new pieces

- **The `unbounded-self-action` bug class** — one entry in the existing registry. It says what counts (a self-firing action that doesn't settle, or that feeds its own trigger) and what doesn't (a one-shot reply to the user; a deliberately-eternal healer loop; raw "how many at once" which is a different, already-covered class).
- **The convergence test + controller registry** — the guardrail. One list of every self-triggering controller, and one test that proves each one calms down under sustained pressure. New controllers get added to the list; the lint makes sure they can't skip it.
- **The shared detector** — one small piece of code that spots "this change adds a self-firing action," used in two places (the commit gate and the CI check) so there's one source of truth, not two.

## The safeguards

**It doesn't reinvent anything.** Every piece composes with the class-closure system that already exists — same registry, same declaration, same grader, same config switch. It reuses the Bounded-Blast-Radius test-and-lint pattern rather than inventing a new one.

**It can't block your work by accident.** Everything ships "report-only" first (the class-closure system's default), so it logs what it *would* flag without stopping any ship until a human flips it on after seeing real data. Every gate is built to fail *open* on a tooling hiccup — a broken detector never wedges commits — and only fails *closed* on a genuine self-firing action with no safety declaration.

**It catches the exact bug that escaped.** The account-swapper shipped through the "light" fast path where no deep reviewer runs. This spec's checks run on BOTH paths, so the next swap-thrash can't take the same shortcut.

## What ships when

Report-only first, exactly like the class-closure system it rides on: (1) register the class + land the guardrail test + the lint + the detector, all logging-only; (2) measure how often real self-action changes declare correctly; (3) a human flips it to actually-blocking once the declarations prove reliable. The bigger follow-on work — one shared "backpressure" service every self-action rides by default, and the real fix that stops account-swaps from needing a session restart at all — are named as separate specs, not built here.

## The review it went through

Two outside AI models (codex GPT-tier and gemini) reviewed the spec. They caught real problems that got fixed: the commit-time check pointed at a file that doesn't exist yet (fixed — the declaration now lives in the trace the developer already writes); the lint that forces registration was dodgeable by renaming a method (fixed — it now triggers on the *action itself*, not the method name); and a claim that the check "blocks" was corrected to match what the system actually does today (report-only, with the new blocking behavior added explicitly). A second confirmation pass verified all of it was fixed with nothing new broken.

## Still for the operator to decide

Two calls are deliberately left to Justin, not silently made: whether this should be ONE bug class or split into "floods" vs "spirals" (they trip at different sensitivities), and the final calibration of the detector's word list. And the proposed constitutional standard is exactly that — a *proposal*; adopting it into the constitution is the operator's, not the design's.
