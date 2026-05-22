# Weekly docs-coverage audit — plain English

## What this is

The docs-coverage script and the per-PR check that came with it stop docs from getting WORSE — if a contributor adds a feature without documenting it and that drops a category below its floor, CI fails and the PR has to add the doc before it can merge. But that's a regression-only signal. It doesn't catch the slower problem: docs that are stuck at the floor for months because nobody's actively pushing them up. Coverage can be technically passing while gradually accumulating gaps that nobody surfaces.

This change adds a weekly check that surfaces the trend. Every Monday morning, two things happen independently:

The first is an instar job that ships off-by-default in the agent's job templates. Instar-developing agents (the ones with the instar source code on their machine) can flip it on. When enabled, it runs the coverage script, compares to last week's report, and sends the developer a Telegram message if anything's drifted in an interesting way. Most weeks it stays quiet — that means docs are keeping up. Loud weeks mean there's accumulated work to do.

The second is a GitHub Actions workflow that runs the same script on a schedule against the main branch. This one's always on. It posts the weekly report as a comment on a standing GitHub issue, so there's a persistent ledger anyone can scroll through to see how docs coverage has moved over time. Even if every instar-developing agent forgets to enable the job, the workflow keeps producing the trend data.

## How it helps

Documentation drift is a slow problem. You don't notice it day-to-day; you notice it when someone goes looking for a feature six months later and discovers the page they expect doesn't exist. By then the gap has multiplied because new features kept landing on top of the old undocumented ones.

The weekly job is the heartbeat that prevents that compounding. It says, every Monday, "here's the trend." If the trend is bad, that's a small backlog item to triage. If the trend is good, that's confirmation the docs pipeline is keeping up with the code pipeline.

The CI workflow is the safety net for the case where the heartbeat itself isn't running — maybe nobody enabled the job, maybe the agent it's installed on is down for a week. The workflow doesn't depend on any of that. It runs in GitHub Actions against the main branch and produces the same report regardless.

## What the user sees

For the operator of an agent that doesn't develop instar: nothing. The job's off by default and would just say "no instar repo here" if it ran. The CI workflow runs in instar's own GitHub Actions, not theirs.

For the instar-developing agent (Echo, or any other agent that builds instar): a quick Telegram message most Monday mornings, only when there's an interesting trend to surface. The message reads like a conversational heads-up from a teammate ("docs coverage dipped in routes this week — three new endpoints landed without doc mentions, here's where to add them"), not a structured report.

For anyone reviewing instar on GitHub: a tracking issue tagged `docs-coverage` with the running weekly ledger as comments. Useful for "show me the last three months of docs trend" without having to dig through CI artifacts.

## Why not just fix the docs automatically

A fully-automatic docs-fixer is technically buildable but a bad idea. Docs that get written without a deliberate review tend to be either too vague to help or too detailed to maintain. The audit-and-surface loop keeps a human in the deciding seat about what gets written and how — the automation's job is to make sure the human always knows what needs writing.

There's also a structural reason: instar changes go through a spec → ELI16 → side-effects review pipeline before they merge. Letting an autonomous job bypass that pipeline by silently writing docs would create a back door around the very governance the rest of the codebase depends on. Better to keep autonomy in the surfacing layer and humans in the writing layer.

## Why both surfaces

You could pick one or the other and ship that. The job's the more useful one day-to-day (Telegram delivery, conversational language, instant context for whoever's working on instar). The workflow's the more durable one (GitHub-native, doesn't depend on any agent being alive). They overlap but if one breaks the other still surfaces the trend, and the cost of running both is negligible.
