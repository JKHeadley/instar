# ELI16 — Instar Mutual SSH-Subsystem Autobootstrap and Continuous Proof

## What is broken today?

Instar can know that two computers belong to the same agent without knowing that
each computer can actually reach the other over SSH. Those are different facts. In
the incident that prompted this work, the laptop could connect to the Mini, but the
Mini could not connect back. One computer did not even have the key it needed. The
setup looked partly healthy until the missing direction became necessary.

## What changes?

Each computer gets dedicated Instar SSH client and host keys automatically. After
the computers have completed Instar's secure pairing, they exchange only public
keys through the already authenticated machine channel. Instar runs its own tightly
restricted SSH endpoint on a normal unprivileged port. That removes any dependency
on Remote Login, sudo, passwords, or editing the operator's SSH files.

Then each computer performs its own real test. The laptop proves laptop-to-Mini;
the Mini proves Mini-to-laptop. Instar says “Instar SSH subsystem verified” only while both
tests are fresh. A test includes a random challenge, a pinned SSH host key, and the
expected Instar machine identity, so reaching the wrong computer does not count.

The endpoint accepts only an `instar-rpc` SSH subsystem. It rejects interactive
shells, arbitrary commands, file transfer, forwarding, and terminal requests. This
gives Instar a genuine SSH transport without quietly granting a new general-purpose
interactive shell into the operator's account. Existing personal SSH access remains
unchanged.

## How does it stay healthy?

Instar repeats the directional proofs on its normal machine-health cadence. If a
peer admission disappears, an endpoint changes, or a dedicated client key is
damaged, it first repairs the problem through the signed Instar mesh and then
retries. The repair loop is bounded: four attempts, two minutes, backoff, deduplication,
and a breaker for flapping failures. A changed SSH host key is treated as a security
event, quarantined, and reported immediately rather than automatically trusted.

If neither a Tailscale nor configured private address can host the endpoint, Instar
reports that precise blocked state after exhausting safe repair. “Zero operator
involvement” means keys, endpoint startup, exchange, verification, rotation, and
ordinary drift repair happen without copied commands or passwords. It never solves a
network boundary by binding publicly or weakening host verification.

## What standard improves?

The lasting change is a Symmetric Transport Proof rule. Any future transport called
“mutual” must hold fresh evidence for both directions, produced by the actual source
machines. Our test matrix will cover both directions through first boot, healthy
refresh, missing keys, damaged peer admission, endpoint drift, host-key drift,
revocation, and restart during repair. This closes the process gap that let pairing
tests pass while a required direction was never exercised.

## What needs to be decided?

The design frontloads the important security choices: SSH comes only after verified
Instar pairing; the endpoint is RPC-only rather than a new interactive shell;
changed host keys fail closed; and rollout begins dark, advances
through observation and real Mini-plus-laptop proof, then becomes an employee-role
readiness requirement. There are no remaining design questions in the spec.

## Phase-1 implementation outcome

The hardened first phase now implements the dedicated identities, restricted endpoint,
authenticated public-key exchange, two-direction proof model, bounded repair,
restart/epoch replay fences, readiness states, rollback ordering, and Machines status
card behind the dark rollout gates. Its transport fixture runs each direction from a
separate operating-system process. The rollout's phase-3 Mini-plus-laptop step remains
the source of the physical two-host evidence required before broader enablement.
