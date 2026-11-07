# Keep the detail that explains a measurement

A large count of checks does not tell us how many features are currently represented by their latest recorded results. This change keeps those two counts separate in the existing readout. The latest-state count covers evaluated features in the requested time window; it is not a promise that every installed feature has a valid measurement contract. The separate inventory view still owns that question.

The stored history already records when a check was due, when it ran, which rules and stage it used, and whether evidence was missing. The shared readout would preserve those details instead of reducing every point to a date. A rule or stage change remains visible. Matching adjacent points does not prove that every expected check happened, or that a feature improved.

The response has a fixed size limit because another machine must be able to receive it. Allocation tries each feature’s newest evidence before spending space on older history. If even that cannot fit, the omitted-point counts stay visible. The response says how many features or older points were omitted. The original ledger is unchanged, so a short view does not delete its evidence.

Older machines can still return their old readout. A machine claiming the new format must supply consistent counts and valid times; invalid evidence is shown as unavailable instead of a clean result. The newer baseline/outcome detail remains alongside it. No new database, scheduler, promotion rule or blocking authority is introduced. This is the remaining original history-read increment, separated from constitutional wording approval. It still needs the normal tests and release before any deployment claim.
