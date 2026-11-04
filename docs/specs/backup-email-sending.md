---
title: "Sending email from an agent"
slug: "backup-email-sending"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "backup-email-sending.eli16.md"
related-specs: "recommended-services.md"
status: "stub"
---

# Sending email from an agent

Owner: Echo. Fourth in the backup work order (`recommended-services.md`, Frontloaded Decisions). Closes the `gap` on the `email` row. On the list by operator decision, 2026-11-03.

## Problem statement

An agent has no general way to send a scheduled report by email. The row stays unavailable until one exists, and it has no backup, because nothing else delivers to an inbox.

## Acceptance

An agent sends a scheduled report that arrives in the owner's inbox, proven from a real inbox rather than a provider's receipt. If email is unavailable, the report still reaches the owner by another channel. A drill proves that, and the catalog row moves off `gap`.

## Questions this spec must answer

- Which provider or providers, and what each costs and asks for. The person's own mailbox, an account the agent holds, or both, since whose account to use is the person's choice.
- What leaves the machine, and what stops mail being sent to anyone other than the owner without approval.
- How a report that can't be sent falls back to another channel, and how the owner learns it did.
- Whether reading email is in scope, or sending only.

## Status

Stub. Not reviewed or approved, and nothing is built.
