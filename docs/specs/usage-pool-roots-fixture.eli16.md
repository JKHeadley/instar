# Make the usage-history test follow the order it is testing

The usage ledger reads saved conversations from every account folder on a computer. When it finds a backup copy before the original, it must keep the observation without counting it twice. A test checks that behavior for both Claude and Codex, in both discovery orders.

The test used to choose a timestamp thirty milliseconds in the future and then create the original conversation files. On a busy computer, creating the Claude file could take longer than those thirty milliseconds. The ledger then correctly treated the event as older than its file, which is the rule for copied history. The test failed even though its intended original was simply created too late.

This change creates both original files first, chooses an event timestamp at or after both files’ recorded birth times, and then writes their conversation content. The backup is still created later. Every existing assertion remains, including the totals and the check that repeated scans count nothing again. Production code does not change, and the copied-history safeguard is not weakened.

A controlled delay reproduced the old failure and passes with this ordering. The change still goes through the normal full verification before merge. Reverting the test change fully rolls it back; no account setting, credential, conversation or stored usage record is changed.
