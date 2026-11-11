# Round 1 triage (spec sha256 f8b3f90d…, 1,335 words)

Reviewers: 6 internal lenses (security, scalability, adversarial, integration, decision-completeness, lessons-aware), plus GPT 6 Astra and Fable 5.2 (both MINOR ISSUES). Standards-Conformance Gate: ran, 3 flags (Maturation Path, Judgment Within Floors, Verify the State).

**Health line, round 1:** design findings ≈ 17 (with heavy overlap; 10 distinct, as listed below), precision ≈ 15. New durable mechanisms added by the revision: 0. Words 1,335 → about 1,650.

| Distinct DESIGN finding | Raised by | Resolution in r2 |
|---|---|---|
| The cached version goes stale, and the probe is sync with no timeout | Astra, Fable, scalability, lessons, adversarial, SCG | Async helper; key realpath+size+mtime; 2s timeout; spawn never waits; failures never cached |
| Criterion 3 contradicts the spawn-error case | Astra, Fable | Reworded: "reaches a built launch spec" |
| `off` is undefined (Claude env channel; Codex remap) | security, adversarial, decision, lessons | D1/D2, `channel` and `requestedValue` |
| Model/framework can change before the build; route fallback | adversarial | `launch.framework/model` from the spawned spec; D4 |
| Triage path records before the spawn | security | Triage excluded (non-goal) |
| Job field must be on manifest + validateJob, not just frontmatter | integration, security | §1 names every path; builder clamp |
| Run rows are machine-local, not replicated | integration | Posture corrected; graduation is per machine; gap filed |
| No Frontloaded Decisions; record shape is a published interface | decision | Section added; D5 freezes the shape |
| Maturation rungs; underived threshold | lessons, SCG, decision | Rung table; judgment-candidate with floor + arbiter; provisional target |
| The ratchet counting method can be gamed | Fable, adversarial, lessons, decision | D6 counts literals; D7 adds zero |

Precision items applied: E2E route name (`/history`); triage and other callers scoped; the dashboard is not a surface; the migration sniff string; record size caps; the alternative design is named.
