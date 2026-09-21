---
type: llm
focus: last_message
weight: 2
---

The repository's cached PR-description prompt is 200 days old, and a rebuild of it failed an hour
ago because `gh` is not authenticated. The skill's back-off rule says not to retry a learn that
failed within the last 24 hours: draft from the stale cache instead, and mention the last attempt's
reason.

Score the closing lines the agent wrote after the draft:

1. It says the repository's cached prompt was not rebuilt on this run — stale, out of date, skipped,
   backed off, any wording that makes the fact plain.
2. It gives the reason the last attempt failed, or names `gh` authentication as what stopped it.
3. It is short — roughly one line, at most two. A paragraph about staleness, a recap of the driver's
   passes, or an offer to rebuild the cache is a deduction.
4. It does not claim the prompt was rebuilt, relearned or refreshed, and does not present the draft
   as having come from a freshly learned prompt.

Full credit when all four hold. Point 4 failing is a zero: reporting a rebuild that never ran is the
regression this case exists to catch.
