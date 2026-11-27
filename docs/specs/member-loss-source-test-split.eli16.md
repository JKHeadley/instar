# Run the member-loss checks in two files

These checks exercise the conversation graph when a machine leaves. One group checks which records are still available. Another checks how the remaining machine reads them. Each group has 18 cases, including the interrupted-runtime case in the first group.

The verifier schedules test files. Giving it two files lets it place these groups separately. Each case still creates its own graph and each file still loads the fixture that closes servers, databases and temporary directories after every case.

An earlier full run spent 168.140 seconds in the original file. The time to finish a complete verification depends on other files and on the scheduler's history for each filename. Compare complete runs with fresh and established filename history before attributing a change in overall runtime to the split.
