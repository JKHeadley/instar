# ELI16 — Throughput completion count and climbing trend

## What Changed

Imagine a workshop already has a notebook that records how long blocked jobs take to clear. We now add one more line to that same notebook: every time a promised deliverable is genuinely marked delivered, add one tally. We do not make a second notebook, and we do not guess from chat messages, commits, or activity. The tally comes from the existing durable commitment transition, so it represents an actual completion in the system.

The summary endpoint answers “how many completions were recorded in this window?” The trend endpoint lays out every finished UTC day, including days with zero completions, leaves out today because it is not finished, and compares the older half with the newer half. If the newer average is higher, the direction is `climbing`; equal is `flat`; lower is `declining`; too little history is `insufficient-data`. For example, daily totals of 1, 1, 1 followed by 3, 4, 5 produce first-half average 1, second-half average 4, ratio 4, and direction `climbing`.

This is a measuring instrument, not a manager. It cannot choose a task, message a worker, impose a quota, block a merge, or claim that more completions automatically means better work. The observe-only throughput floor from #1533 may display or compare this signal, but it receives no new action authority. Restart reconciliation safely fills in delivered commitments the meter missed, and stable opaque identities prevent duplicate counts.

## What to Tell Your User

I can now show how many real deliverables completed in a window and whether the newer half of the drive is completing more than the older half. The reading stays descriptive: it does not rank people or make decisions.

## Summary of New Capabilities

The existing authenticated lifecycle summary includes a delivered-completion count and daily average. Its trend includes complete zero-count days and reports a rolling direction with an honest sparse-data state. Restart reconciliation preserves counts without duplication, and pool reads keep every origin separate.
