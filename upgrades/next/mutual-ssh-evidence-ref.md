## What Changed

Corrects the `rollout-evidence-ref` in `docs/specs/mutual-ssh-autobootstrap.md`. It named
`/multi-machine/mutual-ssh` — a path with no route anywhere in `src/`. The rollout has been marked
active and unmeasurable since the feature merged on 2026-07-21.

The readout was never missing. It is `GET /machines/ssh-health`, wired the whole time, and it
returns real data right now. The spec simply named the wrong address.

Spec frontmatter only. No runtime surface, no route added, no behaviour change.

## Evidence

Both paths probed live against the running server:

| path | result |
|---|---|
| `/multi-machine/mutual-ssh` (the ref as written) | **404** |
| `/machines/ssh-health` (the real readout) | **200** — `enrollmentState: ssh-bootstrap-blocked`, `pairs[0].mutual: false`, `standingKeyInstalled: false` |

So the graduation criterion — at least one peer pair with bidirectional readiness proof and no
blocking reason — is now evaluable, and currently, correctly, **not met**. Before this change,
"not met" and "not measurable" were the same 404.

The route is served from `src/server/routes.ts` (`router.get('/machines/ssh-health')`) reading
`MutualSshRuntime.status()`, so the corrected ref also satisfies the rollout-evidence lint.

**A correction to my own earlier diagnosis, recorded because it is the more useful finding.** I
first read the 404 and concluded the endpoint had never landed with the feature, and filed an action
to build it. It had landed, under a different name. Concluding absence from a single lookup, without
checking whether the thing exists elsewhere, is the same error this whole sweep is about — and I
made it while running the sweep.

## What to Tell Your User

Some features are released carefully: switched on quietly first, and only turned up once there is
evidence they work. Each one's plan names the readout you check to see that evidence.

This feature's plan named a readout that does not exist — so there was no way to tell whether it was
working, and it would have sat in its cautious first stage forever. The readout it should have named
does exist and has all along.

Nothing about the feature changed. What changed is that its progress can now be read, and right now
it honestly reports that it is not ready yet — which is a much better answer than silence.

## Summary of New Capabilities

- The mutual-SSH feature's graduation evidence is readable at `GET /machines/ssh-health` instead of
  pointing at a path that returns nothing.
