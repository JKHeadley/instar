# Using your spare computers to speed up testing: the revised plan (plain version)

Written 18 November 2026. It can be read with no other background.

> The one-line version: your laptop takes part of our slowest groups of tests inside a sealed box, practises for about a week until its answers have been shown to match ours, and then its passing answers are used. By itself that is worth only a few more merged changes a day (my estimate is 1 to 3). Its real value is as the first step toward a much larger gain.

## The problem in one breath

Every change to Instar is tested on two of our own computers, the Studio and the M5, before it can be merged into the shared code. A test run is as long as its slowest group of tests. On the Studio that group is the "integration tests": 36 minutes of a 38-minute run. You asked whether your laptop and the old Windows PC could help, using spare capacity even while you use them, and backing off when you need them.

## What already exists

- **The test line.** Two machines, each testing one change at a time. It merged 57 changes in the last 24 hours.
- **The sealed box on your laptop.** A small Linux virtual machine, installed with your yes on 18 November. It is switched off and uses 5 GB of disk. It cannot see your files or reach your network.
- **One measurement.** Inside that box, your laptop ran our integration tests in about half the test time the M5 takes (the M5 was doing other work at the same time, so the real gap is smaller). 963 of 966 test files passed there.
- **The first design.** Approved earlier the same day, and you said it looked too restrictive to help. You were right: it only practised, only on the quick tests, only on code already merged, and needed a second design before anything got faster.

## What this adds

The big change: **your laptop's answers start to count, and it works on the slow tests.** When the Studio starts a test run, it gives up to half of its slowest group to your laptop and runs the rest itself. If the laptop finishes its part and the answers pass, the Studio skips those tests. A Studio run drops from about 38 minutes to about 30.

- **Practice has an end, and it is judged on evidence.** At first the laptop's answers are only compared with ours. Practice ends when every test file has been compared at least once, the laptop has correctly reported real failures at least five times, and it has never passed a test that fails on our machines. I expect that to take about a week, and after 7 days a decision is made on whatever was collected, so practice cannot drag on. The session that runs the test line then decides, on a report, whether the answers start to count. No further design and no second question to you.
- **It tests changes that are still waiting to be merged,** not only ones already merged. That is where the help matters. Before any of those run on your laptop, the box first runs every test once on merged code, to show it works properly on your machine.
- **The Windows PC practises at the same time,** paired with the M5, after its own question to you.

## The safeguards that stay, and what each one costs

You asked that every restriction name what it costs, and that a real benefit survive them all. Here they are.

**Your machine is protected by two things, and both are cheap.** Tests run only inside the sealed box, which has fixed memory, no view of your files and no route to your home network. Tests have no internet at all. The box uses your internet connection only to download the standard software packages, and only from code that is already merged. And it stops the moment you are busy, on battery or short of memory. Cost: almost none. The tests ran at full speed inside the box.

**The line never waits for your laptop.** Anything the laptop has not finished, the Studio runs itself. Worst case, a run takes as long as it does today.

**A wrong answer from a borrowed machine is caught three ways.** Every run includes a set of tests with known answers, which catches a test runner that is simply broken. The Studio re-runs about 1 in 20 of the laptop's passed tests itself, picked at random. And a few hours apart, our own machines test everything that has merged, with no help; that run is the safety net, so it never uses a borrowed machine. If a wrong answer is caught, nothing from your laptop is used in that run, and if it happens on merged code or twice in a day the laptop goes back to practice automatically. A single unreliable test on our side does not count against it. You hear about it only if a wrong answer actually let a faulty change through. Cost: about 5% of the gain, and the safety-net runs get no speed-up. What this means for you: a wrong answer from your laptop could let a faulty change through. The safety net, a few hours later, catches it if the fault is still there.

**A failure reported by your laptop never blocks a change on its own.** The Studio re-runs that test itself and uses its own answer. Cost: a few seconds.

**Only our own code runs there.** Changes from our own branches, never from a stranger's copy of the project. Software packages are installed only from merged code, so a waiting change never gets to run anything with internet access. Cost today: nothing. None of the last 150 merged changes added packages.

**What I removed.** A word-matching filter that kept many test files off borrowed machines; it protected the same thing the box already protects, so now it only records what it sees. And a rule that ignored a sleeping laptop for up to 8 hours after it woke.

## What you get

I have now given you several figures for this, each lower than the last, so here is the working, checked by the reviewers line by line. I took the Studio's own logs for 15 to 18 November. It tests 31 to 46 waiting changes a day, but only 13 to 17 of those pass and run their full 38 minutes; the rest fail and stop early, so help saves little on them.

- **About 1.5 more merged changes a day** if your laptop helps with the slowest group of tests and is free for every run.
- **About 3 a day** if it also helps with the second-slowest group. Whether those tests run well in the box is not measured yet.
- **Half of either** if the laptop is free half the time: under 1, or about 1.5.

Against the 57 changes the line merges a day now, that is small, and the safeguards are no longer the reason. The reason is that one busy laptop is only shortening part of each test run on the slower machine, while that machine still spends a whole slot on every change.

**So why build it?** Because it is the first step toward the version that pays. If your laptop can carry most of a test run, not just a slice, then the Studio's own part becomes small and it can test a second change at the same time. By my rough estimate that is worth 6 to 17 more merged changes a day per spare machine. That estimate rests on one measurement (how fast your laptop runs the slowest group) and two guesses (how fast it runs the other two groups), so treat it as a guess until the first pass measures them. It needs everything in this plan first: the box, the proof that both sides tested the same code, the practice period, the spot checks. And most of this plan is already built.

Nothing counts before the real number is known. If practice shows under 1 a day and the first pass shows the larger step is not possible, I will say so and it gets switched off.

## What ships when

1. The design is reviewed by the automated reviewers and the Chief of Staff (starting now).
2. I change the helper that is already built (it is in a draft and not in use) to match.
3. Before anything is switched on, your laptop's agent asks you once: the problem, exactly what changes, what yes does, what no does. Nothing runs on your laptop before that yes. One thing in that ask goes further than what I told you on 18 November: after one pass on merged code, the laptop would run changes that are still waiting, during practice too, not only afterwards.
4. One pass of every test on merged code, then about a week of practice, then the decision to count, then a report after 7 days of counting.

## What I need from you

Nothing now. If any part of this looks wrong, or still too cautious, tell me and I will change it before it is built.
