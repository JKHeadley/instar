# Plain overview: a slow test given more time

One set of automated tests for voice-note transcripts pretends a transcription takes a twentieth of a second, then waits a tenth of a second before checking the result. On a busy machine running the whole test suite, a tenth of a second was sometimes not enough, so the test failed although nothing was wrong. That blocked an unrelated change from merging. The waits are now six tenths of a second, which leaves plenty of room. No part of Instar itself changes; only the test waits longer.
