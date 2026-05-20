# Deployment Lockdown — ELI16 Companion

**Who this is for:** Justin (and any operator reading the lockdown spec for the first time)
**Reads in:** ~3 minutes
**Companion to:** Deployment Lockdown rev 2 spec (technical)

---

## The story in one paragraph

A while back, I was supposed to ship some big changes as "v1.0.0" — a major milestone. You told me **not to deploy**. The code shipped anyway, four times, labeled as small patches (v0.28.122 through v0.28.125). It took 12 hours before either of us noticed. The reason wasn't that I forgot your instruction — I genuinely thought publishing was paused. The reason was that the part of our system that actually publishes to npm **doesn't read intent from any of the places we write it**. It ignored what I put in `package.json`. It ignored the narrative in our upgrade notes. It just looked at what was already on npm, added one to the patch number, and shipped. The lockdown spec is the seven independent locks I want to install so that this can't happen again — no matter how confused I get, no matter how clever the next attacker is, no matter what an agent does on autopilot.

---

## What "shipped" means here and why it hurts

When we say a release "shipped," we mean: an automated workflow on GitHub ran `npm publish`, and now any user running `npx instar` somewhere in the world pulls that version. There's no undo. You can mark a version as deprecated, but the code that went out is what users have.

So when I say "your no-deploy instruction failed," I mean: real users got code I wasn't supposed to send them. The code was correct — that's the only reason this story isn't worse — but the version number was misleading and the trust contract between us was broken.

---

## The seven locks, each in one sentence

1. **The publisher must read `package.json`.** Before: ignored it. After: respects it. ✅ Already done — shipped as v1.0.8.
2. **A small file says "we're in a holding pattern."** A `release-tier.json` with `"tier": "hold"` means the publisher refuses to ship, period.
3. **Major work lives in a separate workspace.** Not on `main`, not in the shared repo — in an isolated checkout in my own home directory, on a branch the publisher's trigger doesn't watch.
4. **The upgrade notes file can say "don't ship me yet."** A `hold: true` line at the top of `NEXT.md` is a soft-stop the workflow honors.
5. **Major versions need two signatures.** Going from 1.x to 2.x can't happen with one button press. Two cryptographic signatures must be present in the commit.
6. **Mismatches cause loud refusal.** When the publisher detects something off — your local version doesn't match what npm has, or hold is on but content says ship — it stops and tells you, both as a PR comment and as a Telegram message. No more silent overwrites.
7. **Future-me reads this case study at session start.** A hook injects the case-study link into my context whenever I'm about to touch the release path, so I can't accidentally repeat the mistake from forgetfulness.

Any one of these would have prevented the 2026-05-19 incident. All seven together is what we call "defense in depth" — for the system to fail again, every lock would have to fail.

---

## Why the worktree pattern matters here

We already have a development rule called the **worktree pattern**: when I'm doing multi-PR work, I make an isolated copy of the repo at `~/.instar/agents/echo/.worktrees/<feature>/` and work there. The shared instar checkout stays on `main` and stays clean. This protects us from a bunch of small bugs (sandbox EPERM issues, parallel-session stash bleed, MERGE_HEAD gate failure) and it's already how every other big initiative ships.

Major-version work is the longest, most multi-PR work we ever do. So it's the work that benefits most from this pattern. **Lock #3 in the spec is just "use the worktree pattern, but make it mandatory for major-version work and back it up with a workflow trigger restriction."** That's it. No new discipline — just enforcement of what we already do everywhere else.

The bonus from doing it this way: when the major branch is ready to cut, we **rebase onto main, not merge**. Rebasing gives us a single clean commit that says "this is the moment v1.0.0 became real." Merging would create an auto-generated merge commit that hides intent (and would hit the worktree merge-commit gate bug, which is documented).

---

## What's already done vs. what's left

| Lock | Status | Notes |
|------|--------|-------|
| 1. Publisher reads package.json | ✅ Shipped | v1.0.8 (PR #265). Verified by v1.0.9–v1.0.13 all releasing cleanly. |
| 2. `release-tier.json` hold file | Not started | **Highest leverage next move.** One small PR. |
| 3. Worktree isolation for major work | Not started | Pattern already exists; needs workflow trigger restriction + CONTRIBUTING entry. |
| 4. NEXT.md hold frontmatter | Not started | Small PR. |
| 5. Two signatures for major | Not started | Medium PR — needs Ed25519 key management. |
| 6. Loud refusal on coherence mismatch | Not started | Adds PR-comment + Telegram-mirror on workflow refusal. |
| 7. Session-start memory injection | Not started | Lightest PR. |

---

## The single thing I'd ship next

**Lock #2: ship `release-tier.json` with default `"hold"`.**

It's one small PR. The moment it lands, every future auto-publish is paused until someone deliberately flips the tier. We don't even need the other six locks for that single change to give you the "no chance of accidental major-version deployment" guarantee you asked for. The other locks harden the system around it.

If you say go, I'll cut it from a fresh worktree at `~/.instar/agents/echo/.worktrees/deployment-lockdown/` and walk it through `/spec-converge` → `/instar-dev` end-to-end. No mid-session check-ins; one final report with the PR merged and npm verified to still be on v1.0.13.

---

## The two things to remember about why this works

1. **Intent has to live in the workflow's input, not in our heads.** Before: I said "no deploy" in chat, you said "no deploy," and the workflow shipped anyway because it never looked at chat. After: "no deploy" is a committed file the workflow reads first, before doing anything else.

2. **Locks are independent and additive.** You don't have to wait for all seven to be done. Each one closes a different attack path. Lock #2 alone gives you the headline guarantee; the other six are belt-and-suspenders.

That's the whole spec, in plain English. The technical version has the actual config schemas, workflow YAML changes, and PR ordering. This page exists so you can stay grounded on the why and the leverage points without parsing the YAML.
