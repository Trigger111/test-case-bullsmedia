# Part 3 — Power BI

The submission includes the review-ready PBIX and its readable PBIP project source. The PBIX/PBIP
round-trip was saved on **2026-08-24**, after the DAX coverage fix and calculated-column addition.

## Open first

Open [Bulls-media.pbix](Bulls-media.pbix). It contains the imported 2026-08-23 snapshot and opens on
**GDP Overview**, so database access is not required for a visual review.

| Artifact | Purpose |
| --- | --- |
| [Bulls-media.pbix](Bulls-media.pbix) | Portable report for the reviewer |
| [Bulls-media.pbip](Bulls-media.pbip) | Power BI Project entry point |
| [Report definition](Bulls-media.Report/definition/) | Version-control-friendly pages and visuals |
| [Semantic model](Bulls-media.SemanticModel/definition/) | TMDL tables, relationships, measures and calculated columns |
| [Theme](BullsMedia-Theme.json) | Report styling |

## Report pages

1. **GDP Overview** — headline GDP, GDP per capita, coverage, trend, map and country detail.
2. **Country Detail** — one-country analysis in USD, selected currency and current local currency.
3. **Data Quality** — GDP/population coverage, FX coverage and suspect-rate observations.

The currency slicer is disconnected by design: measures read the selection and apply the relevant
annual rate. GDP is converted year by year because it is a flow. The local-currency measure requires
one country in context.

## Metric checks

- `GDP per Capita (USD)` is a ratio of GDP to GDP-matched population: **$13,830.26** for 2024 and
  **$13,065.12** across 2020–2025 in the all-country context.
- `GDP Coverage %` counts country-year pairs: **93.63%** across 2020–2025 and **85.71%** in 2025.
- `GDP per Capita Row (USD)` is the required calculated column for row-level inspection; measures
  remain the source for filter-responsive totals.

## Refresh notes and limitations

Power BI imports annual FX, GDP, population, dimensions and quality views from MySQL. A refresh
therefore requires a reachable database and matching credentials, although the submitted PBIX
already contains the snapshot.

The country-to-currency attribute is current-only, not historical. Some selectable currencies have
partial historical FX coverage; warning measures surface that condition. FX has 2026 observations,
but GDP and population do not, so 2026 economic KPIs are blank by design.

Design rationale and full indicator definitions are in the
[Part 4 report](../04-documentation/report.md).
