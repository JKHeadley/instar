# Standards measurement: trust the instrument and its result

The standards measurement already ran a real test three ways: clean, with a protected mutation, and clean again. W3.6 fixed its test counting by reading Node's structured events instead of decorated console text. The remaining problem was authorship: the branch-owned event collector created the counts and assertion classification, while the authenticated receipt covered only process-exit facts.

W3.7 makes the collector's exact protected bytes part of the authority. A protected plan names a known SHA-256. The verifier reads the collector from the protected snapshot, compares that expected digest before doing anything, copies the approved bytes into each isolated workspace, and compares again immediately before execution. A mismatched collector returns UNKNOWN without running or creating evidence.

The collector now signs both its ready event and the exact structured observation with an ephemeral key. The independent receipt authority pins that identity, verifies the sequenced observation, and issues the child-exit receipt only when it links to the exact last authenticated event. Promotion therefore depends on one chain: approved collector bytes -> signed structured observation -> receipt-bound event -> live execution artifact.

The negative control replaces the protected collector with an exact-schema forgery claiming 999 passing tests. Digest comparison refuses it before its marker write, returns UNKNOWN, and produces no artifact. The positive control still passes clean, fails after the relevant mutation, and passes pristine confirmation; both fake renderer summaries remain ignored.

Node 22.18.0 and 25.6.1 do not have a built-in `json` test reporter: both interpret `--test-reporter=json` as a missing custom package. A custom reporter would recreate the same authorship boundary, so the protected content-addressed collector remains necessary.
