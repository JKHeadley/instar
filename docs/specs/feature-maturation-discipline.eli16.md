# Feature maturation discipline — plain-English overview

Instar already has several pieces of a safe feature rollout system. It can keep a feature off for
most agents, turn it on for development agents, track rollout initiatives, and require evidence
before calling some user-facing work complete. The problem is that a feature can still be shipped
dark without writing down how it will ever become live. Once that happens, caution can quietly turn
into permanent neglect.

This first increment does one deliberately small thing: every new feature spec is expected to carry
a `Maturation plan` section. The plan names three rollout stages by agent class: first a test agent
working under an overseer, then a development agent interacting directly with the user, then the
whole fleet. It also names the evidence required to graduate and the maximum time the feature
should remain at the dark stage. The check initially warns; it does not block convergence. That
lets us observe mistakes in the format before a future change makes the rule mandatory.

The implementation does not add a new rollout database, scheduler, agent allowlist, or testing
engine. It strengthens the existing Maturation Path standard, adds a small pure validator beside
the existing spec-convergence checks, and updates deployed installations through the existing
migration system. The parser checks only whether the required structure exists. It never decides
whether a plan is wise; semantic review stays with the context-rich reviewer.

The wider design names later increments without pretending they ship here. One will surface
features that remain dark beyond their declared window through the existing initiative tracker.
Another will connect existing live-test and apprenticeship machinery and regularly score measurable
rollout evidence using Instar's existing metrics and benchmark systems. Until those arms ship, this
v1 change provides warning visibility, not a complete cure for stuck-dark features.

The main safety choices are straightforward. Rollout stages are classes—test, development, and
fleet—not lists of favored agent names. Existing standards and rollout machinery are extended in
place. Deployed customized files are detected by exact content hashes and left untouched. Stock
files are replaced with durable temporary-file, sync, rename, backup, and recovery behavior so an
interrupted update cannot silently install half a gate.
