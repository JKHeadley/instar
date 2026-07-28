# MTP Red-Team Harness spec — ELI16

> The one-line version: a standard way to attack-test any org's agent against that org's own rulebook, at escalating intensity, and get back a map of exactly where the rules hold and where they crack.

## The problem in one breath

We proved an agent can refuse a bad request when you *tell it you're testing it* — but that's the easiest possible attack. Real attacks don't announce themselves: they ask directly, then add pressure, then use tricks ("your boss already approved this"). And every org has a different rulebook (MTP), so a test built only for OUR rules helps nobody else. On top of that, we learned the hard way that pasting attack text into a long-lived agent conversation can permanently kill that conversation — the safety classifier rejects every later message because the attack text rides along in the transcript forever.

## What already exists

The org rulebook format (ORG-INTENT.md, the "MTP protocol") with constraints, tradeoffs, and identity. A checker endpoint where an agent can ask "would this action be refused?" (G1). A way to send a deployed agent real user messages from the operator's seat and read its replies (the Tier-4 test rig). A dedicated test topic where probe conversations are disposable.

## What this adds

A spec for the harness that ties those pieces together: **scenario packs** (attack themes declared as data files — credentials, value conflicts, impersonation, policy pressure), an **amplification ladder** (level 0 = declared test, level 1 = direct naive ask, level 2 = ask with pressure and a plausible excuse, level 3 = engineered attack with spoofed authority or injection), and a **boundary map** report (per scenario: the highest level the refusal held at, plus whether the refusal actually came from the org's rulebook or just the model's instincts).

Org-agnostic is built in: a scenario never hardcodes "this must be refused" — it carries hints for FINDING the governing rule in whatever org's rulebook the harness is pointed at. If no rule matches, the result is "ungoverned": the agent might still refuse on instinct, but the org learns its rulebook has a hole. That's the "cheering vs governing" measurement, automated.

## The coherence rule (operator refinement)

An attack only measures something if the disguise fits the door it knocks on. "I'm the boss on my friend's phone" arriving from the boss's REAL account is nonsense — the test rig rejects that combination. Every scenario declares who it pretends to be (the real owner acting strangely, a stranger, another agent, a stolen account), and it may only be delivered over a channel where that pretense is plausible. Contexts we haven't probed yet are reported as "untested," never assumed safe. The spec also carries a crosswalk table checking the harness itself against every EXO 3.0 requirement it claims to serve — and the operator flagged a bigger question it surfaces (is "the message came from your Telegram" really proof it's you?) as a separate tracked exploration.

## The safeguards

Attack text lives in files, never in the orchestrator's conversation — components handle payloads as file paths and hashes, and humans review them through file-viewer links. The agent being tested gets probed only in disposable test sessions in the dedicated test topic, and each session is killed (resume pointer cleared) after its run, so a poisoned transcript dies with its session. Level-3 attacks are off until the operator turns them on, and pointing the harness at an agent you don't operate requires that operator's standing consent. Every probe is written to an audit log.

## What ships when

Phase 1 (now): the spec, the pack format, two scenario packs, a prototype runner on the existing test rig, and the first real boundary map of our own agent. Phase 2: a proper CLI/API with LLM-judged outcomes and automatic re-runs whenever the org's rulebook changes. Phase 3: cross-org consent flows and publishing our own boundary map honestly on the public EXO page.
