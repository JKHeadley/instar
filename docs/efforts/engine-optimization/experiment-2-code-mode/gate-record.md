# Gate record (first 4 tasks), decided 2026-11-20 20:34 PST before any later run was read

Rule fixed in analyze.mjs before results were read: stop early only if the on arm's cost per successful task is not lower than the off arm's over the first 4 tasks.

Result over 24 valid runs (3 per arm per task): saving 0.5% (off $0.0393, on $0.0391 per successful task), completion 100% in both arms, 2 of 4 tasks slightly cheaper on, 2 slightly cheaper off. By the rule this is a continue, but it is a near miss: the saving is far below the 20% bar. Decided to continue anyway because the remaining 48 runs cost about $1.50 of ordinary subscription usage and 4 tasks is too few to settle the question.

Invalidated runs: the first 6 runs of T02-rename were thrown out (archived in results.invalid-t02.jsonl) because the check demanded the WHOLE test suite pass, and the fixture carries a deliberate failing pagination test for T03, so a perfect rename could never pass. The check now runs only the services test. T02 was rerun in full (6 runs) with the corrected check; the failed-check rows are not counted anywhere.
