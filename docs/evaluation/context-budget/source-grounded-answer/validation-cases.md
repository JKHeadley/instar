# Future Validator Acceptance Cases

These are generic design examples, not executed tests or private evaluation questions. A runtime implementation must exercise these boundaries with real parser, manifest and aggregation dependencies. JSON Schema validation alone does not meet them.

| Input or event | Required recorded result |
| --- | --- |
| Answer source record contains `A😀B`; citation is `[1,2)` | Valid span naming the single emoji; offsets count Unicode code points. Semantic support still needs judgment. |
| Same text; citation is `[2,2)` or `[1,4)` | Invalid span; never repair or clip it. |
| Valid source identifier exists in the full manifest but was withheld from the answering arm | Answer citation invalid; judge may independently cite it as original truth evidence, without treating it as supplied answer evidence. |
| A well-formed judge object repeats a criterion or omits one scheduled criterion | Judge error; preserve output and answer trial, never infer a pass. |
| Raw JSON repeats a key or exceeds its declared byte cap | Parsing error before semantic scoring, even when a permissive parser could return an object. |
| Unsupported permission appears only inside an answer limitation | Grade it as a material assertion; cite `limitations/<index>`. |
| Main answer has a material assertion absent from the declared claims | Report its record and span; apply the frozen claim-completeness criterion. |
| A citation names a human question next to an agent proposal | Do not infer human approval merely from adjacency or chronology. |
| A general uncertainty statement has no citation | May be appropriate; it cannot establish a project fact or permission. |
| One judge passes a critical criterion and the other fails it | Disputed criterion plus a persistent critical-failure signal; qualification blocked pending policy-bound adjudication. |
| Both judges fail the same noncritical criterion | Failed criterion; retain both reasons and sources. |
| A judge times out and a later bounded retry succeeds | Preserve error and retry, count both costs, and follow the predeclared retry policy. Never replace the first record. |
| Adjudicator identifies a reference defect after seeing disagreement | Preserve initial findings, create a versioned correction and apply the declared policy to all affected arms. |
| Correct answer is equally reliable without evaluated context | Preserve result but exclude it from retained-context evidence. |
| Source export has consistent hashes and unauthenticated speaker metadata | Integrity passes; authenticity remains unestablished. Do not promote that metadata into authority. |

The future validator should also prove that reference labels cannot reach the answer producer, forbidden effects cannot execute, and the actual source and output bytes match recorded hashes. Those requirements need an implementation boundary, not additional prose examples.
