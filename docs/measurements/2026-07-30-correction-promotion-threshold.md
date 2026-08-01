# Correction promotion similarity threshold measurement

Date: 2026-07-30
Issue: CMT-1133
Selected threshold: **normalized-token Jaccard ≥ 0.65**

## Corpus and method

The measurement used Echo's live
`.instar/correction-ledger.db`, opened with `better-sqlite3` in
`readonly: true, fileMustExist: true` mode. It contained 37 correction records
over 14 calendar days. The analyzer job remained disabled, the preferences file
was not touched, and no database row was mutated.

The replay uses the production `CorrectionAnalyzer` implementation through
`scripts/correction-promotion-corpus-replay.mjs`. Similarity is Jaccard over the
set of tokens returned by `CorrectionLedger.normalizeLearning()`. Grouping is a
stable-order, same-kind, complete-link first-fit: a record may enter a cluster
only if it is at or above the floor against **every** existing member. The
recurrence counts are then computed over all exact keys in each bounded cluster
with the normal deterministic-weight floor.

After `pnpm build`, the reproducible command is:

```text
node scripts/correction-promotion-corpus-replay.mjs <absolute path to correction-ledger.db>
```

The script prints record ids and aggregate counts, never learning text.

## Candidate thresholds

| Threshold | Clusters | Multi-record cluster sizes | Lowest accepted pair | Interpretation |
|---:|---:|---|---:|---|
| 0.50 | 29 | 4, 5, 2 | 0.5200 | Admits the broadest compact groups. |
| 0.55 | 31 | 4, 2, 3 | 0.5833 | Rejects two weaker joins. |
| 0.60 | 32 | 4, 3 | 0.6087 | Two compact subfamilies remain. |
| **0.65** | **32** | **3, 2, 3** | **0.6522** | Three compact subfamilies; every accepted pair clears the declared floor. |
| 0.70 | 32 | 2, 3, 3 | 0.7000 | Same cluster count, but one 0.65-level relationship is lost and records are repartitioned. |

Manual review identifies one 13-record approval-links family in the corpus. The
same-kind guard intentionally prevents treating all 13 as one cluster: 11 were
classified `user-preference` and 2 were classified `infra-gap`. At 0.65, the
complete-link rule recognizes three compact `user-preference` subfamilies of
sizes 3, 2, and 3. It deliberately does **not** collapse all wording variants
into one connected component: under the superseded single-link algorithm, 20 of
the 36 pairs inside the 9-record component were below 0.65 and the minimum was
0.3846. Those bridge-only joins violate the false-merge posture.

The strongest pair placed in different clusters at 0.65 is **0.8421**, not
0.25. This is not contradictory: complete-link membership depends on a
candidate clearing the floor against every existing member, so a strong pair
can be separated when joining their clusters would introduce a weak pair.
Similarly, excluded-to-selected edges of 0.5455 and 0.5217 explain why the old
single-link component grew from 9 to 11 at 0.50. Therefore 0.65 is documented as
the **within-cluster pair floor**, not as a universal semantic separation
boundary or a claim that every excluded pair is weak.

## Gate replay result

At 0.65 the production analyzer reports:

```json
{
  "rows": 37,
  "clusterCount": 32,
  "multiRecordClusters": [
    {
      "kind": "user-preference",
      "size": 3,
      "support": 3,
      "days": 1,
      "sessions": 1,
      "crosses": false
    },
    {
      "kind": "user-preference",
      "size": 2,
      "support": 2,
      "days": 1,
      "sessions": 1,
      "crosses": false
    },
    {
      "kind": "user-preference",
      "size": 3,
      "support": 3,
      "days": 1,
      "sessions": 1,
      "crosses": false
    }
  ],
  "crossedCount": 0
}
```

This is the honest result. The current live corpus does **not** promote a
preference because all 13 human-recognized family records came from
2026-07-09 in `echo-llm-pathway-characterization`. Each selected compact
subfamily is below support (3/4, 2/4, and 3/4), and all correctly fail both
durability prongs (1/2 days and 1/2 sessions). Even the superseded 9-record
connected component could not promote because it had only one day and one
session. No similarity threshold can repair missing temporal/session diversity
without wrongly deleting the decided safeguards.

The automated analyzer test supplies the missing prospective proof: four
same-kind paraphrases at/above the 0.65 edge cross only when their qualifying
occurrences span two days and two sessions. A matching one-session fixture stays
below the gate. This proves the family is promotable after a genuine later
recurrence, not from the existing one-session burst.

## Decision

Use **0.65** as a measured minimum similarity for **every pair admitted to a
cluster**. It retains three compact, manually recognizable paraphrase groups in
the live corpus, while the complete-link rule removes the unsafe bridge behavior
that a scalar threshold alone cannot prevent. A compact group can become
promotable when later exact-key or same-cluster recurrence earns support plus
the unchanged day and new session diversity requirements.

This is one 37-row corpus from one machine. The constant should be revisited only
with a larger labeled corpus. Its present justification is empirical and
conservative, not a claim of universal semantic separation; the observed
0.8421 excluded pair makes that limitation explicit.
