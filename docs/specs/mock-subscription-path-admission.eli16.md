# Give mock subscription tests their own admission file

The provider factory routes a request to either a command-line program or a subscription pool. Five unit cases test that routing with a simulated pool and a mocked command launcher. The real factory still wraps those substitutes in the code that limits how many provider processes can run on a computer.

The tests now create a temporary home for each case and check where the wrapper will store its count. The real wrapper uses that private file while deciding whether to run the mock. At the end of the case the fixture resets its process-local state, restores the home lookup and removes the temporary directory.
