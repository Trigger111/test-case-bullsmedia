# Design report

Part 4 explains the database design, financial and economic assumptions, and a practical path from
the current notebook-led workflow to scheduled production refreshes. The implementation is in
[the pipeline folder](../01-02-data-pipeline/); architecture decisions and field definitions are in
[decisions.md](decisions.md) and [data-dictionary.md](data-dictionary.md).

**Snapshot:** 2026-08-23  
**Stack:** MySQL 8.0.45, Python 3.11+, Jupyter, Power BI Desktop  
**Loaded data:** 408,928 daily FX observations, 1,219 GDP observations, 1,302 population
observations and a 217-country dimension.

GDP and population come from the World Bank rather than generated sample data. This makes the
pipeline and its currency conversions independently checkable against published indicators:
[GDP, current US$](https://data.worldbank.org/indicator/NY.GDP.MKTP.CD) and
[population, total](https://data.worldbank.org/indicator/SP.POP.TOTL).

## A. Database design

The schema contains five base tables and five views:

| Object | Role |
| --- | --- |
| `dim_currency` | Currency metadata and the report's selectable-currency rule |
| `dim_country` | Stable ISO3 country key, region, income group and current local currency |
| `exchange_rates` | Daily USD-base rates at date/currency grain |
| `gdp` | Nominal GDP in current US dollars at country/year grain |
| `population` | Population at country/year grain |
| `fact_fx_annual` | Annual average and year-end FX rates with coverage fields |
| `fx_rate_outliers` | Rates outside a centred 31-day comparison band |
| `vw_gdp_per_capita` | SQL-side row-level validation of GDP per capita |
| `vw_data_quality` | Reviewable data-quality checks |
| `dim_year` | Shared year dimension and source-coverage counts |

### Types and constraints

- `DECIMAL(20,10)` stores FX rates without binary floating-point drift; the source value is rounded
  to that declared scale at ingestion. `DECIMAL(20,2)` is sufficient for nominal GDP values.
- `CHAR(3)` represents ISO currency and country codes, `DATE` preserves the daily grain,
  `YEAR` enforces the economic-data grain, and `BIGINT UNSIGNED` accommodates national
  populations.
- The natural primary key `(date, base_currency, target_currency)` makes FX upserts idempotent.
  GDP and population use `UNIQUE (year, country_iso3)` for the same reason.
- Foreign keys prevent orphan facts. Positive-value checks reject invalid rates, GDP and population;
  case-sensitive regular expressions enforce uppercase three-letter codes.
- `created_at` and `updated_at` make changes traceable. Currency succession is represented by the
  self-reference `dim_currency.replaced_by`.

Country names are display attributes, not join keys. ISO3 avoids breakage when a provider changes a
label. The annual FX view groups on a stored `rate_year` column and uses the covering index
`(target_currency, rate_year, rate)`; Power BI therefore imports 1,185 annual rows instead of the
408,928-row daily fact.

The complete DDL and comments are in
[project_1.sql](../01-02-data-pipeline/project_1.sql). Shared Python functions in
[etl.py](../01-02-data-pipeline/etl.py) keep connection, retry, validation, batching and upsert logic
out of notebook cells; the notebooks document source-specific steps.

## B. Indicator logic and assumptions

### GDP conversion

GDP is a flow accumulated throughout a year, so the report uses `avg_rate`. A stock measured at a
date, such as reserves or debt outstanding, would use `eoy_rate`. For a multi-year selection,
`GDP (Selected Currency)` converts each year with that year's rate and then sums. Multiplying a
multi-year GDP total by one blended rate would weight years incorrectly.

If the selected currency has no rate for an in-scope GDP year, that year's conversion is blank and
the displayed total can represent only the covered years. `Currency Warning` states whether rates
are missing or based on a partial year, so the result is not presented as complete without a visible
qualification.

`GDP (Local Currency)` is meaningful only for one country at a time and therefore returns blank in
multi-country context. The `local_currency` attribute is the country's current currency, not an
effective-dated history. It must not be interpreted as the currency legally used in every historical
year.

### GDP per capita and coverage

GDP per capita is a ratio of sums. Its denominator includes population only for country-year pairs
that also have GDP, so incomplete GDP coverage cannot depress the result by adding unmatched
population. With the current snapshot:

| Context | Result |
| --- | ---: |
| All countries, 2024 | $13,830.26 |
| All countries, 2020–2025 | $13,065.12 |
| GDP country-year coverage, 2020–2025 | 93.63% |
| GDP country-year coverage, 2025 | 85.71% |

GDP coverage is ragged: 210 countries have GDP in 2020 and 186 in 2025, while population has a
complete 217 × 6 grid. `GDP Coverage %` counts available GDP country-year pairs against the
population country-year grid in the same filter context.

Part 3 asks for both calculated columns and measures. `GDP per Capita Row (USD)` is a calculated
column used for row-level validation. Measures perform dynamic aggregation and respond to year,
country, region and currency filters. This separation avoids storing a slicer-dependent currency
conversion in a refresh-time column.

### Data limitations

- FX runs through 2026-08-23; GDP and population stop at 2025. The 2026 year is present for FX
  monitoring but has no GDP or population.
- Some currencies have incomplete historical FX coverage. The data remains visible and is flagged.
- The outlier view flags suspect quotes but does not delete them. A moving-average rule is a review
  aid, not proof that a quote is wrong.
- Annual averages use calendar-day observations supplied by the provider.
- Local-currency history would require an effective-dated country/currency bridge.

## C. Automation and freshness

The current solution is reproducible but still notebook-led. It already provides the foundations for
safe unattended runs:

1. HTTP requests retry rate limits and transient server errors with backoff.
2. Each API window is validated for USD base, requested date range and known currencies before write.
3. Batched upserts commit once per validated window; an error rolls back that window.
4. Missing-date detection finds historical gaps instead of relying only on `MAX(date)`.
5. Natural keys make overlapping reruns safe, and `vw_data_quality` exposes completeness issues.

A production implementation would add thin CLI entry points around the existing Python functions,
then schedule an explicit dependency chain: dimensions, World Bank GDP/population, daily FX,
quality gates, and finally Power BI refresh. GDP/population can run less frequently than FX because
the source updates at a different cadence.

The scheduler should record run ID, source window, row counts, duration and status; publish metrics;
alert on failed requests and unexpected quality counts; and keep credentials in a secret manager.
A gateway refresh should start only after the quality gate succeeds. Versioned migrations are needed
once more than one database environment exists.

Database triggers are not the freshness mechanism here: they operate after data reaches MySQL and
cannot call the external APIs. Generated columns and views handle deterministic derivations, while a
scheduler handles extraction and refresh. A narrowly scoped trigger could be justified later for an
audit trail or a cross-table invariant that normal constraints cannot express.

Setup and review order are in the [repository README](../../README.md).
