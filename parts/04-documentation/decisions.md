# Architecture decision records

Nine decisions worth writing down, in the order I made them. Format follows Michael Nygard's ADR
template: what the situation was, what I chose, and what it costs.

Several of these replaced an earlier approach that did not survive contact with the data. Where that
happened I have kept the first attempt in the Context, because the reason a decision exists is
usually more useful than the decision itself.

| # | Decision | Status |
| --- | --- | --- |
| [001](#adr-001) | Join facts on `country_iso3`, not country name | Accepted |
| [002](#adr-002) | `DECIMAL(20,10)` for exchange rates, not `DOUBLE` | Accepted |
| [003](#adr-003) | Generated column plus covering index for the annual aggregate | Accepted |
| [004](#adr-004) | Load real World Bank data instead of mocking GDP and population | Accepted |
| [005](#adr-005) | Business logic in SQL views, not Power Query | Accepted |
| [006](#adr-006) | Flag suspect rates, never delete them | Accepted |
| [007](#adr-007) | Row-level calculated column; measures for dynamic indicators | Accepted |
| [008](#adr-008) | Gap detection instead of a high-water mark | Accepted |
| [009](#adr-009) | No database triggers | Accepted |

---

## ADR-001

### Join facts on `country_iso3`, not country name

**Status:** Accepted

**Context**

The brief lists `country` on both `gdp` and `population`, so my first version joined them to each
other on the country name. It ran without error, which is the problem — nothing complained, the row
counts just did not line up.

Looking at what the World Bank actually publishes explained it:

```
Egypt, Arab Rep.        Korea, Rep.         Venezuela, RB
Congo, Dem. Rep.        Bahamas, The        Micronesia, Fed. Sts.
```

43 of 217 names carry a comma, an abbreviation or a bracket. They are also not stable: `TUR` arrives
as `Turkiye` because the World Bank renamed it in 2022. A join on a name would have broken that year
and stayed broken until someone happened to notice.

**Decision**

Add `country_iso3` to both fact tables. Make it the join key and the foreign key target, and key
`dim_country` on it. Keep `country` because the brief asks for it, but let nothing depend on it.

**Consequences**

- Referential integrity is now enforceable — the FKs found two rows my loader had been dropping.
- Country names become display-only, so a source rename is cosmetic rather than breaking.
- One extra `CHAR(3)` per fact row. Negligible.
- The names still matter for map geocoding in Power BI, and those same 43 awkward names are the ones
  most likely to fail. That is a live limitation, not something this decision fixed.

---

## ADR-002

### `DECIMAL(20,10)` for exchange rates, not `DOUBLE`

**Status:** Accepted

**Context**

`DOUBLE` is the obvious choice for a rate and it is what many sample schemas use. Binary floating
point does not represent most decimal fractions exactly, and repeated conversion and aggregation
can amplify that implementation detail.

The precision also has to survive a wide range: `IRR` trades near 1.3 million per USD while some
pairs are quoted to eight or more decimal places.

**Decision**

`DECIMAL(20,10)`: ten integer digits and ten decimal places. Source values are rounded to this scale
at ingestion. `CHECK (rate > 0)` rejects a non-positive parse or source value.

**Consequences**

- Arithmetic is exact at the declared database scale and reproducible across queries.
- `DECIMAL` is slower than `DOUBLE` and wider on disk. At 408,928 rows this does not register.
- Aggregates widen the type — `AVG(rate)` in `fact_fx_annual` comes back as `DECIMAL(24,14)`. Worth
  knowing when comparing values across layers.

---

## ADR-003

### Generated column plus covering index for the annual aggregate

**Status:** Accepted

**Context**

The dashboard needs an average rate per currency per year. The obvious query was:

```sql
SELECT target_currency, YEAR(date), AVG(rate)
FROM exchange_rates GROUP BY target_currency, YEAR(date);
```

`YEAR(date)` is a function applied to a column, so no index can serve it:

```
type=ALL   rows=405868   Using temporary; Using filesort
```

Every row scanned to produce 1,185 rows of output. About 90 ms for a single currency — tolerable
once, not tolerable on every refresh, and the report was going to run it repeatedly.

**Alternatives considered**

- *Index `date` alone.* Does not help; the function still has to be evaluated per row.
- *Materialise an aggregate table.* Works, but adds something to keep in sync and a staleness window.
- *Let Power BI aggregate the daily table.* Would mean importing 408,928 rows into the model.

**Decision**

Store the expression, then index it together with everything the query touches:

```sql
rate_year SMALLINT UNSIGNED AS (YEAR(`date`)) STORED,
KEY ix_fx_currency_year (target_currency, rate_year, rate)
```

The index is **covering** — filter column, grouping column and aggregated column are all in it, so
MySQL never reads the table.

**Consequences**

- `type=ref, rows=2427, Using index`. **405,868 rows scanned down to 2,427; 90 ms down to 3 ms.**
- Two bytes per row plus the index; the table sits at roughly 19.5 MB. Writes are marginally slower.
  For something written once a day and read constantly, an easy trade.
- The FK on `base_currency` forces InnoDB to build another index on a column that is always `USD`.
  Wasted, but it is what the constraint costs and the constraint is worth more.
- `dim_currency.is_selectable` uses the same technique for a different reason — it keeps the
  slicer's filter rule in the database rather than duplicated in the report.

---

## ADR-004

### Load real World Bank data instead of mocking GDP and population

**Status:** Accepted — a deliberate departure from the brief

**Context**

Part 2.4 says GDP and population "don't have to reflect real figures but must be coherent". Mocking
them is less work and unambiguously within the brief.

The problem is that mocked figures cannot falsify anything. If I invent Poland's GDP, I cannot then
check whether my currency conversion produces Poland's published GDP in złoty — the conversion will
agree with whatever I made up.

**Decision**

Load `NY.GDP.MKTP.CD` and `SP.POP.TOTL` from the World Bank API for 2020–2025. The country
dimension contains 217 non-aggregate countries; population covers all 217 for each year, while GDP
retains only observations published by the source.

**Consequences**

- The conversion chain became checkable, and the check failed the first time. That is how I found
  the per-year conversion bug in [ADR-007](#adr-007)'s territory — see the report §b.
- The outlier test has genuine outliers; the data-quality view reports real gaps.
- The data is messier than a mock. GDP coverage falls from 210 countries in 2020 to 186 in 2025, and
  six countries never report at all. I surface that rather than trimming years until it looks tidy.
- Part 1's "extract from an API" pattern gets exercised three times instead of once.
- Reloading depends on a third-party API being up. Acceptable — it is free and unauthenticated.

---

## ADR-005

### Business logic in SQL views, not Power Query

**Status:** Accepted

**Context**

Annual rollups, the outlier test, per-capita and the quality checks all have to live somewhere. Power
Query is the path of least resistance inside Power BI and keeps everything in one file.

**Decision**

Five views: `fact_fx_annual`, `fx_rate_outliers`, `vw_gdp_per_capita`, `vw_data_quality`, `dim_year`.
Power BI imports the views and adds no transformation steps of its own.

**Consequences**

- A `.sql` file can be read, reviewed and diffed. M code inside a `.pbix` can be none of those, which
  matters as soon as more than one person touches the project.
- Any other consumer of the database — another report, a notebook, an export — gets the same
  definitions rather than reimplementing them.
- The logic now has to be maintained in two places conceptually: SQL for shaping, DAX for anything
  responding to a slicer. The line between them is "does it depend on user selection", which has held
  up so far.
- Views are computed on each query. `fact_fx_annual` is cheap because of ADR-003; a heavier view
  would want materialising.

---

## ADR-006

### Flag suspect rates, never delete them

**Status:** Accepted

**Context**

`fx_rate_outliers` compares every daily rate against its own centred 31-day moving average and flags
anything above 2× or below 0.5×. It returns 194 rows, 0.047% of the table, across 15 currencies.

Two different things are in there. Single-day anomalies — `HNL` on 2023-01-18 quoted at 0.0339
against surrounding quotes near 24.6, and `MGA` on 2022-12-06 at 3.47 against surrounding quotes
near 4,400 — alongside multi-week stretches in `GHS LYD YER SYP LBP SDG` that look like the
provider switching between the official and the parallel-market rate.

The second group is the reason not to clean automatically: those values may well be correct for what
the provider was quoting.

**Decision**

Leave every row in `exchange_rates`. Publish the suspects through a view and surface them on a Data
Quality page in the report.

**Consequences**

- Averages include the bad values. The 31-day window means a single-day glitch moves an annual mean
  by a negligible amount, but the multi-week `SYP` and `LBP` windows do have a visible effect.
- The evidence survives. Someone questioning a number can see exactly which observations are
  suspicious rather than wondering why totals changed.
- Correctness of the report now depends on a reader noticing the flag. Mitigated by putting the count
  on a KPI card rather than burying it in a table.
- The rule is one rule. A moving average catches spikes well and slow drift badly.

---

## ADR-007

### Row-level calculated column; measures for dynamic indicators

**Status:** Accepted

**Context**

Part 3.3 asks for calculated columns and measures. A calculated column is evaluated and stored at
refresh; a measure is evaluated in the current filter context. Currency selection, year filters and
regional aggregation therefore belong in measures, while a stable row-level check is a suitable
calculated-column use case.

**Decision**

Add `GDP per Capita Row (USD)` to the GDP table as a calculated column, looking up population for the
same country and year. Use measures for totals, GDP-matched population, coverage and currency
conversion. Keep the database-generated `rate_year` for the separate indexing purpose described in
[ADR-003](#adr-003).

**Consequences**

- The calculated column satisfies the row-level requirement and provides an inspectable validation
  value.
- Measures remain responsive to country, region, year and currency slicers.
- The aggregate GDP-per-capita measure is still a ratio of sums; summing or averaging the row column
  would answer a different question.
- `GDP (Selected Currency)` performs a small year-level iteration, rather than storing one currency
  choice at refresh time.

---

## ADR-008

### Gap detection instead of a high-water mark

**Status:** Accepted

**Context**

The first version of the incremental loader resumed from `MAX(date) + 1`. That is the standard
pattern and it is wrong in a specific, silent way.

If one batch fails partway through a backfill, the dates in that batch are now *behind* the high-water
mark. The next run starts after them and never returns. The data is permanently incomplete, no error
is raised, and the only symptom is a number that is slightly off.

I hit this while backfilling: a rate-limit error killed one window, and the next run happily picked up
from the newest date it could see.

**Decision**

`etl.missing_dates()` diffs the dates actually present in the table against the expected calendar and
returns every hole, wherever it sits. `etl.to_windows()` then groups them into API-sized ranges. A
window is validated before writing, and all of its upsert batches share one commit; an exception rolls
the window back.

**Consequences**

- A failed or incomplete window is rolled back and repaired by re-running, with no manual date
  arithmetic.
- Combined with the idempotent upsert, any run is safe to repeat at any time.
- One extra query per run to fetch the loaded dates. At 2,427 distinct dates this is nothing.
- The expected calendar has to be defined somewhere — `BACKFILL_START_DATE` — and it must stay
  aligned with `START_YEAR` in the two World Bank loaders. That coupling is a footgun and is
  documented at the top of each notebook.

---

## ADR-009

### No database triggers

**Status:** Accepted

**Context**

The brief mentions triggers as one route to keeping data up to date. They are a reasonable thing to
reach for: derived columns, audit trails, cascading updates.

**Decision**

No triggers for freshness or aggregation. Derived values come from generated columns and views;
external data arrives through explicit loaders. Production freshness requires those loaders to be
called by a scheduler.

**Consequences**

- A trigger on `exchange_rates` would fire 408,928 times during a bulk load. Row-at-a-time work on a
  set-at-a-time operation.
- Logic inside a trigger is invisible to anyone reading the schema or the ETL code. A generated column
  is declarative and appears in `SHOW CREATE TABLE`.
- Triggers genuinely do earn their place for audit trails and cross-table invariants that constraints
  cannot express. If this schema grew a requirement like that, this decision should be revisited —
  which is the reason it is written down rather than merely not done.
- Audit is handled instead by `created_at` / `updated_at` on all five tables.
- The current notebooks are suitable for reproducible review, but production still needs CLI entry
  points, scheduling, run logging, metrics and alerts.
