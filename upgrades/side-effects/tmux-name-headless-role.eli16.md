# A background job keeps its own window name when it runs again

Background jobs run in terminal windows with names. A recent change (PR 3426) makes sure two different jobs or conversations never share a window name. But when a background job started, the code asked for a name without saying which job it was for. So when the same job ran again under the same name, the rule thought the earlier run belonged to "someone else" and gave the new run a numbered name.

The fix: a background job now says which job (or conversation) it belongs to when it asks for its window name. The same job running again gets the same name, and two different jobs still never share one.

I checked it against every test that starts sessions or chooses their names (92 test files, 2,244 tests): all pass.

What needs deciding: nothing.
