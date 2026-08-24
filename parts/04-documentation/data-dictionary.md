# Data dictionary

Schema `analyst_test`, MySQL 8.0.45, InnoDB, `utf8mb4_0900_ai_ci`.
Types and constraints reflect the DDL; row counts and coverage are the **2026-08-23 snapshot**.

Full DDL lives in [`project_1.sql`](../01-02-data-pipeline/project_1.sql). Design reasoning is in
[`decisions.md`](decisions.md).

```
dim_currency ──┬─< exchange_rates >─┐
               │                    │
               └─< dim_country ──┬──┴─< gdp
                                 └────< population
```

---

## Base tables

### `dim_currency` — 172 rows

Currency reference. Exists so the report can tell a tradeable currency from a metal, a crypto
ticker or a code that stopped existing in 2015.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `currency_code` | `CHAR(3)` | PK | ISO 4217 alpha-3. A case-sensitive `REGEXP_LIKE` check enforces `^[A-Z]{3}$`. |
| `currency_name` | `VARCHAR(60)` | | Display name. |
| `is_fiat` | `TINYINT(1)` | | 0 for metals (`XAU`, `XAG`), crypto (`BTC`) and units of account (`XDR`, `CLF`). |
| `is_active` | `TINYINT(1)` | | 0 for retired codes such as `HRK`, `SLL`, `ZWL`. |
| `is_iso_4217` | `TINYINT(1)` | | 0 for provider-specific codes that are not in the standard (e.g. `CNH`). |
| `minor_units` | `TINYINT UNSIGNED` | | ISO 4217 exponent, 0–8. `CHECK` caps at 8. NULL where not applicable. |
| `replaced_by` | `CHAR(3)` | FK → self | Successor code. `CHECK` prevents self-reference. |
| `is_selectable` | `TINYINT(1)` | generated | `is_fiat AND is_active`. The Power BI currency slicer filters on this — 156 of 172 pass. |
| `created_at` / `updated_at` | `TIMESTAMP` | | Audit. `updated_at` is `ON UPDATE CURRENT_TIMESTAMP`. |

**Source:** seeded in [project_1.sql](../01-02-data-pipeline/project_1.sql), cross-checked against the
currency list returned by the FX provider.

---

### `dim_country` — 217 rows

Country reference and the country → currency bridge.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `country_iso3` | `CHAR(3)` | PK | ISO 3166-1 alpha-3. The join key for both fact tables. A case-sensitive `REGEXP_LIKE` check enforces `^[A-Z]{3}$`. |
| `country_name` | `VARCHAR(100)` | UNIQUE | World Bank display name. **Non-standard for 43 of 217** — `Egypt, Arab Rep.`, `Korea, Rep.`. Display and geocoding only; never a join key. See [ADR-001](decisions.md#adr-001). |
| `region` | `VARCHAR(60)` | | World Bank region, 7 values. Aggregate rows ("World", "Euro area") are filtered out at load. |
| `income_group` | `VARCHAR(60)` | | World Bank income classification, 4 values. |
| `local_currency` | `CHAR(3)` | FK → `dim_currency` | Current local currency, not an effective-dated history. NULL for `SSD` because SSP is not quoted by the provider. Drives `GDP (Local Currency)` only in one-country context. |
| `created_at` / `updated_at` | `TIMESTAMP` | | Audit. |

**Source:** World Bank `/country` endpoint via `etl.fetch_worldbank_countries()` and
[dimensions.ipynb](../01-02-data-pipeline/notebooks/dimensions.ipynb).

---

### `exchange_rates` — 408,928 rows / ~19.5 MB

Daily rates, one row per date and currency pair. The only large table in the schema.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `date` | `DATE` | PK 1 | Quote date. Range 2020-01-01 → 2026-08-23, 2,427 distinct days. |
| `base_currency` | `CHAR(3)` | PK 2, FK | Always `USD` in the loaded data. |
| `target_currency` | `CHAR(3)` | PK 3, FK | Quoted currency, 172 distinct. |
| `rate` | `DECIMAL(20,10)` | | Units of target per 1 base. `DECIMAL` not `DOUBLE` — see [ADR-002](decisions.md#adr-002). `CHECK rate > 0`. |
| `rate_year` | `SMALLINT UNSIGNED` | generated | `YEAR(date)`, `STORED`. Exists to make the annual aggregate indexable — see [ADR-003](decisions.md#adr-003). |
| `created_at` / `updated_at` | `TIMESTAMP` | | Audit. |

**Indexes**

| Index | Columns | Purpose |
| --- | --- | --- |
| `PRIMARY` | `date, base_currency, target_currency` | Natural key. Target of the idempotent upsert. |
| `ix_fx_currency_year` | `target_currency, rate_year, rate` | **Covering** index for the annual average. |
| `fk_fx_base` | `base_currency` | Auto-created by InnoDB for the FK. Redundant in practice — the column is always `USD`. |

**Source:** APILayer `exchangerates_data/timeseries` via
[api.ipynb](../01-02-data-pipeline/notebooks/api.ipynb).

---

### `gdp` — 1,219 rows

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `id` | `INT UNSIGNED` | PK, auto | Surrogate. The brief asks for it. |
| `year` | `YEAR` | UNIQUE 1 | MySQL's dedicated 1-byte year type. 2020–2025. |
| `country` | `VARCHAR(100)` | | Country name as published. Kept because the brief lists it; nothing joins on it. |
| `country_iso3` | `CHAR(3)` | UNIQUE 2, FK | The actual join key. |
| `gdp_in_usd` | `DECIMAL(20,2)` | | Nominal GDP, current US dollars. `CHECK > 0`. |
| `created_at` / `updated_at` | `TIMESTAMP` | | Audit. |

`UNIQUE (year, country_iso3)` — one observation per country-year, and the target of the upsert.

**Source:** World Bank indicator
[`NY.GDP.MKTP.CD`](https://data.worldbank.org/indicator/NY.GDP.MKTP.CD), loaded by
[gdp_world_bank.ipynb](../01-02-data-pipeline/notebooks/gdp_world_bank.ipynb).

**Coverage:** ragged — 210 countries in 2020 falling to 186 in 2025. See
[`vw_data_quality`](#vw_data_quality--11-rows).

---

### `population` — 1,302 rows

Same shape as `gdp`.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `id` | `INT UNSIGNED` | PK, auto | Surrogate. |
| `year` | `YEAR` | UNIQUE 1 | 2020–2025. |
| `country` | `VARCHAR(100)` | | As published. |
| `country_iso3` | `CHAR(3)` | UNIQUE 2, FK | Join key. |
| `population` | `BIGINT UNSIGNED` | | Overflows `INT` for China and India. `CHECK > 0`. |
| `created_at` / `updated_at` | `TIMESTAMP` | | Audit. |

**Source:** World Bank indicator
[`SP.POP.TOTL`](https://data.worldbank.org/indicator/SP.POP.TOTL), loaded by
[population_world_bank.ipynb](../01-02-data-pipeline/notebooks/population_world_bank.ipynb).

**Coverage:** complete 217 × 6 grid. `GDP Coverage %` compares available GDP country-year pairs
with this population grid in the active filter context.

---

## Views

Business logic lives here rather than in Power Query, so it is readable and diffable, and so any
other consumer of the database gets the same definitions. See [ADR-005](decisions.md#adr-005).

### `fact_fx_annual` — 1,185 rows

Annual rollup of `exchange_rates`. **This is what Power BI imports** — 345× fewer rows than the
daily table for the same annual information.

| Column | Type | Description |
| --- | --- | --- |
| `year` | `SMALLINT UNSIGNED` | From `rate_year`. |
| `base_currency` / `target_currency` | `CHAR(3)` | The pair. |
| `avg_rate` | `DECIMAL(24,14)` | Calendar-day mean. **Use for flows** (GDP, trade). |
| `eoy_rate` | `DECIMAL(20,10)` | Last quote of the year. **Use for stocks** (debt, reserves). |
| `min_rate` / `max_rate` | `DECIMAL(20,10)` | Annual range. |
| `obs_count` | `BIGINT` | Days actually quoted. |
| `days_in_year` | `INT` | 365 or 366 for the calendar year. The current year is therefore expected to be partial. |
| `coverage_pct` | `DECIMAL(24,4)` | `obs_count / days_in_year`. |
| `first_date` / `last_date` | `DATE` | Observed range within the year. |
| `is_partial_year` | `INT` | 1 when `coverage_pct` < 95%. Read this before trusting a converted figure. |

### `fx_rate_outliers` — 194 rows

Every daily rate that disagrees with its own centred 31-day moving average by more than 2× or less
than 0.5×. 0.047% of the table, across 15 currencies. Rows are **flagged, never deleted** — see
[ADR-006](decisions.md#adr-006).

| Column | Type | Description |
| --- | --- | --- |
| `date` | `DATE` | Quote date. |
| `year` | `SMALLINT UNSIGNED` | Convenience for slicing. |
| `base_currency` / `target_currency` | `CHAR(3)` | The pair. |
| `rate` | `DECIMAL(20,10)` | The suspect value. |
| `local_avg_31d` | `DECIMAL(17,6)` | Centred 31-day mean around that date. |
| `ratio_to_local_avg` | `DECIMAL(29,4)` | `rate / local_avg_31d`. Above 2 or below 0.5 by construction. |

### `vw_data_quality` — 11 rows

The dataset's test suite. One row per check.

| Column | Type | Description |
| --- | --- | --- |
| `status` | `VARCHAR(4)` | `WARN` (5 rows) or `INFO` (6 rows) in the 2026-08-23 snapshot. |
| `area` | `VARCHAR(10)` | `FX`, `GDP`, `POPULATION`, `DIM`. |
| `check_name` | `VARCHAR(53)` | What was checked. |
| `metric` | `BIGINT` | The count. **Never sum this column** — see `unit`. |
| `unit` | `VARCHAR(23)` | What `metric` counts: rows, currencies, countries, country-years. Different per row. |
| `detail` | `TEXT` | The offending keys, comma-separated, where listing them is useful. |

### `vw_gdp_per_capita` — 1,219 rows

SQL-side cross-check for the `GDP per Capita (USD)` measure. **Deliberately not imported** into
Power BI — importing it would give one indicator two sources of truth.

| Column | Type | Description |
| --- | --- | --- |
| `year` | `YEAR` | |
| `country_iso3` | `CHAR(3)` | |
| `country_name` | `VARCHAR(100)` | |
| `region` | `VARCHAR(60)` | |
| `gdp_in_usd` | `DECIMAL(20,2)` | |
| `population` | `BIGINT UNSIGNED` | |
| `gdp_per_capita_usd` | `DECIMAL(21,2)` | `gdp_in_usd / population`. |

### `dim_year` — 7 rows

Year dimension, built from the union of years present in `gdp`, `population` and `exchange_rates`
so it never disagrees with the facts. In 2026 it reports FX coverage but zero GDP and population.

| Column | Type | Description |
| --- | --- | --- |
| `year` | `BIGINT UNSIGNED` | 2020–2026. |
| `is_current_year` | `INT` | 1 for the year in progress. |
| `gdp_countries` | `BIGINT` | Countries with a GDP figure that year. |
| `population_countries` | `BIGINT` | Countries with a population figure that year. |
| `fx_currencies` | `BIGINT` | Currencies quoted that year. |

---

## Constraints at a glance

| Type | Count | Where |
| --- | --- | --- |
| Primary keys | 5 | one per base table |
| Foreign keys | 6 | `gdp`, `population` → `dim_country`; `exchange_rates` ×2 → `dim_currency`; `dim_country.local_currency` → `dim_currency`; `dim_currency.replaced_by` → self |
| Unique keys | 3 | `dim_country.country_name`, `gdp(year, country_iso3)`, `population(year, country_iso3)` |
| Check constraints | 7 | `rate > 0`, `gdp_in_usd > 0`, `population > 0`, two `^[A-Z]{3}$` patterns, `minor_units <= 8`, `replaced_by <> currency_code` |
| Generated columns | 2 | `exchange_rates.rate_year`, `dim_currency.is_selectable` |

Five foreign keys use `ON UPDATE CASCADE`. The self-reference
`dim_currency.replaced_by → dim_currency.currency_code` deliberately has no referential action,
because MySQL does not allow the required check constraint together with that cascade.
