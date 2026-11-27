# Security fixes keep the experience whole: the plain version

**What this is.** A new rule in Instar's constitution, the document of standards every change to Instar is reviewed against. Justin started a standing security program for Instar on November 15, 2026, and asked that security patches never make Instar worse to use unless there is truly no other way to close a critical hole. This change writes that rule into the constitution, in the exact words he approved.

**What it says.** A security fix should be one the user does not notice. Every security change has to say what the user will see or do differently. If the user loses anything (an extra step, a slower reply, something refused, a feature switched off), the change must also show that the hole was critical and that no fix without that loss was found. If the hole was not critical, a fix that makes things worse goes back for a different design. Whether a hole is critical is decided by the independent review of the fix, not by whoever wrote it.

**What changes.** Nothing at runtime. Reviewers of security changes now have a written rule to check against, and each security pull request's side-effects review includes a "User-visible effect" line. Nothing blocks a merge on it automatically yet; the article says so plainly.

**What a reader needs to decide.** Nothing more: Justin already approved the wording. The only judgment in this pull request was placement. It sits right after "The User Experience Is the Product", which it builds on.
