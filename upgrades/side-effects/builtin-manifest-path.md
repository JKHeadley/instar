# Side-effects review — builtin manifest path resolution + load-state honesty

**Change:** `CapabilityMapper.loadBuiltinManifest()` resolved `__dirname/../data/builtin-manifest.json`,
which is `dist/data/` in a compiled install — a directory that does not exist. Resolution now
enumerates both the source and installed layouts, and reports `loaded` / `not-found` / `unreadable`
instead of returning a bare `{}` for all three.

**Decision point touched?** Yes, in the weak sense: `builtinManifest[id]` drives capability
*provenance* (instar / agent / user). It gates no action and blocks nothing, but it does decide what
the map claims about origin — which is why an unreadable manifest silently reading as "no builtins"
mattered.

---

## 1. Over-block

Nothing is newly blocked or rejected. The change is strictly widening (one candidate path becomes
two) plus an added report field. No input that previously succeeded now fails.

The only behavioural sharpening: a manifest that is present but *unparseable* now returns
`state: 'unreadable'` instead of silently yielding `{}`. Callers still receive an empty entry set, so
nothing downstream breaks — they simply gain the ability to tell the difference.

## 2. Under-block

The load state is reported but not yet *acted on*. `summary.builtinManifest` makes an unreadable
manifest visible to a reader of `/capability-map`; nothing raises an attention item, logs a warning,
or fails a health check when it is `not-found` on a deployed agent. That is deliberate for this
change (signal before authority), and it means an install with a genuinely broken manifest will still
look normal to anyone not reading the field. Stated rather than implied.

Also not addressed: **why** `dist/data` was expected in the first place. If the intended design was
for the build to copy the manifest into `dist/`, that build step still does not exist. This change
makes the read work regardless, which is the safer direction, but it does not settle the question.

## 3. Level-of-abstraction fit

Correct layer. The defect is in how one module locates its own data file, and the fix is in that
module. The resolution is exported as a pure function taking a module directory — the minimum needed
to make it testable — rather than being pushed into a shared path helper, which would be a wider
change than the bug warrants.

## 4. Signal vs authority compliance

Compliant, and improved. The manifest was already a signal (provenance labelling). Previously it
failed *silently*, which is the pattern `docs/signal-vs-authority.md` warns about: a component that
cannot report its own degradation. It now reports state while retaining exactly the same
non-blocking, non-throwing behaviour. No new authority is introduced.

## 5. Interactions

`CapabilityMap.summary` gains one field (`builtinManifest`). This is an additive change to a
serialised read surface consumed by `/capability-map` and its compact rendering. Existing consumers
that read known fields are unaffected; a consumer doing exact-shape validation on the summary object
would see a new key.

`loadBuiltinManifestFrom` and `builtinManifestCandidates` are newly exported from
`CapabilityMapper.ts`. That widens the module's public surface by two pure functions with no side
effects beyond reading a file.

No change to when the manifest is loaded (still once, in the constructor), so no new I/O on any hot
path.

## 6. External surfaces

`GET /capability-map` responses gain `summary.builtinManifest`. No endpoint added or removed, no
config key, no agent-visible behaviour change beyond more accurate provenance on installs where the
manifest previously failed to load — which is expected to be *all* of them.

Worth stating plainly: on deployed agents this change will cause builtin provenance to start
resolving where it previously did not. Capability counts by provenance will shift — `instarProvided`
up, `unmapped` down. That is the fix working, but it will look like a change in the numbers.

## 7. Multi-machine posture

**Machine-local by design, and correctly so.** The manifest is a static artifact shipped inside the
installed package: every machine reads its own copy from its own filesystem, and there is nothing to
replicate, proxy, or reconcile. Two machines on different instar versions will legitimately hold
different manifests, which is the correct behaviour — the manifest describes *that install*.

No `machine-local-justification` marker is needed here because this introduces no new state surface;
it corrects the path of an existing per-install read.

## 8. Rollback cost

Low. Revert the module: the resolution returns to a single path and the summary field disappears.
No data migration, no persisted state, no schema change, no agent state to repair. Consumers of the
new summary field would see it vanish, which is why it is additive and optional rather than replacing
an existing field.

The one thing a rollback re-creates is the original defect — deployed agents silently reporting zero
builtins — so a rollback should be accompanied by an explanation of what failed, or it will look like
the bug returning on its own.
