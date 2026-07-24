# Convergence Report — Operator Pushback as Honest Improvement Data

## Verdict

Converged after three focused rounds. The design is ready for operator review as
a documentation-only proposal. It changes no runtime behavior and grants no
authority.

## Review perspectives

- **Repository grounding:** traced current main from the deterministic deferral
  recognizer through tone-gate provenance, the typed judgment-provenance reader,
  the Correction Capture Loop and Ledger, the decision-quality annotation
  chokepoint, and benchmark-divergence’s static prediction mirror.
- **Honesty and measurement:** challenged every path that could turn
  disagreement, recurrence, operator insistence, agent concession, or model
  confidence into a fabricated grade.
- **Adversarial/security:** reviewed authenticated ingress, causal target joins,
  prompt injection, principal scope, privacy/linkability, cross-machine
  duplication, retention/deletion, feedback-loop gaming, and staged rollback.

## Material changes from the first architecture sketch

1. Selected the existing Correction Ledger as the canonical durable observation
   surface; rejected a parallel pushback ledger.
2. Narrowed ACT-896 to an outbound-behavior precursor that requires a later
   authenticated causal join; rejected hash/time proximity as proof.
3. Split pushback classification from correctness grading and added a mandatory
   `unknown` class.
4. Added per-occurrence provenance so record-level maximum confidence or weight
   cannot launder weak observations into grade eligibility.
5. Defined an E0–E5 evidence ladder. Only causally independent E3+ evidence can
   produce right/wrong through the existing registered-rule chokepoint.
6. Kept scrubbed summaries inside the current correction policy and made the
   measurement projection genuinely content-free.
7. Separated benchmark authoring/admission from both correction capture and the
   prediction mirror; hashes cannot become runnable cases.
8. Prohibited raw pushback rates from benchmark divergence, rewards, routing, or
   model promotion.
9. Added authenticated-principal scope, metadata-only multi-machine dedupe,
   conflict-to-unknown behavior, tombstones, retention, and anti-gaming
   denominators.
10. Split implementation into independently promoted dark/dry-run-first phases.

## Honesty-line audit

The final design keeps four propositions distinct:

1. an authenticated operator pushed back;
2. the system classified the type and target of that pushback;
3. independent evidence settled the underlying decision;
4. a privacy-safe reproducible benchmark case was reviewed and admitted.

No proposition implies the next. The capture utterance, taxonomy classifier,
agent response, recurrence counter, and grade oracle cannot collapse into one
causal source.

## Extend-not-duplicate audit

- no second inbound observer;
- no second corrections database;
- no second judgment-provenance parser;
- no direct decision-outcome ledger writer;
- no benchmark case data in the prediction mirror;
- no raw/scrubbed conversation copied into measurement or pool state.

## Remaining assurance

The three rounds were independent Codex-agent reviews grounded against current
main. The proposal remains `draft` and `approved: false`; operator review is the
approval boundary. No runtime implementation is authorized by convergence.
