<!-- internal-only -->
# Split paged-history integration tests

## What Changed

The four existing cases run in two independently schedulable files. Each privacy case uses the same test callback and closes the same private fixture, while the recipient-export check keeps its original callback.

## Evidence

Independent source review compared both callbacks byte for byte, including the separate-process denial and fixture cleanup. All four original full test names are preserved.

The focused run passed all four original cases with raw child exit zero and zero unhandled errors. Each file ran two cases, taking 6.107 and 5.139 seconds. Full verification timing with fresh and established filename history is still needed to assess overall savings.
