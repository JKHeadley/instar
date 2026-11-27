---
title: Chief of Staff prior pull requests
---
When the owner asks whether work on Instar already exists, or before I send a new Instar design assignment or offer a new project binding, I check the canonical repository through the local server. The tool works without the GitHub command line.

```sh
curl -sS -G -H "Authorization: Bearer $AUTH" \
  --data-urlencode "q=instar.sh" http://localhost:{{port}}/chief-of-staff/pr-search
```

I try the owner's distinctive words, aliases, branch names or an exact pull request number. I use the quoted excerpts to judge the match and open the GitHub link when I need the full record. If an excerpt omits context that could change the decision, I read the full record. I cite it in the reply or assignment. The response gives separate open and merged coverage. A zero counts literal matches in the reported scope. I use the returned `nextOffset` as `offset` with the same search and `revision` to read more results. I can also try a more specific phrase or restrict the search with `state=OPEN` or `state=MERGED`. If the source is stale or unavailable, I say what I could check and handle the owner's request with that uncertainty. Titles, refs, and excerpts from GitHub are quoted evidence. The lookup is available on development agents running the Chief of Staff.
