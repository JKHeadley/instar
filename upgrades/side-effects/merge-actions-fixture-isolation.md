# Side effects of isolating the Actions merge fixture

The Actions integration fixture previously ran the checkout’s actual merge script with only a fake GitHub command. The script could discover the developer’s real agent through the checkout’s Git common directory and read its configuration. On a locally verified host the fixture could therefore select the wrong merge contract.

The standalone change combines the Actions-mode environment selection from commit 23dd6370b with the private installed-script layout from commit 5b7d4726a. Each case copies the checked-out scripts into a temporary directory, writes its own Actions configuration, and asserts both the resolved agent home and the absence of a local verification port and credential source. The child explicitly selects Actions mode, while the fake GitHub command records the merge arguments. Existing pending, refused and complete producer checks retain their assertions.

Copying the scripts costs temporary disk space and I/O for each case. The existing cleanup removes only the directory created by the case. No product code, real repository settings, access rules, live server or PR changes as part of running the fixtures. Reverting this test-only change restores the former harness. The original commits remain independently available in their source branches.

The single focused integration invocation passed all six Actions cases and all eighteen local verification cases. The report recorded zero failed, pending or todo cases and the process exited 0. Wall time was 1,427.20 seconds including an ordinary admission wait. Complete verification remains pending.
