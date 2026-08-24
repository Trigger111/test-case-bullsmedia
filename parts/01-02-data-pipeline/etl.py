"""
Shared ETL helpers for the Bulls Media analyst test task.

The three loader notebooks (api, gdp_world_bank, population_world_bank) used to
carry their own copy of the same connection code, the same .env check and the
same bare requests.get call. That duplication is what this module removes, and
it is also where the two real reliability fixes live:

  * request_json()   retries on 429 and 5xx with exponential backoff, instead
                     of dying on the first rate-limit response.
  * missing_dates()  finds gaps anywhere in the loaded history, instead of
                     resuming from MAX(date) and skipping holes for good.

Importable from a notebook or runnable from cron - nothing here needs Jupyter.
"""

import os
from datetime import date, timedelta

import mysql.connector
import requests
from dotenv import load_dotenv
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


# ============================================================
# CONFIGURATION
# ============================================================

WORLD_BANK_API = "https://api.worldbank.org/v2"

REQUIRED_ENV = [
    "MYSQL_HOST",
    "MYSQL_USER",
    "MYSQL_PASSWORD",
    "MYSQL_DATABASE",
]

# APILayer's free tier is rate limited, and the World Bank occasionally
# returns a 502. Both are transient, so both are worth retrying.
RETRY_STATUS = (429, 500, 502, 503, 504)
RETRY_ATTEMPTS = 5
RETRY_BACKOFF = 2          # seconds: 2, 4, 8, 16, 32

# executemany() is fast, but a single statement carrying 60,000 rows can
# exceed max_allowed_packet. Chunking keeps each statement well inside it.
LOAD_BATCH_SIZE = 10_000


# ============================================================
# ENVIRONMENT
# ============================================================

def load_config(extra_keys=()):
    """
    Read .env and fail early if anything required is missing.

    Returns the values as a dict. Nothing is printed, so a credential can
    never end up in notebook output.
    """
    load_dotenv()

    keys = list(REQUIRED_ENV) + list(extra_keys)
    missing = [key for key in keys if not os.getenv(key)]

    if missing:
        raise RuntimeError("Missing variables in .env: " + ", ".join(missing))

    return {key: os.getenv(key) for key in keys}


def connect_mysql():
    """Open a MySQL connection using the credentials in .env."""
    load_config()

    return mysql.connector.connect(
        host=os.getenv("MYSQL_HOST"),
        user=os.getenv("MYSQL_USER"),
        password=os.getenv("MYSQL_PASSWORD"),
        database=os.getenv("MYSQL_DATABASE"),
    )


# ============================================================
# HTTP
# ============================================================

def make_session():
    """
    Build a requests session that retries transient failures.

    respect_retry_after_header means a 429 carrying Retry-After is honoured
    exactly, rather than guessed at. Without this the exchange-rate backfill
    dies partway through as soon as the free-tier quota throttles.
    """
    retry = Retry(
        total=RETRY_ATTEMPTS,
        backoff_factor=RETRY_BACKOFF,
        status_forcelist=RETRY_STATUS,
        allowed_methods=frozenset(["GET"]),
        respect_retry_after_header=True,
        raise_on_status=False,
    )

    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=retry))

    return session


def request_json(session, url, params=None, headers=None, timeout=60):
    """GET a URL and return parsed JSON, raising on any non-2xx response."""
    response = session.get(url, params=params, headers=headers, timeout=timeout)
    response.raise_for_status()

    return response.json()


# ============================================================
# LOAD
# ============================================================

def upsert(connection, query, rows, batch_size=LOAD_BATCH_SIZE):
    """
    Run an INSERT ... ON DUPLICATE KEY UPDATE over rows, in batches.

    `executemany()` is chunked to keep statements manageable, but the whole
    call is one transaction. This matters for the FX loader: committing a
    partial API window can leave a date with only some currencies, while the
    date-level gap detector would regard that date as present on the next run.

    Returns the number of rows sent.
    """
    if not rows:
        return 0

    cursor = connection.cursor()
    sent = 0

    try:
        for start in range(0, len(rows), batch_size):
            batch = rows[start:start + batch_size]
            cursor.executemany(query, batch)
            sent += len(batch)
        connection.commit()
    except Exception:
        # No partial API window is left behind.
        connection.rollback()
        raise
    finally:
        cursor.close()

    return sent


# ============================================================
# INCREMENTAL LOAD WINDOWS
# ============================================================

def missing_dates(connection, table, start_date, end_date, date_column="date"):
    """
    Return every date in [start_date, end_date] that `table` has no row for.

    This replaces the "resume from MAX(date) + 1 day" logic. That version had a
    real bug: if a batch in the middle of the backfill failed, MAX(date) had
    already moved past the hole, so the missing days were never requested
    again. Diffing against the expected calendar finds gaps wherever they are.
    """
    cursor = connection.cursor()

    try:
        cursor.execute(
            f"SELECT DISTINCT `{date_column}` FROM `{table}` "
            f"WHERE `{date_column}` BETWEEN %s AND %s",
            (start_date, end_date),
        )
        loaded = {row[0] for row in cursor.fetchall()}
    finally:
        cursor.close()

    span = (end_date - start_date).days + 1

    return [
        day
        for day in (start_date + timedelta(days=offset) for offset in range(span))
        if day not in loaded
    ]


def to_windows(dates, max_span_days):
    """
    Collapse a sorted list of dates into contiguous (start, end) windows,
    splitting any run longer than max_span_days.

    One API call per window, so a fresh backfill produces a handful of
    year-long windows while a daily top-up produces exactly one short window.
    """
    if not dates:
        return []

    windows = []
    window_start = previous = dates[0]

    for day in dates[1:]:
        is_contiguous = (day - previous).days == 1
        fits_in_window = (day - window_start).days < max_span_days

        if is_contiguous and fits_in_window:
            previous = day
            continue

        windows.append((window_start, previous))
        window_start = previous = day

    windows.append((window_start, previous))

    return windows


# ============================================================
# WORLD BANK
# ============================================================

def fetch_worldbank_countries(session):
    """
    Return the World Bank's real countries and economies.

    Rows whose region is missing or reads "Aggregates" are groupings such as
    World, "Euro area" or "Upper middle income". Leaving them in would put
    "World" at the top of every GDP chart.
    """
    payload = request_json(
        session,
        f"{WORLD_BANK_API}/country",
        params={"format": "json", "per_page": 500},
        timeout=30,
    )

    if len(payload) < 2 or payload[1] is None:
        raise RuntimeError("World Bank country metadata was not returned.")

    return [
        row
        for row in payload[1]
        if (row.get("region") or {}).get("id")
        and (row.get("region") or {}).get("value") != "Aggregates"
    ]


def fetch_worldbank_indicator(session, indicator, start_year, end_year):
    """Return the raw observations for one indicator over a year range."""
    payload = request_json(
        session,
        f"{WORLD_BANK_API}/country/all/indicator/{indicator}",
        params={
            "date": f"{start_year}:{end_year}",
            "format": "json",
            "per_page": 20000,
        },
    )

    if len(payload) < 2 or payload[1] is None:
        raise RuntimeError(f"World Bank returned no observations for {indicator}.")

    return payload[1]


def transform_indicator(api_rows, valid_iso3, cast):
    """
    Turn World Bank observations into (year, country, country_iso3, value) rows.

    Two things get dropped, and both are counted rather than hidden:
      * economies outside valid_iso3 (aggregates, or codes with no dim_country row)
      * observations the World Bank has not published yet, where value is null

    `cast` converts the raw number - Decimal for money, int for people.
    """
    rows = []
    skipped_null = 0
    skipped_unknown = 0

    for row in api_rows:
        iso3 = row.get("countryiso3code")
        value = row.get("value")

        if iso3 not in valid_iso3:
            skipped_unknown += 1
            continue

        if value is None:
            skipped_null += 1
            continue

        rows.append((int(row["date"]), row["country"]["value"], iso3, cast(value)))

    return rows, skipped_null, skipped_unknown


def load_country_keys(connection):
    """
    Return the ISO3 codes present in dim_country.

    The loaders filter against this rather than against the API's own country
    list, so a row can never violate fk_gdp_country / fk_population_country.
    """
    cursor = connection.cursor()

    try:
        cursor.execute("SELECT country_iso3 FROM dim_country")
        return {row[0] for row in cursor.fetchall()}
    finally:
        cursor.close()


def load_currency_keys(connection):
    """
    Return the currency codes present in dim_currency.

    exchange_rates now carries a foreign key to dim_currency, which is
    protective but has an operational consequence: the day APILayer starts
    quoting a new code, an unfiltered insert fails on the constraint. The FX
    loader checks against this set first so it can name the new currency
    instead of surfacing a raw FK error.
    """
    cursor = connection.cursor()

    try:
        cursor.execute("SELECT currency_code FROM dim_currency")
        return {row[0] for row in cursor.fetchall()}
    finally:
        cursor.close()


def print_rows(connection, sql):
    """Run a validation query and print its rows - used for the load summaries."""
    cursor = connection.cursor()

    try:
        cursor.execute(sql)
        for row in cursor.fetchall():
            print("  ", row)
    finally:
        cursor.close()
