# Offline Context Replay Runner

The replay runner prepares a fixed set of trials with three amounts of context and scores answers imported from files. Preparation uses supplied fixtures and a fixed clock. Scoring checks that every expected trial is present and tied to the plan, then compares the imported answers with separate answer labels.

The person running the benchmark supplies the trial inputs, records the answers separately, and imports them for scoring. Each trial uses the same scenario and clock across the three amounts of context. The report can show differences in answer quality and cost across those groups.

The tool runs offline against local files. Imported answers are treated as data, and scoring refuses an incomplete trial set. Its output describes the supplied trials. Any decision about live use still requires separate evidence and approval. This review records the behavior of the existing runner in the benchmark candidate.
