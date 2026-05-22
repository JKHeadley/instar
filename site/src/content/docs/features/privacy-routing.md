---
title: Privacy Routing
description: Sensitive responses route to DM instead of public topics.
---

When your agent is operating in a multi-user Telegram group with public topics, some replies shouldn't be visible to everyone. A user asking the agent about their personal finances in a public topic creates an obvious privacy mismatch — the question was scoped to a public space, but the answer belongs in a private one.

`OutputPrivacyRouter` is the component that decides whether a given outbound message should go to the public topic where the question originated or get rerouted to a DM with the originating user. It's the implementation of Gap 10 from the User-Agent Topology Spec.

## How it works

For every outbound message, the privacy router runs a fast classification pass over the content. If the content is judged sensitive — based on configurable patterns plus a lightweight LLM check for borderline cases — the response is suppressed in the public topic and delivered as a DM to the user who triggered it. A short placeholder in the public topic says "responded privately" so the conversation flow stays coherent for other observers.

The default sensitivity heuristics cover:

- Financial figures, account numbers, payment details
- Health and medical information
- Credentials, tokens, secrets that leaked into a response anyway
- Anything the user explicitly tagged as private in earlier conversation context

Operators can extend the patterns via config under `privacy.routePatterns` in `.instar/config.json`. The router fails closed: if classification is ambiguous, the message routes to DM rather than risking public exposure.

## When privacy routing engages

The router only runs when:

- The originating channel is a multi-user public surface (Telegram group topic, Slack channel)
- The configured autonomy profile allows automated DM sends (set in `AutonomyProfileManager`)
- The recipient user has DM capability with the bot

In private 1:1 contexts, the router is a no-op — there's no public/private mismatch to resolve.

## Interaction with the Coherence Gate

`OutputPrivacyRouter` runs after the Coherence Gate completes its review. The gate decides whether the response is safe to send at all; the privacy router decides where to send it. Two independent concerns, two separate components.

## Why this isn't optional

Without the router, every reply lands wherever the question was asked. In single-user setups this is fine; in shared groups it leaks information across users. Privacy routing is what makes a multi-user agent actually safe to deploy in shared Telegram groups or Slack workspaces.
