# Local Verify reads open pull requests in small pages — plain-English overview

## What happened

Local Verify is the test run every instar pull request needs before it can merge. One machine holds the job of running it. Every few minutes that machine asks GitHub for the list of open pull requests and their check results, then moves waiting pull requests into the test queue and posts each one's status.

It asked GitHub for that list as one big request: up to 1000 pull requests, every check on each one. GitHub answers this kind of request 100 pull requests at a time. Each page of 100 now has to be built in about ten seconds or GitHub gives up. On 13 November there were 102 open pull requests, the 100-PR page took longer than GitHub allows, and GitHub replied "502 Bad Gateway" every time. From 03:50 UTC every pass failed. The machine kept running the pull requests already in the queue, but it stopped moving anything new in, including PR 3108, which was waiting. Once the queue emptied, nothing would have merged.

## What this change does

The list is now read 25 pull requests at a time, using GitHub's query language directly. Each page takes about a second and a half. All 97 open pull requests on main came back in about 7 seconds. The answer has exactly the same shape as before: on the 30 pull requests the old request could still fetch, old and new results were identical.

## Safeguards

- If any page fails, has an error, or looks wrong, the whole read counts as failed, exactly as before. It never hands back a partial list that would make missing pull requests look closed.
- A pull request with more checks than one page holds is marked "may be cut off", so a missing check is never read as absent.
- Bot authors and unfinished checks are reported in the same form `gh pr list` used, so nothing downstream sees a change.

## What it does not change

The rest of Local Verify is unchanged: queue order, the waiting list, test runs and status posting. Only the way this one list is fetched changes. Reverting the change restores the old request, which will keep failing while there are more than about 100 open pull requests.
