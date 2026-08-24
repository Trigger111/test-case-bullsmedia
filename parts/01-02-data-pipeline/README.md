# Parts 1–2 — API and MySQL data pipeline

This folder contains the ingestion and database layers of the assignment. Part 1 loads daily
USD-based exchange rates from APILayer; Part 2 builds the MySQL model and loads country, GDP and
population data from the World Bank. Shared connection, retry, validation and upsert logic lives in
`etl.py` so the notebooks remain focused on source-specific steps.

## Review order

For a code review, the shortest useful route is:

1. [project_1.sql](project_1.sql) — tables, constraints, indexes and analytical views.
2. [etl.py](etl.py) — shared configuration, HTTP retry, batching and incremental-load helpers.
3. [dimensions.ipynb](notebooks/dimensions.ipynb) — World Bank country dimension.
4. [gdp_world_bank.ipynb](notebooks/gdp_world_bank.ipynb) and
   [population_world_bank.ipynb](notebooks/population_world_bank.ipynb) — economic indicators.
5. [api.ipynb](notebooks/api.ipynb) — APILayer validation, gap detection and FX loading.
6. [Design report](../04-documentation/report.md) — modelling rationale, indicator logic and
   production automation plan.

The notebooks include explanatory Markdown and verification output; they are not required merely to
open the submitted Power BI report, because the PBIX contains the imported snapshot.

## Review modes

**Code and artifact review — no MySQL installation required.** The reviewer can inspect the complete
DDL, loader code and notebook output on GitHub, then open the submitted PBIX with its imported data.
The repository deliberately contains neither credentials nor access to the author's local database.

**Full rebuild — optional.** The reviewer starts their own MySQL 8 Server, executes `project_1.sql`,
configures `.env`, and runs the four notebooks in the documented order. MySQL Workbench is only a
graphical client for the server; another MySQL 8 client works equally well. A historical FX backfill
requires the reviewer's own APILayer key, while the World Bank loaders require no authentication.

## Data flow

~~~text
APILayer exchange-rate API ──> api.ipynb ───────────────> exchange_rates
World Bank country API ──────> dimensions.ipynb ───────> dim_country
World Bank indicator API ────> gdp/population notebooks > gdp, population
project_1.sql ────────────────> dim_currency + constraints, indexes and views
                                                        │
                                                        └──> Power BI import
~~~

All exchange rates use `USD` as the base currency. GDP is nominal GDP in current US dollars
(`NY.GDP.MKTP.CD`), and population uses `SP.POP.TOTL`.

## Database objects

| Object | Grain and purpose |
| --- | --- |
| `dim_currency` | One row per provider currency; metadata controls report eligibility |
| `dim_country` | One row per World Bank non-aggregate country, keyed by ISO3 |
| `exchange_rates` | One USD-to-target rate per date and target currency |
| `gdp` | One nominal-GDP observation per country and year |
| `population` | One population observation per country and year |
| `fact_fx_annual` | Annual average/year-end rates and coverage fields for Power BI |
| `dim_year` | Shared year dimension with source-coverage counts |
| `vw_gdp_per_capita` | SQL-side row-level GDP-per-capita check |
| `fx_rate_outliers` | Rates outside the centred 31-day comparison band |
| `vw_data_quality` | Reviewable completeness and integrity checks |

The schema is idempotent. It preserves and upgrades the quota-backed FX table, while GDP and
population are rebuilt because their source is free and quick to reload. Natural keys and
`INSERT ... ON DUPLICATE KEY UPDATE` make overlapping loader runs safe.

## Current snapshot

The submitted artifacts contain data through **2026-08-23**:

- 408,928 daily FX observations across 172 target currencies;
- 217 non-aggregate countries;
- 1,219 GDP observations and 1,302 population observations;
- 1,185 rows in the annual FX view imported by Power BI.

GDP coverage is intentionally ragged because unpublished source observations are retained as gaps
rather than imputed. The current GDP and population snapshot ends in 2025; 2026 therefore contains
FX data but no economic indicators.

## Reproduce the load

Prerequisites: MySQL **8.0.19+**, Python **3.11+**, JupyterLab or Jupyter Notebook, and an APILayer
API key.

From the repository root:

~~~powershell
Copy-Item .env.example .env
# Fill in API_KEY and the MySQL settings in .env.

python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:PYTHONPATH = (Resolve-Path "parts/01-02-data-pipeline")
~~~

Execute [project_1.sql](project_1.sql) in MySQL Workbench or another MySQL 8 client. The script
creates and selects the `analyst_test` database. Keep `MYSQL_DATABASE=analyst_test` in `.env` unless
the script and configuration are deliberately changed together. In Workbench, connect to a running
server, choose **File → Open SQL Script**, open `project_1.sql`, and execute the complete script.

> The script preserves and upgrades `exchange_rates`, but intentionally drops and rebuilds `gdp`
> and `population` inside `analyst_test`. It should not be pointed at an unrelated production schema.

Then start Jupyter:

~~~powershell
jupyter lab parts/01-02-data-pipeline/notebooks
~~~

Run the notebooks in this order:

1. `dimensions.ipynb`
2. `gdp_world_bank.ipynb`
3. `population_world_bank.ipynb`
4. `api.ipynb`

The FX loader requests only missing dates. Each response is checked for the expected USD base,
requested dates, a rates object and known target currencies before any write. Batched upserts for one
validated window share a transaction; a failure rolls the whole window back. HTTP 429 and transient
server errors are retried with exponential backoff.

## Validate the result

Start with the consolidated quality view:

~~~sql
SELECT *
FROM vw_data_quality
ORDER BY status, area;
~~~

Useful grain and coverage checks:

~~~sql
SELECT MIN(date), MAX(date), COUNT(*), COUNT(DISTINCT target_currency)
FROM exchange_rates;

SELECT year, gdp_country_count, population_country_count, fx_currency_count
FROM dim_year
ORDER BY year;
~~~

## Boundaries

- The workflow is notebook-led for reviewability; production use still needs CLI entry points,
  orchestration, run logging and alerting.
- `dim_country.local_currency` is the country's current currency, not an effective-dated currency
  history.
- Some selectable currencies have partial historical FX coverage. The annual view exposes coverage
  instead of silently filling missing dates.
- Suspect FX observations are flagged for review and are not automatically deleted.
