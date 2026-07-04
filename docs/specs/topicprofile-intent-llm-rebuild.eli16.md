# ELI16 — Why "should we use codex here?" stops flipping your topic's settings

## The problem, in one sentence

Each conversation topic can be pinned to a coding framework (Claude, Codex, Gemini, …), a
specific model, or a thinking depth — and you set that by just saying so: "use codex here",
"set high thinking on this topic". The code that decided *"is this message a setting change?"*
used a **list of trigger regexes** matched against your words. A regex fires on the words, not
the meaning — so it can't tell an order from a question or a passing mention.

## Why a regex can never get this right

Telling a **command** from **discussion** is a judgment about what a human *meant*.
"use codex here" (an order), "should we use codex here?" (a question), and "codex here keeps
failing" (a complaint) all mention codex — only the first should change anything. A fixed set
of anchored phrases has no way to feel that difference. This is exactly the sibling of the
2026-07-03 incident where a keyword list ate the operator's "keep the work on the laptop" as a
machine-move command. Instar's constitution now has a standard for this — **"Intelligence
Infers, Keywords Only Guard"**: a decision about what someone *meant* is made by the AI
reasoning over the message **and the recent conversation**, never by a keyword list.

## What already exists

- The Topic-Profile system (pins per topic; a write actuates a session respawn) — unchanged.
- `parseProfileTrigger` — the parser that used regexes to spot every profile command.
- `TopicProfileWriteSurface` — the piece that VALIDATES a change against the allowed values and
  performs the respawn. It stays exactly as it was; it independently re-checks everything.
- The proven exemplar: `MoveIntentClassifier` (the move-intent recognizer, PR #1367) did this
  same keyword→LLM conversion. We mirror it structurally.

## What's new

A small **LLM classifier** (`ProfileIntentClassifier`) replaces the framework/model/thinking
regexes. It reads your latest message plus the last few turns and answers one strict, structured
question: *is this a present command to change this topic's framework, model, or thinking — and
if so, to which allowed value?* Two design choices make it safe:

- **It can't invent a value.** The answer for "which framework/model/thinking" is constrained to
  the real allowed lists (the configured frameworks, the known model ids/tiers, the five thinking
  modes) plus "none". The model picks from those lists — we never scan its free text. If it names
  something not on the list, we drop it (no change).
- **When in doubt, it does nothing.** If the AI is unavailable, times out, is unsure, gives a
  low-confidence answer, or returns something unparseable, the message is **passed straight
  through to the agent** — never turned into a respawn. A missed "use codex here" is cheap (you
  restate it, or the agent just does it); a wrongly-fired respawn on "should we use codex here?"
  is the real harm, and fail-open removes it.

The regexes for the *other* commands stay as-is: readout ("what is this topic pinned to"), undo,
clear, re-apply, switch-now, and the plain "yes" confirm — their meaning is structural, not a
judgment call. The rarer `effort` and escalation-override forms also stay explicit (they're out
of this offender's framework/model/thinking scope).

## The safeguards, in plain terms

- **Dark on the fleet, live-but-dry-run on a dev agent.** Like every risky new decision-maker,
  it ships off for everyone else and, on the development agent, runs in "dry-run": it makes the
  full decision and writes down what it *would* have done to `logs/profile-intent.jsonl`, but
  changes nothing. Only a deliberate flip turns real actuation on — after the log shows the
  false-positive rate collapsed.
- **The validator is still there.** Even a positive classification is re-checked by the write
  surface against the allowed values before any respawn — the classifier is a recommender, never
  the final authority.
- **Forwarded messages never count.** A forwarded message is never treated as a command.

## What you need to decide

Whether the design is right: an LLM (not a regex) decides "is this a framework/model/thinking
change?", constrained to the real allowed values, failing OPEN to pass-through on any doubt,
shipped dark + dry-run first. The write authority and validation are unchanged. If that matches
the intent of the "Intelligence Infers, Keywords Only Guard" standard, approve it.
