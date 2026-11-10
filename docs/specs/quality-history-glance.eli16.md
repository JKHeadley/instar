# Quality history at a glance — plain-English overview

**Why this exists.** Justin was told to "glance at the quality chart" and the link he got had no chart on it. The only real chart in the dashboard was hidden two taps deep, one feature at a time. He has just approved a rule that every capability that is supposed to be improving must show a clear picture of its history: getting better, getting worse, and how sure we are.

**What already existed.** The agent already records numbers for each feature it is measuring (for example "unknown reads" or "breaker open"), on a schedule, with a goal for each. The maturation page could already draw one of these as a small chart, but only after you opened a single feature's measurement details.

**What is new.** One link opens straight onto a page of small charts, one per measured number, worst first: anything that is off its goal comes first, then numbers with too few samples to judge, then the ones at their goal. Each chart shows the recorded values as dots, the goal as an amber dotted line, and the recorded starting point as a dashed line when one really exists. Hollow dots mean the comparison is not verified. Under each chart is one plain sentence such as "Off goal: now 150, goal at most 48. Was 44 on Nov 4." Anything off its goal has an "Ask what to do" link. The main maturation page gets a "Quality history charts" link at the top.

**Being honest about what we do not know.** Today almost nothing has a recorded starting point, so the page says so in one line at the top, with a link to ask how to fix that, and each chart is labelled "Comparison not verified". The page never draws a line between dots unless they were recorded as continuous, never averages points together, and counts anything it could not read instead of hiding it.

**What does not change.** Nothing is stored, nothing is switched on or off, and nothing gets blocked or allowed. It only reads numbers the agent already keeps. Undoing it is a plain revert.

**What to decide.** Nothing is needed from the reader. The page is read-only and sits behind the same switch and sign-in as the maturation page.

**One fix after the first full test run.** A repository check counts error handlers that quietly swallow failures. The new caching code sat close enough to an existing handler that the check misread that handler as a quiet one. The caching code now lives in its own small function. The check's limit is unchanged, and a failed read is no longer remembered as an answer.
