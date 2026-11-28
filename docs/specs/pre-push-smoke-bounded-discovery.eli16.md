# Bounded pre-push smoke discovery

When a developer pushes a change, the local check tries to run a small sample of related tests. Our test runner was opening and transforming the dependency graph for every test just to discover that a change reached too many files. That could take several minutes and time out without running a single test.

The push check now recognizes common shared inputs early. It checks test files directly changed by the developer when they fit the local budget and tells the developer that the broader run belongs to CI. For a narrow source change, it finds related files once. It uses the same list to count test cases and run them, instead of asking the test runner to build the graph again.

The push log shows which path was used. Full verification still runs through the shared line and the required checks still decide whether the change can merge.
