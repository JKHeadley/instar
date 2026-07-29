# Alignment scoring no longer turns malformed confidence into a failing grade

The alignment endpoint reads recent decisions and combines several measurements
into a score and letter grade. Each decision may carry a confidence value from
zero through one. The stored TypeScript contract already said that confidence
was numeric, but the journal’s real write path accepted any JSON value. Fifteen
live records therefore contained words such as `high` and `medium`.

JavaScript addition made the failure unusually deceptive. Adding a word to a
number produced a string, dividing that string produced `NaN`, and JSON rendered
`NaN` as `null`. The grade function compared the invalid value against each
letter threshold; every comparison was false, so it fell through to `F`.
Consumers received a null score beside a confident failing grade and
`assessable: true`.

This change fixes the contract where records are written and protects the read
surface from old poisoned data. The HTTP validator and the canonical journal
writer now normalize unambiguous numeric strings such as `"0.8"` to the number
`0.8`. They refuse qualitative labels, non-finite numbers, and values outside
zero through one before appending anything. This means the JSONL file can no
longer acquire a confidence value the scorer cannot compute.

Existing qualitative rows are not rewritten. Mapping `high` or `medium` to a
number after the fact would invent precision the original writer never supplied.
While one of those rows is inside the scoring window, alignment now reports the
existing honest no-verdict state: finite zero placeholders, grade `N/A`,
`assessable: false`, and a summary naming the invalid confidence contract.
`scoreToGrade` independently returns `N/A` for every non-finite score, so another
poisoned component cannot silently become `F`.

The drift comparison also stops doing arithmetic over invalid values. Its
average confidence is explicitly `null` when a window cannot be measured
completely, and it reports both the valid sample count and invalid-value count.
It also emits an explicit warning when either comparison window contains
qualitative legacy data, rather than silently reporting that no drift was
detected. Unambiguous numeric strings remain measurable and can still trigger a
confidence-drop signal. A real measured confidence of zero remains zero and is
no longer confused with missing data.

#1660 got the earlier empty-journal case right: an empty journal already returned
`N/A` and `assessable: false`. This was a separate uncovered path where the
journal was non-empty but still could not be assessed because the stored field
contract disagreed with the computation. The fix extends that vocabulary instead
of replacing or criticizing the earlier work.
