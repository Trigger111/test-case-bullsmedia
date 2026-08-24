# Part 5 — Google Sheets

> **Submission checkpoint:** verify that the live Google Sheet below opens with view-only access
> before sending the repository.

**Live Google Sheet (view only):** [open the completed analysis](https://docs.google.com/spreadsheets/d/19XNy_E980OfmZrXnqib3um87GhrkG2QwAgM9DHOJm1M/edit?usp=sharing)

## Review files

1. Open the live Google Sheet above for the native pivots, filters and charts.
2. Use [final.xlsx](data/final.xlsx) as the corrected exported copy.
3. Read [part-5-analysis-report.docx](part-5-analysis-report.docx) for the business interpretation.
4. Inspect [normalize.gs](scripts/normalize.gs) and [analysis.gs](scripts/analysis.gs) for the
   reproducible transformation and analysis logic. The untouched input is [source.xlsx](data/source.xlsx).

## What was produced

The 1,000 session-level records were normalised into **3,500 ordered page-view rows**. The finished
workbook contains **18 pivot tables** and **9 charts**, covering traffic, engagement, conversion,
revenue-related fields and navigation paths.

The strongest business finding is not a channel winner; it is a tracking inconsistency between the
purchase flag and monetary value:

- **235 non-purchases have a positive value.**
- **200 purchases have zero value.**

Revenue, average order value and conversion conclusions should therefore be treated as provisional
until the event and value definitions are reconciled. The workbook keeps the contradictory records
visible rather than silently reclassifying them.

Two compatibility labels need a precise reading: `Has Revenue` means only `Purchase Value > 0`, not
confirmed revenue, and `Visitor Type` classifies the first/repeat session observed within this extract,
not the visitor's lifetime history.

## Interpretation boundaries

The temporal comparison is a split within this sample, not an experiment or a causal before/after
test. It can describe differences between periods but cannot attribute them to a campaign or product
change without additional context.

Page paths are ordered from the supplied page-view sequence, but they are intentionally
non-canonical: equivalent journeys are not collapsed into a predefined funnel taxonomy. That
preserves source detail, while also meaning path counts should not be read as a single canonical
customer journey.
