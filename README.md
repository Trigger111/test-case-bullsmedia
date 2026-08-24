# Bulls Media — Analyst Test Task

An end-to-end analytics solution covering API ingestion, MySQL modelling, Power BI and Google Sheets.
The repository is organised by assignment part so a reviewer can inspect the finished artifacts first and
then follow the implementation detail. Data figures below are a snapshot as of **2026-08-23**.

## Review in 5 minutes

1. Read the short [design report](parts/04-documentation/report.md) for the database rationale,
   indicator logic and production automation plan.
2. Open [Bulls-media.pbix](parts/03-power-bi/Bulls-media.pbix). It lands on **GDP Overview** with
   imported data, so reviewing the report does not require a database refresh.
3. Open the corrected [Part 5 workbook](parts/05-google-sheets/data/final.xlsx) and its
   [analysis document](parts/05-google-sheets/part-5-analysis-report.docx).
4. For a technical review, start with the [Parts 1–2 pipeline guide](parts/01-02-data-pipeline/README.md),
   then inspect the [SQL schema](parts/01-02-data-pipeline/project_1.sql),
   [ETL helpers](parts/01-02-data-pipeline/etl.py),
   [architecture decisions](parts/04-documentation/decisions.md) and
   [data dictionary](parts/04-documentation/data-dictionary.md).

## Deliverables

| Part | Result | Primary files |
| --- | --- | --- |
| 1 — External data | APILayer exchange-rate ingestion | [Pipeline guide](parts/01-02-data-pipeline/README.md), [API notebook](parts/01-02-data-pipeline/notebooks/api.ipynb) |
| 2 — Database | Five tables, five analytical/quality views and World Bank loaders | [Schema](parts/01-02-data-pipeline/project_1.sql), [notebooks](parts/01-02-data-pipeline/notebooks/) |
| 3 — Power BI | Three-page interactive report with readable PBIP source | [PBIX](parts/03-power-bi/Bulls-media.pbix), [Power BI notes](parts/03-power-bi/README.md) |
| 4 — Documentation | Design rationale, economic assumptions and automation | [Report](parts/04-documentation/report.md), [ADRs](parts/04-documentation/decisions.md) |
| 5 — Google Sheets | Normalised data, pivots, charts and business analysis | [Final workbook](parts/05-google-sheets/data/final.xlsx), [Part 5 notes](parts/05-google-sheets/README.md) |

Final artifacts are paired with reviewable source: SQL and Python for the pipeline, PBIP/TMDL/PBIR
for Power BI, and Apps Script for Google Sheets. The portable PBIX and XLSX copies are included so
the main results can be inspected without rebuilding the environment.

## Key results

- **FX:** 408,928 daily USD-base rates across 172 target currencies, from 2020-01-01 through
  2026-08-23. Power BI imports the 1,185-row annual view instead of the daily fact table.
- **Economic data:** a 217-country dimension, 1,302 population rows and 1,219 GDP rows. GDP coverage
  is ragged: 210 countries in 2020 and 186 in 2025.
- **Power BI:** GDP per capita uses population from the same country-year coverage as GDP.
  In the all-country context it is $13,830.26 for 2024 and $13,065.12 across 2020–2025;
  GDP coverage is 93.63% across those years and 85.71% for 2025.
- **Part 5:** 1,000 sessions normalise to 3,500 ordered page views, feeding 18 native pivots and
  9 charts. The main business issue is inconsistent monetary/conversion data, including
  235 non-purchases with positive value and 200 purchases with zero value.

## Repository layout

~~~text
parts/
  01-02-data-pipeline/   SQL, shared Python and loader notebooks
  03-power-bi/           PBIX, PBIP/PBIR/TMDL source and theme
  04-documentation/      report, ADRs, data dictionary and original brief
  05-google-sheets/      source/final workbooks, Apps Script and analysis document
~~~

## Reproducing Parts 1–2

Prerequisites are MySQL **8.0.19+**, Python **3.11+**, JupyterLab or Jupyter Notebook, and an
APILayer key. Copy [.env.example](.env.example) to `.env`, fill in the credentials, and install the
pinned runtime packages:

~~~powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:PYTHONPATH = (Resolve-Path "parts/01-02-data-pipeline")
jupyter lab parts/01-02-data-pipeline/notebooks
~~~

Run [project_1.sql](parts/01-02-data-pipeline/project_1.sql) first, then execute the notebooks in
this order: `dimensions` → `gdp_world_bank` → `population_world_bank` → `api`. The schema script
rebuilds GDP and population tables but preserves and upgrades the quota-backed FX history. Validate
the result with `SELECT * FROM vw_data_quality ORDER BY status, area;`.

## Scope and limitations

- `dim_country.local_currency` stores the **current** currency, not an effective-dated history;
  historical local-currency analysis must not treat it as a country-year mapping.
- Some selectable currencies have incomplete historical FX coverage. The report surfaces a warning
  rather than silently treating a partial annual average as complete.
- FX extends into 2026, but GDP and population stop at 2025; 2026 therefore has no economic indicator
  values.
- The loaders are still notebook-led. Production use needs CLI entry points, source-specific schedules,
  run logging, alerting and monitored Power BI refreshes.

## Security

`.env` contains the API key and database password and is intentionally excluded from version control.
Only [.env.example](.env.example) belongs in the repository.
