/**
 * Bulls Media — Test task for analyst V3, Part 5
 * Normalisation and data-quality audit of `ecommerce_website_data` in Google Apps Script.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SOURCE LOOKS LIKE
 * ---------------------------------------------------------------------------
 * `raw_data` is one row per session, but it hides two different problems.
 *
 * (a) Three columns keep parallel arrays inside a single cell:
 *       Browsing Path    ['P2', 'P3', 'CT']
 *       Page Interaction [{"Clicks": 6, "Scrolls": 5}, {"Clicks": 8, "Scrolls": 6}, ...]
 *       Time per Page    [36, 93, 108]
 *     The i-th element of each array describes the same page view — this is the positional link
 *     the brief calls out — so the true grain of that data is the PAGE VIEW, not the session.
 *
 * (b) The scalar columns are dirty in a way that array-splitting never touches:
 *       Traffic Source   8 distinct values mapped to 4 canonical channels (Organic Search / Organic,
 *                        Paid Ads / PaidAds, Email / email)
 *       Device Type      8 distinct values mapped to 3 canonical devices (Mobile / M, Tablet / tablet / T,
 *                        Desktop / D)
 *       Country + City   disagree with the supplied lookup on most rows
 *       Purchase Value   conflicts with Conversion Event in both directions
 *
 * Splitting (a) without cleaning (b) would fragment channel and device categories in downstream
 * pivots. This script handles both layers.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PRODUCES — five tabs, all rebuilt from scratch on every run
 * ---------------------------------------------------------------------------
 *   sessions      1 row per session      cleaned attributes, visitor type, aggregates, DQ flags
 *   page_views    1 row per page view    the exploded arrays, grain = session x position
 *   dim_page      1 row per page code    the page dictionary that stamps both fact tables
 *   dim_lookup    1 row per mapping      every raw value -> canonical value, with rows affected
 *   qa_report     the audit              reconciliation, measured ranges, findings, self-test
 *
 * ---------------------------------------------------------------------------
 * DESIGN DECISIONS
 * ---------------------------------------------------------------------------
 *  1. Idempotent. Every output tab is rebuilt from `raw_data`, so re-running does not duplicate
 *     rows and restores a complete output after a failed run. The tabs are written sequentially,
 *     not transactionally; `raw_data` itself is only ever read, never modified.
 *  2. Read by header NAME, never by column letter — the script survives a reordered export.
 *  3. Explicit mapping assumptions are documented in `dim_lookup`. Values outside a mapping are
 *     kept verbatim and reported; contradictions between fields are flagged, not "corrected".
 *  4. Collect, don't abort. Every anomaly lands in `qa_report` with its source row, so the audit
 *     answers "how much is wrong", not just "something is wrong".
 *  5. Flags live on the fact row, not only in the report. `sessions` carries DQ Flags / DQ Severity
 *     / DQ Issues, so findings can be filtered and pivoted instead of read as a log. The report
 *     therefore samples detail rows (CONFIG.MAX_DETAIL_ROWS_PER_CHECK) and always states the full
 *     count next to the sample.
 *  6. Deliberate denormalisation. `page_views` repeats the cleaned session attributes (channel,
 *     device, country, conversion). Sheets pivot tables cannot join, so without this every funnel
 *     pivot would require helper lookup columns.
 *  7. Fact tables use bulk range reads/writes and avoid per-cell writes inside large data loops.
 *  8. Every vocabulary is a constant at the top AND is written to `dim_lookup`, so the mapping is
 *     readable without opening the script editor.
 *  9. Pure parsing and cleaning functions are checked by runSelfTest_() on every run, with the
 *     results printed into `qa_report` for review.
 *
 * HOW TO RUN: menu "Bulls Media" -> "Rebuild all", or run rebuildAll() from the editor.
 */

// ---------------------------------------------------------------------------
// CONFIG — operational settings; normalisation vocabularies are declared in the lookup section.
// ---------------------------------------------------------------------------
const CONFIG = {
  // A fresh copy keeps the export name; all three are accepted before falling back to a scan.
  RAW_SHEET_CANDIDATES: ['raw_data', 'ecommerce_website_data.csv', 'Sheet1'],

  SESSIONS_SHEET: 'sessions',
  PAGE_VIEWS_SHEET: 'page_views',
  DIM_PAGE_SHEET: 'dim_page',
  DIM_LOOKUP_SHEET: 'dim_lookup',
  QA_SHEET: 'qa_report',

  // Output tabs produced by earlier versions of this script. Removed on rebuild so the workbook
  // never shows two audits disagreeing with each other. Guarded — see dropLegacySheets_().
  LEGACY_SHEETS: ['qa_page_views'],

  // Sanity bounds for the QA pass. Deliberately wider than the observed data; they flag values
  // outside configured plausibility ranges rather than asserting physical impossibility.
  MAX_PATH_LENGTH: 6,
  MIN_TIME_ON_PAGE: 1,
  MAX_TIME_ON_PAGE: 600,
  MAX_PURCHASE_VALUE: 100000,

  // The audit log is a sample per check; the summary always carries the full count.
  MAX_DETAIL_ROWS_PER_CHECK: 50,

  DATETIME_FORMAT: 'yyyy-mm-dd hh:mm:ss',
  DATE_FORMAT: 'yyyy-mm-dd',
  MONEY_FORMAT: '#,##0.00',
};

// Raw column headers, referenced by name everywhere below.
const COL = {
  TS: 'Timestamp',
  USER: 'User ID',
  SESSION: 'Session ID',
  SOURCE: 'Traffic Source',
  DEVICE: 'Device Type',
  COUNTRY: 'Country',
  CITY: 'City',
  PATH: 'Browsing Path',
  INTERACTION: 'Page Interaction',
  TIME: 'Time per Page',
  CART: 'Cart Changes',
  CONVERSION: 'Conversion Event',
  VALUE: 'Purchase Value',
};

// Without these four the model cannot be built at all. The remaining columns are reported as
// missing and treated as blank, so a partial export still yields a usable page_views table.
const REQUIRED_COLUMNS = [COL.SESSION, COL.PATH, COL.INTERACTION, COL.TIME];

// ---------------------------------------------------------------------------
// LOOKUPS — the whole normalisation vocabulary, in one place and mirrored to dim_lookup.
// ---------------------------------------------------------------------------

/**
 * Page dictionary. `stage` provides a reporting order in pivots; it does not assert that each
 * session follows a canonical funnel. `type` collapses the four product pages into one bucket.
 */
const PAGE_META = {
  LP: { name: 'Landing page', type: 'Landing', stage: '1. Landing', sort: 1 },
  P1: { name: 'Product page 1', type: 'Product', stage: '2. Product', sort: 2 },
  P2: { name: 'Product page 2', type: 'Product', stage: '2. Product', sort: 3 },
  P3: { name: 'Product page 3', type: 'Product', stage: '2. Product', sort: 4 },
  P4: { name: 'Product page 4', type: 'Product', stage: '2. Product', sort: 5 },
  CT: { name: 'Cart', type: 'Cart', stage: '3. Cart', sort: 6 },
};

/**
 * Traffic source: folded raw value -> canonical channel. Folding is lowercase + removal of spaces,
 * underscores and hyphens, so "Paid Ads", "PaidAds" and "paid_ads" all arrive as "paidads".
 * This implementation treats "Organic" and "Organic Search" as one channel; the assumption is
 * exposed in `dim_lookup`. Anything not listed is kept verbatim and reported as unmapped.
 */
const SOURCE_MAP = {
  organicsearch: 'Organic Search',
  organic: 'Organic Search',
  paidads: 'Paid Ads',
  paid: 'Paid Ads',
  direct: 'Direct',
  email: 'Email',
};

/** Device type: same folding, plus the single-letter abbreviations the export mixes in. */
const DEVICE_MAP = {
  mobile: 'Mobile',
  m: 'Mobile',
  tablet: 'Tablet',
  t: 'Tablet',
  desktop: 'Desktop',
  d: 'Desktop',
};

/**
 * Working City -> Country lookup used only for QA, never to overwrite a source field. A mismatch is
 * heuristic because place names can be ambiguous and the export provides no authoritative field.
 */
const CITY_COUNTRY = {
  'new york': 'USA',
  london: 'UK',
  sydney: 'Australia',
  toronto: 'Canada',
  berlin: 'Germany',
};

/** Closed vocabularies. A value outside the list is reported rather than silently accepted. */
const CONVERSION_VALUES = ['No Conversion', 'Added to Cart', 'Purchased'];
const CART_CHANGE_VALUES = ['Add', 'Remove'];

/**
 * A blank `Cart Changes` cell is read as "no cart interaction in this session".
 * ASSUMPTION, recorded as one: the export gives no way to tell "nothing happened" from "the value
 * was lost". Every affected row is flagged at info level so the reader can re-decide, and the raw
 * blank is preserved in the raw column.
 */
const CART_CHANGE_BLANK = 'No Change';

const EXIT_LABEL = '(exit)';
const ENTRY_LABEL = '(entry)';
const UNMAPPED = '(unmapped)';

// ---------------------------------------------------------------------------
// CHECK REGISTRY — severity and meaning live with the check, so the report explains itself.
// severity: error   = critical key, parsing, vocabulary, or metric issue; a row/field may be excluded
//           warning = retained record requiring semantic or plausibility review
//           info    = normalisation performed or documented assumption applied
// `flag` is the short code stamped onto the session row; '' means the finding is not row-level.
// ---------------------------------------------------------------------------
const CHECKS = {
  BLANK_ROW:            { severity: 'info',    flag: '',                    desc: 'Row is completely empty — skipped.' },
  MISSING_SESSION_ID:   { severity: 'error',   flag: '',                    desc: 'Row has no Session ID and cannot be keyed — skipped.' },
  DUPLICATE_SESSION_ID: { severity: 'error',   flag: 'DUP_SESSION',         desc: 'Session ID already seen on an earlier row.' },
  MISSING_ARRAY:        { severity: 'error',   flag: '',                    desc: 'One of the three array columns is empty, so the session has no clickstream — session skipped.' },
  UNPARSABLE_ARRAY:     { severity: 'error',   flag: '',                    desc: 'One of the three array columns holds a value that is not a list — session skipped.' },
  LENGTH_MISMATCH:      { severity: 'error',   flag: '',                    desc: 'The three arrays differ in length, so the positional link is undefined — session skipped.' },
  EMPTY_PATH:           { severity: 'warning', flag: 'EMPTY_PATH',          desc: 'Browsing Path is an empty list — the session has no page views.' },
  PATH_TOO_LONG:        { severity: 'warning', flag: 'PATH_TOO_LONG',       desc: 'Path is longer than MAX_PATH_LENGTH — kept, but worth checking upstream.' },
  PAGE_REPEATED:        { severity: 'info',    flag: 'PAGE_REPEATED',       desc: 'A page code repeats within one path; retained for review.' },
  UNKNOWN_PAGE_CODE:    { severity: 'error',   flag: 'UNKNOWN_PAGE',        desc: 'Page code is not in the page dictionary.' },
  MISSING_METRIC:       { severity: 'error',   flag: 'BAD_INTERACTION',     desc: 'Clicks or Scrolls missing or non-numeric for a page view.' },
  BAD_TIME:             { severity: 'error',   flag: 'BAD_TIME',            desc: 'Time per page is non-numeric.' },
  TIME_OUT_OF_BOUNDS:   { severity: 'warning', flag: 'TIME_OUT_OF_BOUNDS',  desc: 'Time per page is outside the plausible range.' },
  MISSING_TIMESTAMP:    { severity: 'error',   flag: 'NO_TIMESTAMP',        desc: 'Timestamp is missing or unparsable.' },
  MISSING_USER_ID:      { severity: 'warning', flag: 'NO_USER',             desc: 'User ID is missing, so the session cannot be attributed to a visitor.' },
  SOURCE_NORMALISED:    { severity: 'info',    flag: 'SRC_NORMALISED',      desc: 'Traffic Source was a spelling variant and was folded to the canonical channel.' },
  SOURCE_UNMAPPED:      { severity: 'error',   flag: 'SRC_UNMAPPED',        desc: 'Traffic Source is not in the channel vocabulary — kept verbatim.' },
  DEVICE_NORMALISED:    { severity: 'info',    flag: 'DEV_NORMALISED',      desc: 'Device Type was an abbreviation or case variant and was folded to the canonical device.' },
  DEVICE_UNMAPPED:      { severity: 'error',   flag: 'DEV_UNMAPPED',        desc: 'Device Type is not in the device vocabulary — kept verbatim.' },
  UNKNOWN_CITY:         { severity: 'warning', flag: 'CITY_UNKNOWN',        desc: 'City is not in the city dictionary, so its country cannot be checked.' },
  GEO_INCONSISTENT:     { severity: 'warning', flag: 'GEO_INCONSISTENT',    desc: 'Country does not match the working city-country lookup. Neither source field is overwritten.' },
  USER_MULTI_COUNTRY:   { severity: 'warning', flag: 'USER_MULTI_COUNTRY',  desc: 'The same User ID appears in more than one country.' },
  UNKNOWN_CONVERSION:   { severity: 'error',   flag: 'CONV_UNKNOWN',        desc: 'Conversion Event is outside the closed vocabulary.' },
  UNKNOWN_CART_CHANGE:  { severity: 'error',   flag: 'CART_UNKNOWN',        desc: 'Cart Changes is outside the closed vocabulary.' },
  CART_CHANGE_BLANK:    { severity: 'info',    flag: 'CART_BLANK',          desc: 'Cart Changes is blank; read as "no cart interaction" (documented assumption).' },
  PURCHASE_NO_VALUE:    { severity: 'warning', flag: 'PURCHASE_NO_VALUE',   desc: 'Conversion Event is Purchased but Purchase Value is zero.' },
  VALUE_NO_PURCHASE:    { severity: 'warning', flag: 'VALUE_NO_PURCHASE',   desc: 'Purchase Value is above zero on a session not marked Purchased.' },
  NEGATIVE_VALUE:       { severity: 'error',   flag: 'NEGATIVE_VALUE',      desc: 'Purchase Value is negative.' },
  VALUE_OUT_OF_BOUNDS:  { severity: 'warning', flag: 'VALUE_OUT_OF_BOUNDS', desc: 'Purchase Value is above the configured review threshold.' },
  PURCHASE_NO_CART:     { severity: 'warning', flag: 'PURCHASE_NO_CART',    desc: 'Session is marked Purchased but the CT page code does not appear in Browsing Path.' },
  ADDTOCART_NO_CART:    { severity: 'warning', flag: 'ADDTOCART_NO_CART',   desc: 'Session is marked Added to Cart but the CT page code does not appear in Browsing Path.' },
  CART_CHANGE_NO_CART:  { severity: 'warning', flag: 'CART_CHANGE_NO_CART', desc: 'Cart Changes records an Add or Remove but the CT page code does not appear in Browsing Path.' },
};

const SEVERITIES = ['error', 'warning', 'info'];
const SEVERITY_RANK = { ok: 0, info: 1, warning: 2, error: 3 };

// ---------------------------------------------------------------------------
// MENU
// ---------------------------------------------------------------------------
/**
 * The whole project's menu lives here. Apps Script allows only one onOpen per project, so
 * analysis.gs deliberately does not define one — it only exposes the functions called below.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Bulls Media')
    .addItem('Rebuild everything (data + dashboard)', 'rebuildEverything')
    .addSeparator()
    .addItem('Rebuild data tabs only', 'rebuildAll')
    .addItem('Rebuild pivots & charts only', 'rebuildAnalysis')
    .addSeparator()
    .addItem('Validate only (no writes)', 'validateOnly')
    .addItem('Run self-test', 'showSelfTest')
    .addToUi();
}

/**
 * Full rebuild in dependency order: the analysis layer reads `sessions` and `page_views`, so the
 * data tabs must exist first. Guarded with typeof so this file still runs if analysis.gs
 * has not been pasted into the project yet.
 */
function rebuildEverything() {
  const data = rebuildAll();
  if (typeof rebuildAnalysis !== 'function') {
    return data + ' — analysis.gs is not in this project, so no pivots or charts were built.';
  }
  return data + ' | ' + rebuildAnalysis();
}

// ---------------------------------------------------------------------------
// ENTRY POINTS
// ---------------------------------------------------------------------------

/** Rebuilds every output tab from `raw_data`. Safe to run any number of times. */
function rebuildAll() {
  return run_(true);
}

/**
 * Parses and audits without touching the workbook — useful before a rebuild on a file someone else
 * has open, and it keeps the pure half of the pipeline runnable in isolation.
 */
function validateOnly() {
  return run_(false);
}

/** Backwards-compatible alias: earlier versions exposed this name to the menu and to triggers. */
function rebuildPageViews() {
  return rebuildAll();
}

function run_(write) {
  const started = new Date();
  const raw = readRaw_();
  const model = buildModel_(raw);
  const selfTest = runSelfTest_();

  if (write) {
    writeSessions_(model);
    writePageViews_(model);
    writeDimPage_();
    writeDimLookup_(model);
    writeQaReport_(raw, model, selfTest, started);
    dropLegacySheets_();
    SpreadsheetApp.flush();
  }

  const sev = model.counts.bySeverity;
  const msg = model.pageViews.length + ' page views from ' + model.sessions.length + ' sessions; ' +
    sev.error + ' errors, ' + sev.warning + ' warnings, ' + sev.info + ' info' +
    (selfTest.failed ? ' — SELF-TEST FAILED' : '');
  Logger.log(msg);
  try {
    SpreadsheetApp.getActive().toast(msg, write ? 'Rebuild complete' : 'Validation complete', 10);
  } catch (e) {
    // No UI context (time-driven trigger or direct API call) — the log line is the result.
  }
  return msg;
}

/** Runs the parser assertions and shows them, without rebuilding anything. */
function showSelfTest() {
  const result = runSelfTest_();
  const lines = result.rows.map(function (r) { return r[3] + '  ' + r[0]; }).join('\n');
  const header = result.failed
    ? result.failed + ' of ' + result.rows.length + ' FAILED'
    : 'all ' + result.rows.length + ' assertions passed';
  const ui = SpreadsheetApp.getUi();
  ui.alert('Self-test: ' + header, lines, ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// MODEL BUILD — the whole transformation, with no I/O in it beyond the record list it is given.
// ---------------------------------------------------------------------------

/**
 * Turns raw records into { sessions, pageViews, issues, counts, stats, tallies }.
 * Session objects are kept until the end because two checks (duplicate keys, one user in several
 * countries) can only be decided once every row has been seen.
 */
function buildModel_(raw) {
  const tz = getTimeZone_();
  const issues = [];
  const sessions = [];
  const pageViews = [];
  const seenSessions = {};          // sessionId -> first source row
  const userCountries = {};         // userId -> { country: true }

  // Raw-value tallies, used to build dim_lookup with real "rows affected" counts.
  const tallies = { source: {}, device: {}, city: {}, country: {}, conversion: {}, cart: {}, page: {} };

  // Running measurements, so the report can state the observed ranges without a chart.
  const stats = {
    clicks: newRange_(), scrolls: newRange_(), time: newRange_(),
    depth: newRange_(), purchase: newRange_(),
    firstTs: null, lastTs: null,
    expectedPageViews: 0,           // sum of path lengths
    expectedFromRegex: 0,           // the same total counted by a second, independent parser
    skipped: 0,
  };

  raw.records.forEach(function (rec) {
    const rowNo = rec.__row;
    const add = function (code, detail, session) {
      issues.push({ row: rowNo, session: session || '', code: code, detail: detail || '' });
    };

    const sessionId = str_(rec[COL.SESSION]);

    // -- row-level guards ---------------------------------------------------
    if (!sessionId && isBlankRecord_(rec, raw.headers)) {
      add('BLANK_ROW', 'row is completely empty');
      stats.skipped++;
      return;
    }
    if (!sessionId) {
      add('MISSING_SESSION_ID', 'row cannot be keyed — skipped');
      stats.skipped++;
      return;
    }

    // -- the three parallel arrays -----------------------------------------
    const path = parsePath_(rec[COL.PATH]);
    const interaction = parseJsonArray_(rec[COL.INTERACTION]);
    const times = parseJsonArray_(rec[COL.TIME]);

    if (path === null || interaction === null || times === null) {
      // "The cell is empty" and "the cell holds something that is not a list" are different
      // upstream failures — a dropped export column versus a corrupted value — so they are
      // reported as different checks instead of one catch-all.
      const state = function (parsed, colName) {
        return parsed ? 'ok' : (str_(rec[colName]) === '' ? 'EMPTY' : 'MALFORMED');
      };
      const detail = 'path=' + state(path, COL.PATH) +
        ', interaction=' + state(interaction, COL.INTERACTION) +
        ', time=' + state(times, COL.TIME) + ' — session skipped';
      const anyEmpty = !str_(rec[COL.PATH]) || !str_(rec[COL.INTERACTION]) || !str_(rec[COL.TIME]);
      add(anyEmpty ? 'MISSING_ARRAY' : 'UNPARSABLE_ARRAY', detail, sessionId);
      stats.skipped++;
      return;
    }
    // The brief states the three columns are positionally linked, so equal length is the contract.
    // If it is violated we cannot know which page a metric belongs to: skip, do not guess.
    if (path.length !== interaction.length || path.length !== times.length) {
      add('LENGTH_MISMATCH',
        'path=' + path.length + ', interaction=' + interaction.length + ', time=' + times.length,
        sessionId);
      stats.skipped++;
      return;
    }

    // -- build the session row ---------------------------------------------
    const s = {
      row: rowNo,
      sessionId: sessionId,
      flags: {},                      // flag code -> true, serialised at the end
    };

    if (seenSessions[sessionId]) {
      add('DUPLICATE_SESSION_ID', 'first seen on row ' + seenSessions[sessionId], sessionId);
      // Session ID is the output key. Keeping the second row would also create duplicate
      // Page View IDs, so report the source defect and exclude the ambiguous duplicate.
      stats.skipped++;
      return;
    } else {
      seenSessions[sessionId] = rowNo;
    }

    // Timestamp and its pivot-ready derivatives. Sheets groups dates awkwardly inside a pivot, so
    // date / month / weekday / hour are materialised here instead.
    s.timestamp = toDate_(rec[COL.TS]);
    if (!s.timestamp) {
      add('MISSING_TIMESTAMP', 'value = "' + str_(rec[COL.TS]) + '"', sessionId);
      flag_(s, 'MISSING_TIMESTAMP');
      s.date = ''; s.month = ''; s.weekday = ''; s.hour = '';
    } else {
      s.date = Utilities.formatDate(s.timestamp, tz, 'yyyy-MM-dd');
      s.month = Utilities.formatDate(s.timestamp, tz, 'yyyy-MM');
      s.weekday = weekdayLabel_(s.timestamp, tz);
      s.hour = Number(Utilities.formatDate(s.timestamp, tz, 'H'));
      if (!stats.firstTs || s.timestamp < stats.firstTs) stats.firstTs = s.timestamp;
      if (!stats.lastTs || s.timestamp > stats.lastTs) stats.lastTs = s.timestamp;
    }

    s.userId = toNumberOrNull_(rec[COL.USER]);
    if (s.userId === null) {
      s.userId = str_(rec[COL.USER]);           // keep a non-numeric id rather than dropping it
      if (s.userId === '') {
        add('MISSING_USER_ID', 'User ID is blank', sessionId);
        flag_(s, 'MISSING_USER_ID');
      }
    }

    // -- categorical cleaning ----------------------------------------------
    s.sourceRaw = str_(rec[COL.SOURCE]);
    const src = mapCategory_(s.sourceRaw, SOURCE_MAP);
    s.source = src.value;
    tally_(tallies.source, s.sourceRaw);
    if (src.status === 'unmapped') {
      add('SOURCE_UNMAPPED', '"' + s.sourceRaw + '" kept verbatim', sessionId);
      flag_(s, 'SOURCE_UNMAPPED');
    } else if (src.status === 'normalised') {
      add('SOURCE_NORMALISED', '"' + s.sourceRaw + '" -> "' + s.source + '"', sessionId);
      flag_(s, 'SOURCE_NORMALISED');
    }

    s.deviceRaw = str_(rec[COL.DEVICE]);
    const dev = mapCategory_(s.deviceRaw, DEVICE_MAP);
    s.device = dev.value;
    tally_(tallies.device, s.deviceRaw);
    if (dev.status === 'unmapped') {
      add('DEVICE_UNMAPPED', '"' + s.deviceRaw + '" kept verbatim', sessionId);
      flag_(s, 'DEVICE_UNMAPPED');
    } else if (dev.status === 'normalised') {
      add('DEVICE_NORMALISED', '"' + s.deviceRaw + '" -> "' + s.device + '"', sessionId);
      flag_(s, 'DEVICE_NORMALISED');
    }

    // -- geography: tested, never rewritten --------------------------------
    s.country = str_(rec[COL.COUNTRY]);
    s.city = str_(rec[COL.CITY]);
    tally_(tallies.country, s.country);
    tally_(tallies.city, s.city);
    s.cityCountry = CITY_COUNTRY[s.city.toLowerCase()] || '';
    if (s.city && !s.cityCountry) {
      add('UNKNOWN_CITY', '"' + s.city + '" is not in the city dictionary', sessionId);
      flag_(s, 'UNKNOWN_CITY');
      s.geoConsistent = '';
    } else if (!s.city || !s.country) {
      s.geoConsistent = '';
    } else {
      s.geoConsistent = (s.cityCountry === s.country);
      if (!s.geoConsistent) {
        add('GEO_INCONSISTENT', s.city + ' is in ' + s.cityCountry + ', not ' + s.country, sessionId);
        flag_(s, 'GEO_INCONSISTENT');
      }
    }
    if (s.userId !== '' && s.country) {
      if (!userCountries[s.userId]) userCountries[s.userId] = {};
      userCountries[s.userId][s.country] = true;
    }

    // -- cart + conversion + money -----------------------------------------
    s.cartChangeRaw = str_(rec[COL.CART]);
    tally_(tallies.cart, s.cartChangeRaw);
    if (s.cartChangeRaw === '') {
      s.cartChange = CART_CHANGE_BLANK;
      add('CART_CHANGE_BLANK', 'blank read as "' + CART_CHANGE_BLANK + '"', sessionId);
      flag_(s, 'CART_CHANGE_BLANK');
    } else if (CART_CHANGE_VALUES.indexOf(s.cartChangeRaw) === -1) {
      s.cartChange = s.cartChangeRaw;
      add('UNKNOWN_CART_CHANGE', '"' + s.cartChangeRaw + '"', sessionId);
      flag_(s, 'UNKNOWN_CART_CHANGE');
    } else {
      s.cartChange = s.cartChangeRaw;
    }

    s.conversion = str_(rec[COL.CONVERSION]);
    tally_(tallies.conversion, s.conversion);
    if (s.conversion && CONVERSION_VALUES.indexOf(s.conversion) === -1) {
      add('UNKNOWN_CONVERSION', '"' + s.conversion + '"', sessionId);
      flag_(s, 'UNKNOWN_CONVERSION');
    }

    s.purchaseValue = toNumberOrNull_(rec[COL.VALUE]);
    if (s.purchaseValue === null) s.purchaseValue = 0;
    s.hasRevenue = s.purchaseValue > 0;
    observe_(stats.purchase, s.purchaseValue);
    if (s.purchaseValue < 0) {
      add('NEGATIVE_VALUE', 'value = ' + s.purchaseValue, sessionId);
      flag_(s, 'NEGATIVE_VALUE');
    } else if (s.purchaseValue > CONFIG.MAX_PURCHASE_VALUE) {
      add('VALUE_OUT_OF_BOUNDS', 'value = ' + s.purchaseValue, sessionId);
      flag_(s, 'VALUE_OUT_OF_BOUNDS');
    }
    // Separate field-consistency checks: Purchased with zero value, and positive value on a
    // session not marked Purchased. Neither check decides which source field is authoritative.
    if (s.conversion === 'Purchased' && !s.hasRevenue) {
      add('PURCHASE_NO_VALUE', 'Purchased with Purchase Value = 0', sessionId);
      flag_(s, 'PURCHASE_NO_VALUE');
    }
    if (s.conversion !== 'Purchased' && s.hasRevenue) {
      add('VALUE_NO_PURCHASE', s.conversion + ' with Purchase Value = ' + s.purchaseValue, sessionId);
      flag_(s, 'VALUE_NO_PURCHASE');
    }

    // -- path-derived session metrics --------------------------------------
    const depth = path.length;
    s.pageCount = depth;
    observe_(stats.depth, depth);
    if (depth === 0) {
      add('EMPTY_PATH', 'session has no page views', sessionId);
      flag_(s, 'EMPTY_PATH');
    }
    if (depth > CONFIG.MAX_PATH_LENGTH) {
      add('PATH_TOO_LONG', depth + ' pages > MAX_PATH_LENGTH=' + CONFIG.MAX_PATH_LENGTH, sessionId);
      flag_(s, 'PATH_TOO_LONG');
    }
    if (uniq_(path).length !== path.length) {
      // Repeated pages can be legitimate; this check records path shape without inferring whether
      // the source is synthetic or production clickstream data.
      add('PAGE_REPEATED', path.join(' > '), sessionId);
      flag_(s, 'PAGE_REPEATED');
    }

    s.entryPage = depth ? path[0] : '';
    s.exitPage = depth ? path[depth - 1] : '';
    s.visitedCart = path.indexOf('CT') !== -1;
    s.visitedLanding = path.indexOf('LP') !== -1;
    s.cartPosition = s.visitedCart ? path.indexOf('CT') + 1 : '';
    s.endedOnCart = depth ? path[depth - 1] === 'CT' : false;

    // Cart-page checks. A cart event without the cart page in the path is a contradiction between
    // the event columns and the clickstream — exactly what a positional split is supposed to expose.
    if (!s.visitedCart) {
      if (s.conversion === 'Purchased') {
        add('PURCHASE_NO_CART', 'path = ' + path.join(' > '), sessionId);
        flag_(s, 'PURCHASE_NO_CART');
      }
      if (s.conversion === 'Added to Cart') {
        add('ADDTOCART_NO_CART', 'path = ' + path.join(' > '), sessionId);
        flag_(s, 'ADDTOCART_NO_CART');
      }
      if (CART_CHANGE_VALUES.indexOf(s.cartChangeRaw) !== -1) {
        add('CART_CHANGE_NO_CART', s.cartChangeRaw + ' on a path without CT: ' + path.join(' > '),
          sessionId);
        flag_(s, 'CART_CHANGE_NO_CART');
      }
    }

    // -- explode: one page_views row per position ---------------------------
    stats.expectedPageViews += depth;
    stats.expectedFromRegex += countNumbers_(rec[COL.TIME]);

    let totalTime = 0, totalClicks = 0, totalScrolls = 0;

    for (let i = 0; i < depth; i++) {
      const code = path[i];
      tally_(tallies.page, code);
      const meta = PAGE_META[code];
      if (!meta) {
        add('UNKNOWN_PAGE_CODE', '"' + code + '" at position ' + (i + 1), sessionId);
        flag_(s, 'UNKNOWN_PAGE_CODE');
      }

      const clicks = pickMetric_(interaction[i], 'Clicks', i + 1, sessionId, add, s);
      const scrolls = pickMetric_(interaction[i], 'Scrolls', i + 1, sessionId, add, s);
      const time = toNumberOrNull_(times[i]);

      if (time === null) {
        add('BAD_TIME', 'position ' + (i + 1) + ' = "' + times[i] + '"', sessionId);
        flag_(s, 'BAD_TIME');
      } else if (time < CONFIG.MIN_TIME_ON_PAGE || time > CONFIG.MAX_TIME_ON_PAGE) {
        add('TIME_OUT_OF_BOUNDS', 'position ' + (i + 1) + ' = ' + time + 's', sessionId);
        flag_(s, 'TIME_OUT_OF_BOUNDS');
      }

      if (clicks !== null) { totalClicks += clicks; observe_(stats.clicks, clicks); }
      if (scrolls !== null) { totalScrolls += scrolls; observe_(stats.scrolls, scrolls); }
      if (time !== null) { totalTime += time; observe_(stats.time, time); }

      pageViews.push([
        sessionId + '-' + (i + 1),                    // composite key at session x position grain
        sessionId,                                     // FK to sessions
        s.timestamp || '',
        s.date,
        i + 1,                                         // Position — the positional link itself
        code,
        meta ? meta.name : UNMAPPED,
        meta ? meta.type : UNMAPPED,
        meta ? meta.stage : UNMAPPED,
        clicks,
        scrolls,
        time,
        depth,
        i === 0,                                       // Is Entry
        i === depth - 1,                               // Is Exit
        i === 0 ? ENTRY_LABEL : path[i - 1],           // Previous Page
        i === depth - 1 ? EXIT_LABEL : path[i + 1],    // Next Page — enables transition analysis
        // Denormalised session attributes: Sheets pivots cannot join (see design decision 6).
        s.source,
        s.device,
        s.country,
        s.conversion,
      ]);
    }

    s.totalTime = totalTime;
    s.totalClicks = totalClicks;
    s.totalScrolls = totalScrolls;
    s.avgTimePerPage = depth ? Math.round((totalTime / depth) * 100) / 100 : '';

    sessions.push(s);
  });

  // -- cross-row pass: only decidable once every session has been read ------
  sessions.forEach(function (s) {
    const countries = userCountries[s.userId];
    if (countries && Object.keys(countries).length > 1) {
      issues.push({
        row: s.row, session: s.sessionId, code: 'USER_MULTI_COUNTRY',
        detail: 'user ' + s.userId + ' seen in ' + Object.keys(countries).sort().join(', '),
      });
      flag_(s, 'USER_MULTI_COUNTRY');
    }
  });

  /*
   * Observed new vs returning visitor. Sessions are ordered within this extract only; no claim is
   * made about visitor history before the extract. The first observed session is labelled "New"
   * and subsequent observed sessions are labelled "Returning".
   */
  const byUser = {};
  sessions.forEach(function (s) {
    const key = String(s.userId);
    if (key === '') {
      // No visitor id: the session cannot be attributed. Collapsing anonymous sessions into one
      // pseudo-user would create a false visit history, so the fields remain blank.
      s.userSessionCount = '';
      s.userSessionNo = '';
      s.visitorType = '';
      return;
    }
    if (!byUser[key]) byUser[key] = [];
    byUser[key].push(s);
  });
  Object.keys(byUser).forEach(function (key) {
    const list = byUser[key];
    // Sessions without a timestamp cannot be ordered; they sort last, keeping source order.
    list.sort(function (a, b) {
      if (a.timestamp && b.timestamp) return a.timestamp - b.timestamp || a.row - b.row;
      if (a.timestamp) return -1;
      if (b.timestamp) return 1;
      return a.row - b.row;
    });
    list.forEach(function (s, i) {
      s.userSessionCount = list.length;
      s.userSessionNo = i + 1;
      s.visitorType = i === 0 ? 'New' : 'Returning';
    });
  });

  // -- serialise flags onto each session row -------------------------------
  sessions.forEach(function (s) {
    const codes = Object.keys(s.flags).sort();
    const flagNames = codes.map(function (c) { return CHECKS[c].flag; })
      .filter(function (f) { return f; });
    s.dqFlags = flagNames.join('; ');
    s.dqIssues = codes.filter(function (c) {
      return CHECKS[c].severity === 'error' || CHECKS[c].severity === 'warning';
    }).length;
    s.dqSeverity = codes.reduce(function (worst, c) {
      return SEVERITY_RANK[CHECKS[c].severity] > SEVERITY_RANK[worst] ? CHECKS[c].severity : worst;
    }, 'ok');
  });

  return {
    sessions: sessions,
    pageViews: pageViews,
    issues: issues,
    stats: stats,
    tallies: tallies,
    counts: {
      bySeverity: countIssues_(issues, function (i) { return CHECKS[i.code].severity; }, SEVERITIES),
      byCheck: countIssues_(issues, function (i) { return i.code; }, []),
    },
  };
}

// ---------------------------------------------------------------------------
// CLEANING + PARSING HELPERS — pure functions, covered by runSelfTest_().
// ---------------------------------------------------------------------------

/**
 * Folds a raw category to its canonical form.
 * Folding removes case, spaces, underscores and hyphens, so "Paid Ads", "PaidAds", "paid_ads" and
 * "PAID-ADS" all reach the same key. Returns the status as well as the value, because "already
 * canonical", "repaired" and "not in the vocabulary" are three different things to a QA reader.
 */
function mapCategory_(rawValue, map) {
  const raw = str_(rawValue);
  if (raw === '') return { value: '', status: 'blank' };
  const key = raw.toLowerCase().replace(/[\s_\-]/g, '');
  const mapped = map[key];
  if (!mapped) return { value: raw, status: 'unmapped' };
  return { value: mapped, status: mapped === raw ? 'canonical' : 'normalised' };
}

/**
 * Browsing Path is a Python-style list with single quotes: ['P2', 'P3'].
 * Pulling the quoted tokens with a regex is more forgiving than JSON.parse on a quote-swapped
 * string: it tolerates either quote style, stray spaces and a trailing comma.
 * Returns null only when the cell is not a list at all, and [] for an empty list.
 */
function parsePath_(value) {
  const text = str_(value);
  if (text === '') return null;
  if (text.charAt(0) !== '[' || text.charAt(text.length - 1) !== ']') return null;
  if (/^\[\s*\]$/.test(text)) return [];
  const tokens = text.match(/['"]([^'"]*)['"]/g);
  if (!tokens) return null;
  return tokens.map(function (t) { return t.slice(1, -1).trim(); });
}

/**
 * Page Interaction and Time per Page are already valid JSON in the source.
 * The single-quote fallback keeps the script working if a future export switches style.
 */
function parseJsonArray_(value) {
  const text = str_(value);
  if (text === '') return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    try {
      const parsed = JSON.parse(text.replace(/'/g, '"'));
      return Array.isArray(parsed) ? parsed : null;
    } catch (e2) {
      return null;
    }
  }
}

/** Reads one metric out of an interaction object, recording the reason when it is unusable. */
function pickMetric_(obj, key, position, sessionId, add, session) {
  if (obj === null || typeof obj !== 'object') {
    add('MISSING_METRIC', 'position ' + position + ': interaction is not an object', sessionId);
    flag_(session, 'MISSING_METRIC');
    return null;
  }
  if (!(key in obj)) {
    add('MISSING_METRIC', 'position ' + position + ': ' + key + ' is absent', sessionId);
    flag_(session, 'MISSING_METRIC');
    return null;
  }
  const num = toNumberOrNull_(obj[key]);
  if (num === null) {
    add('MISSING_METRIC', 'position ' + position + ': ' + key + ' = "' + obj[key] + '"', sessionId);
    flag_(session, 'MISSING_METRIC');
  }
  return num;
}

/** Number or null. Zero survives — `0` is a legitimate value, not a missing one. */
function toNumberOrNull_(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (value instanceof Date) return null;
  const num = Number(value);
  return isNaN(num) ? null : num;
}

/**
 * Accepts a Sheets Date object or a string; returns null when neither parses.
 *
 * The parts are parsed explicitly rather than handed to `new Date(string)`, because this export
 * does NOT zero-pad the hour: 422 of the 1000 source rows read "2023-07-13 6:02:14". V8 accepts
 * that form but rejects the ISO-looking "2023-07-13T6:02:14" — so the obvious `replace(' ', 'T')`
 * silently turns 42% of the timestamps into Invalid Date, and every date pivot loses those rows.
 * Reproduced and covered by runSelfTest_().
 */
function toDate_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const text = str_(value);
  if (text === '') return null;
  const m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) {
    // Local time, which is how Sheets treats a datetime with no zone attached.
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    return isNaN(d.getTime()) ? null : d;
  }
  const parsed = new Date(text);           // any other shape: let the engine try
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Independent second opinion on how many page views a row should produce: counts the numbers in
 * `Time per Page` with a regex instead of JSON.parse. If the two parsers disagree, the JSON path
 * silently mis-read something (a nested array, a missing element) and the QA report says so.
 * The pattern matches signed decimals, so a future export with fractional seconds does not raise
 * a false mismatch by counting "36.5" as two numbers.
 */
function countNumbers_(value) {
  const found = str_(value).match(/-?\d+(?:\.\d+)?/g);
  return found ? found.length : 0;
}

/** Monday-first weekday label. The numeric prefix is what makes a pivot sort chronologically. */
function weekdayLabel_(date, tz) {
  const names = { Mon: '1 Mon', Tue: '2 Tue', Wed: '3 Wed', Thu: '4 Thu', Fri: '5 Fri', Sat: '6 Sat', Sun: '7 Sun' };
  return names[Utilities.formatDate(date, tz, 'EEE')] || '';
}

// ---------------------------------------------------------------------------
// SHEET I/O
// ---------------------------------------------------------------------------

/** Locates the raw tab and returns {sheet, headers, records} with records keyed by header name. */
function readRaw_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = null;
  for (let i = 0; i < CONFIG.RAW_SHEET_CANDIDATES.length && !sheet; i++) {
    sheet = ss.getSheetByName(CONFIG.RAW_SHEET_CANDIDATES[i]);
  }
  // Last resort: any tab whose A1 is the Timestamp header — survives a renamed source tab.
  if (!sheet) {
    sheet = ss.getSheets().filter(function (s) {
      return str_(s.getRange(1, 1).getValue()) === COL.TS;
    })[0] || null;
  }
  if (!sheet) {
    throw new Error('Raw sheet not found. Rename the source tab to "' +
      CONFIG.RAW_SHEET_CANDIDATES[0] + '" or add its name to CONFIG.RAW_SHEET_CANDIDATES.');
  }

  const values = sheet.getDataRange().getValues();       // single read, whole tab
  if (values.length < 2) throw new Error('Raw sheet "' + sheet.getName() + '" has no data rows.');

  const headers = values[0].map(function (h) { return str_(h); });
  const missingRequired = REQUIRED_COLUMNS.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missingRequired.length) {
    throw new Error('Raw sheet is missing required column(s): ' + missingRequired.join(', '));
  }
  // Optional columns are not fatal: report them and carry on with blanks.
  const missingOptional = Object.keys(COL).map(function (k) { return COL[k]; })
    .filter(function (h) { return headers.indexOf(h) === -1; });

  const records = [];
  for (let r = 1; r < values.length; r++) {
    const rec = { __row: r + 1 };                        // sheet row number, for actionable QA
    for (let c = 0; c < headers.length; c++) rec[headers[c]] = values[r][c];
    records.push(rec);
  }
  return { sheet: sheet, headers: headers, records: records, missingOptional: missingOptional };
}

/**
 * Replaces a tab with exactly headers + rows: no leftover rows below the data, because trailing
 * blanks break QUERY and add a phantom category to every pivot.
 */
function writeTable_(name, headers, rows) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  sheet.clearNotes();
  sheet.clearConditionalFormatRules();
  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();          // a stale filter would hide the new rows

  const needRows = Math.max(rows.length + 1, 2);
  const needCols = Math.max(headers.length, 1);
  if (sheet.getMaxRows() > needRows) sheet.deleteRows(needRows + 1, sheet.getMaxRows() - needRows);
  if (sheet.getMaxRows() < needRows) sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
  if (sheet.getMaxColumns() > needCols) sheet.deleteColumns(needCols + 1, sheet.getMaxColumns() - needCols);
  if (sheet.getMaxColumns() < needCols) sheet.insertColumnsAfter(sheet.getMaxColumns(), needCols - sheet.getMaxColumns());

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.setFrozenRows(1);
  return sheet;
}

/** Applies number formats by 1-based column index: {3: 'yyyy-mm-dd', 17: '#,##0.00'}. */
function applyFormats_(sheet, rowCount, formats) {
  if (!rowCount) return;
  Object.keys(formats).forEach(function (col) {
    sheet.getRange(2, Number(col), rowCount, 1).setNumberFormat(formats[col]);
  });
}

const SESSION_HEADERS = ['Session ID', 'User ID', 'Session Timestamp', 'Session Date',
  'Session Month', 'Session Weekday', 'Session Hour', 'Traffic Source', 'Traffic Source (raw)',
  'Device Type', 'Device Type (raw)', 'Country', 'City', 'City Belongs To', 'Geo Consistent',
  'Visitor Type', 'User Session No', 'User Session Count',
  'Cart Change', 'Cart Change (raw)', 'Conversion Event', 'Purchase Value', 'Has Revenue',
  'Page Count', 'Entry Page', 'Exit Page', 'Visited Landing', 'Visited Cart', 'Cart Position',
  'Ended On Cart', 'Total Time (s)', 'Total Clicks', 'Total Scrolls', 'Avg Time per Page (s)',
  'DQ Severity', 'DQ Issues', 'DQ Flags'];

// Compatibility labels in the submitted workbook:
// - Visitor Type means first/repeat session observed within this extract.
// - Has Revenue means Purchase Value > 0; it is not a confirmed revenue indicator.

function writeSessions_(model) {
  const rows = model.sessions.map(function (s) {
    return [s.sessionId, s.userId, s.timestamp || '', s.date, s.month, s.weekday, s.hour,
      s.source, s.sourceRaw, s.device, s.deviceRaw, s.country, s.city, s.cityCountry,
      s.geoConsistent, s.visitorType, s.userSessionNo, s.userSessionCount,
      s.cartChange, s.cartChangeRaw, s.conversion, s.purchaseValue, s.hasRevenue,
      s.pageCount, s.entryPage, s.exitPage, s.visitedLanding, s.visitedCart, s.cartPosition,
      s.endedOnCart, s.totalTime, s.totalClicks, s.totalScrolls, s.avgTimePerPage,
      s.dqSeverity, s.dqIssues, s.dqFlags];
  });
  const sheet = writeTable_(CONFIG.SESSIONS_SHEET, SESSION_HEADERS, rows);
  /*
   * `Session Date` and `Session Month` are written as the strings "2023-12-10" and "2023-12", and
   * Sheets coerces both to real dates on write — verified by exporting the workbook, where the
   * cells held the serials 45270 and 45261. That coercion is useful (a pivot then sorts months
   * chronologically instead of alphabetically) but it inherits the locale's default date format,
   * so a month cell would read "01.12.2023". Explicit formatting keeps the display consistent.
   */
  applyFormats_(sheet, rows.length, {
    3: CONFIG.DATETIME_FORMAT,
    4: CONFIG.DATE_FORMAT,
    5: 'yyyy-mm',
    22: CONFIG.MONEY_FORMAT,
  });

  /*
   * Highlight ERRORS only, not every flagged row.
   * In the supplied snapshot, geography mismatches are high-prevalence, so only error severity is
   * shaded. Warnings stay filterable through DQ Flags / DQ Severity, and qa_report carries the share of
   * sessions each check touches, which is where a systemic problem belongs.
   */
  if (rows.length) {
    const sevCol = SESSION_HEADERS.indexOf('DQ Severity') + 1;
    const rule = SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('error')
      .setBackground('#FCE8E6')
      .setRanges([sheet.getRange(2, sevCol, rows.length, 1)])
      .build();
    sheet.setConditionalFormatRules([rule]);
  }
  return sheet;
}

const PAGE_VIEW_HEADERS = ['Page View ID', 'Session ID', 'Session Timestamp', 'Session Date',
  'Position', 'Page Code', 'Page Name', 'Page Type', 'Funnel Stage', 'Clicks', 'Scrolls',
  'Time on Page (s)', 'Path Depth', 'Is Entry', 'Is Exit', 'Previous Page', 'Next Page',
  'Traffic Source', 'Device Type', 'Country', 'Conversion Event'];

function writePageViews_(model) {
  const sheet = writeTable_(CONFIG.PAGE_VIEWS_SHEET, PAGE_VIEW_HEADERS, model.pageViews);
  applyFormats_(sheet, model.pageViews.length,
    { 3: CONFIG.DATETIME_FORMAT, 4: CONFIG.DATE_FORMAT });
  return sheet;
}

/** Renders PAGE_META as a readable dictionary tab — the same constant that stamps page_views. */
function writeDimPage_() {
  const rows = Object.keys(PAGE_META)
    .map(function (code) {
      const m = PAGE_META[code];
      return [code, m.name, m.type, m.stage, m.sort];
    })
    .sort(function (a, b) { return a[4] - b[4]; });
  const sheet = writeTable_(CONFIG.DIM_PAGE_SHEET,
    ['Page Code', 'Page Name', 'Page Type', 'Funnel Stage', 'Sort Order'], rows);
  sheet.autoResizeColumns(1, 5);
  return sheet;
}

/**
 * The normalisation map as data: every raw value that occurs, what it became, and how many rows it
 * covers. This makes the cleaning auditable without opening the script editor; row counts are
 * generated from the same rebuild so the displayed mapping stays aligned with that run.
 */
function writeDimLookup_(model) {
  const rows = [];
  const push = function (column, raw, canonical, count, note) {
    rows.push([column, raw, canonical, count, note]);
  };

  const describe = function (column, tally, map) {
    Object.keys(tally).sort().forEach(function (raw) {
      const m = mapCategory_(raw, map);
      const note = m.status === 'canonical' ? 'already canonical'
        : m.status === 'normalised' ? 'folded to canonical form'
        : m.status === 'blank' ? 'blank in source'
        : 'NOT IN VOCABULARY — kept verbatim';
      push(column, raw === '' ? '(blank)' : raw, m.value === '' ? '(blank)' : m.value,
        tally[raw], note);
    });
  };

  describe(COL.SOURCE, model.tallies.source, SOURCE_MAP);
  describe(COL.DEVICE, model.tallies.device, DEVICE_MAP);

  Object.keys(model.tallies.city).sort().forEach(function (city) {
    const belongs = CITY_COUNTRY[city.toLowerCase()] || '';
    push(COL.CITY, city === '' ? '(blank)' : city, belongs || UNMAPPED, model.tallies.city[city],
      belongs ? 'city dictionary — used to test Country, never to overwrite it'
              : 'not in the city dictionary');
  });
  Object.keys(model.tallies.country).sort().forEach(function (country) {
    push(COL.COUNTRY, country === '' ? '(blank)' : country, country,
      model.tallies.country[country], 'kept as stated in the source');
  });
  Object.keys(model.tallies.cart).sort().forEach(function (v) {
    const isBlank = v === '';
    push(COL.CART, isBlank ? '(blank)' : v, isBlank ? CART_CHANGE_BLANK : v, model.tallies.cart[v],
      isBlank ? 'ASSUMPTION: blank read as no cart interaction'
        : CART_CHANGE_VALUES.indexOf(v) === -1 ? 'NOT IN VOCABULARY' : 'closed vocabulary');
  });
  Object.keys(model.tallies.conversion).sort().forEach(function (v) {
    push(COL.CONVERSION, v === '' ? '(blank)' : v, v === '' ? '(blank)' : v,
      model.tallies.conversion[v],
      CONVERSION_VALUES.indexOf(v) === -1 ? 'NOT IN VOCABULARY' : 'closed vocabulary');
  });
  // Page codes: the dictionary plus anything the paths actually contained, so a code that exists in
  // the data but not in PAGE_META is visible here as well as in the audit.
  uniq_(Object.keys(PAGE_META).concat(Object.keys(model.tallies.page))).forEach(function (code) {
    const meta = PAGE_META[code];
    push(COL.PATH, code, meta ? meta.name : UNMAPPED, model.tallies.page[code] || 0,
      meta ? 'page dictionary — count is page VIEWS, not sessions; see dim_page'
           : 'NOT IN PAGE DICTIONARY — present in Browsing Path with no definition');
  });

  const sheet = writeTable_(CONFIG.DIM_LOOKUP_SHEET,
    ['Column', 'Raw Value', 'Canonical Value', 'Rows Affected', 'Note'], rows);
  sheet.autoResizeColumns(1, 5);
  return sheet;
}

/**
 * The audit. Four blocks: reconciliation (does the output account for every input row), measured
 * ranges (what the data actually looks like, without a chart), findings (every check with its
 * severity, count and a capped sample), and the self-test (did the parsers themselves pass).
 */
function writeQaReport_(raw, model, selfTest, started) {
  const sev = model.counts.bySeverity;
  const byCheck = model.counts.byCheck;
  const st = model.stats;
  const written = model.pageViews.length;
  const reconciles = written === st.expectedPageViews && written === st.expectedFromRegex;

  const out = [];
  const row = function (a, b, c) { out.push([a, b === undefined ? '' : b, c === undefined ? '' : c]); };
  const blank = function () { row('', '', ''); };

  row('DATA QUALITY REPORT — ecommerce_website_data', '', '');
  row('Generated at', new Date());
  row('Runtime, sec', (new Date() - started) / 1000);
  row('Source tab', raw.sheet.getName());
  if (raw.missingOptional.length) {
    row('Source columns missing', raw.missingOptional.join(', '), 'treated as blank');
  }
  blank();

  row('RECONCILIATION', '', 'every input row must be accounted for');
  row('Rows read from source', raw.records.length);
  row('Sessions written', model.sessions.length);
  row('Rows skipped', st.skipped, 'blank, unkeyed or structurally unusable');
  row('Rows read = sessions + skipped',
    raw.records.length === model.sessions.length + st.skipped ? 'OK' : 'MISMATCH');
  row('Page views written', written);
  row('Page views expected (sum of path lengths)', st.expectedPageViews);
  row('Page views expected (independent regex parser)', st.expectedFromRegex);
  row('Reconciles', reconciles ? 'OK' : 'MISMATCH');
  row('Avg pages per session',
    model.sessions.length ? Math.round((written / model.sessions.length) * 100) / 100 : 0);
  blank();

  row('MEASURED RANGES', '', 'observed in this run, not assumed');
  rangeRow_(row, 'Clicks per page view', st.clicks);
  rangeRow_(row, 'Scrolls per page view', st.scrolls);
  rangeRow_(row, 'Time on page, s', st.time);
  rangeRow_(row, 'Pages per session', st.depth);
  rangeRow_(row, 'Purchase Value', st.purchase);
  row('Timestamp range',
    st.firstTs ? Utilities.formatDate(st.firstTs, getTimeZone_(), 'yyyy-MM-dd') : '',
    st.lastTs ? Utilities.formatDate(st.lastTs, getTimeZone_(), 'yyyy-MM-dd') : '');
  row('Distinct Traffic Source: raw -> clean',
    Object.keys(model.tallies.source).length,
    distinctCanonical_(model.tallies.source, SOURCE_MAP));
  row('Distinct Device Type: raw -> clean',
    Object.keys(model.tallies.device).length,
    distinctCanonical_(model.tallies.device, DEVICE_MAP));
  blank();

  row('FINDINGS', '', '');
  row('Errors', sev.error, 'critical key, parsing, vocabulary or metric issue');
  row('Warnings', sev.warning, 'retained record requiring review');
  row('Info', sev.info, 'normalisation or documented assumption');
  row('Sessions with at least one error or warning',
    model.sessions.filter(function (s) { return s.dqIssues > 0; }).length,
    'of ' + model.sessions.length);
  blank();

  row('SELF-TEST', selfTest.failed ? selfTest.failed + ' FAILED' : 'all passed',
    selfTest.rows.length + ' assertions on the parsing and cleaning functions');
  selfTest.rows.forEach(function (r) { row('   ' + r[3] + ' ' + r[0], r[1], r[2]); });

  // -- write the summary block ---------------------------------------------
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(CONFIG.QA_SHEET) || ss.insertSheet(CONFIG.QA_SHEET);
  sheet.clear();
  sheet.clearNotes();
  const filter = sheet.getFilter();
  if (filter) filter.remove();

  sheet.getRange(1, 1, out.length, 3).setValues(out);
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  sheet.getRange(2, 2).setNumberFormat(CONFIG.DATETIME_FORMAT);
  ['RECONCILIATION', 'MEASURED RANGES', 'FINDINGS', 'SELF-TEST'].forEach(function (label) {
    for (let i = 0; i < out.length; i++) {
      if (out[i][0] === label) sheet.getRange(i + 1, 1, 1, 3).setFontWeight('bold');
    }
  });

  // -- checks table: one row per check, ordered worst first ------------------
  // Sessions affected per check, taken from the flags stamped on the session rows. It answers a
  // different question than the finding count: MISSING_METRIC counts page views, TIME_OUT_OF_BOUNDS
  // can fire six times inside one session. Session share helps distinguish high-prevalence issues
  // from isolated rows; root cause still requires source-system context.
  const sessionsPerCheck = {};
  model.sessions.forEach(function (s) {
    Object.keys(s.flags).forEach(function (code) {
      sessionsPerCheck[code] = (sessionsPerCheck[code] || 0) + 1;
    });
  });
  const total = model.sessions.length;

  let cursor = out.length + 2;
  const checkHead = ['Check', 'Severity', 'Findings', 'Sessions affected', 'Share of sessions',
    'What it means'];
  sheet.getRange(cursor, 1, 1, checkHead.length).setValues([checkHead]).setFontWeight('bold');
  const checkRows = Object.keys(CHECKS)
    .filter(function (code) { return byCheck[code]; })
    .sort(function (a, b) {
      const d = SEVERITY_RANK[CHECKS[b].severity] - SEVERITY_RANK[CHECKS[a].severity];
      return d !== 0 ? d : byCheck[b] - byCheck[a];
    })
    .map(function (code) {
      const affected = sessionsPerCheck[code];
      // No flag means the row was skipped, so a sessions-based share is not applicable.
      return [code, CHECKS[code].severity, byCheck[code],
        affected === undefined ? 'row skipped' : affected,
        affected === undefined || !total ? '' : (affected / total * 100).toFixed(1) + '%',
        CHECKS[code].desc];
    });
  if (checkRows.length) {
    sheet.getRange(cursor + 1, 1, checkRows.length, checkHead.length).setValues(checkRows);
  } else {
    sheet.getRange(cursor + 1, 1).setValue('No checks triggered.');
  }
  cursor += Math.max(checkRows.length, 1) + 2;

  // -- detail rows, capped per check ----------------------------------------
  const detailHead = ['Source Row', 'Session ID', 'Severity', 'Check', 'Detail'];
  sheet.getRange(cursor, 1, 1, detailHead.length).setValues([detailHead]).setFontWeight('bold');
  cursor += 1;

  const shown = {};
  const detail = [];
  model.issues.forEach(function (issue) {
    shown[issue.code] = (shown[issue.code] || 0) + 1;
    if (shown[issue.code] <= CONFIG.MAX_DETAIL_ROWS_PER_CHECK) {
      detail.push([issue.row, issue.session, CHECKS[issue.code].severity, issue.code, issue.detail]);
    }
  });
  Object.keys(shown).forEach(function (code) {
    if (shown[code] > CONFIG.MAX_DETAIL_ROWS_PER_CHECK) {
      detail.push(['', '', CHECKS[code].severity, code,
        '... showing first ' + CONFIG.MAX_DETAIL_ROWS_PER_CHECK + ' of ' + shown[code] +
        '. Additional detail rows are omitted; retained sessions expose DQ Flags where applicable.']);
    }
  });

  if (detail.length) {
    sheet.getRange(cursor, 1, detail.length, 5).setValues(detail);
  } else {
    sheet.getRange(cursor, 1).setValue(
      'No registered row-level anomalies were found; see reconciliation and missing-column summaries above.');
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 4);
  sheet.setColumnWidth(5, 420);   // holds "Detail" in the findings table
  sheet.setColumnWidth(6, 520);   // holds "What it means" in the checks table
  return sheet;
}

/**
 * Removes recognized output tabs written by earlier versions of this script. Guarded by a content
 * check: a tab is only dropped if its A1 still looks
 * like our own output, so a tab a human has repurposed is left alone.
 */
function dropLegacySheets_() {
  const ss = SpreadsheetApp.getActive();
  CONFIG.LEGACY_SHEETS.forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    const a1 = str_(sheet.getRange(1, 1).getValue());
    if (a1.indexOf('QA report') !== -1 || a1 === '') ss.deleteSheet(sheet);
  });
}

// ---------------------------------------------------------------------------
// SMALL UTILITIES
// ---------------------------------------------------------------------------
function str_(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function isBlankRecord_(rec, headers) {
  return headers.every(function (h) { return str_(rec[h]) === ''; });
}

function uniq_(arr) {
  return arr.filter(function (v, i) { return arr.indexOf(v) === i; });
}

function flag_(session, code) {
  if (session) session.flags[code] = true;
}

function tally_(bucket, value) {
  bucket[value] = (bucket[value] || 0) + 1;
}

function newRange_() {
  return { n: 0, min: null, max: null, sum: 0 };
}

function observe_(range, value) {
  range.n += 1;
  range.sum += value;
  if (range.min === null || value < range.min) range.min = value;
  if (range.max === null || value > range.max) range.max = value;
}

function rangeRow_(row, label, range) {
  if (!range.n) { row(label, 'no values', ''); return; }
  row(label, 'min ' + range.min + ' / max ' + range.max,
    'mean ' + (Math.round((range.sum / range.n) * 100) / 100) + ' over ' + range.n + ' values');
}

/** "8 raw -> 4 canonical" for the summary line. */
function distinctCanonical_(tally, map) {
  const canonical = {};
  Object.keys(tally).forEach(function (raw) { canonical[mapCategory_(raw, map).value] = true; });
  return Object.keys(canonical).length + ' canonical: ' + Object.keys(canonical).sort().join(', ');
}

/** Counts issues by an arbitrary key, pre-seeding keys that must appear even at zero. */
function countIssues_(issues, keyFn, seed) {
  const counts = {};
  seed.forEach(function (k) { counts[k] = 0; });
  issues.forEach(function (i) {
    const k = keyFn(i);
    counts[k] = (counts[k] || 0) + 1;
  });
  return counts;
}

function getTimeZone_() {
  return SpreadsheetApp.getActive().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
}

// ---------------------------------------------------------------------------
// SELF-TEST — the parsing and cleaning functions are pure, so they can be asserted on directly.
// A failure is surfaced in qa_report rather than thrown, so a broken edge case never silently
// changes the numbers a reader is looking at.
// ---------------------------------------------------------------------------
function runSelfTest_() {
  const rows = [];
  let failed = 0;
  const check = function (name, expected, actual) {
    const exp = JSON.stringify(expected);
    const act = JSON.stringify(actual);
    const pass = exp === act;
    if (!pass) failed += 1;
    rows.push([name, exp, act, pass ? 'PASS' : 'FAIL']);
  };

  // parsePath_ — the column the whole positional split depends on
  check('parsePath_ python-style list', ['P2', 'P3'], parsePath_("['P2', 'P3']"));
  check('parsePath_ double-quoted list', ['A', 'B'], parsePath_('["A","B"]'));
  check('parsePath_ single element', ['CT'], parsePath_("['CT']"));
  check('parsePath_ empty list', [], parsePath_('[]'));
  check('parsePath_ blank cell', null, parsePath_(''));
  check('parsePath_ not a list', null, parsePath_('P2'));
  check('parsePath_ trailing comma tolerated', ['P1'], parsePath_("['P1',]"));

  // parseJsonArray_
  check('parseJsonArray_ interactions', 2,
    (parseJsonArray_('[{"Clicks": 6, "Scrolls": 5}, {"Clicks": 8, "Scrolls": 6}]') || []).length);
  check('parseJsonArray_ times', [36, 93], parseJsonArray_('[36, 93]'));
  check('parseJsonArray_ truncated json', null, parseJsonArray_('[36, 93'));
  check('parseJsonArray_ object not array', null, parseJsonArray_('{"Clicks": 1}'));

  // toNumberOrNull_ — zero must survive
  check('toNumberOrNull_ zero survives', 0, toNumberOrNull_(0));
  check('toNumberOrNull_ numeric string', 5, toNumberOrNull_('5'));
  check('toNumberOrNull_ blank', null, toNumberOrNull_(''));
  check('toNumberOrNull_ text', null, toNumberOrNull_('n/a'));

  /*
   * toDate_ — regression cover for a real defect.
   * 422 of the 1000 source timestamps have a single-digit hour ("2023-07-13 6:02:14"). The earlier
   * implementation normalised the space to "T" before parsing, which V8 rejects, so 42% of the
   * table silently lost its timestamp and every month / weekday / hour pivot was built on 578 rows.
   */
  const dparts = function (d) {
    return d ? [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()] : null;
  };
  check('toDate_ single-digit hour', [2023, 7, 13, 6, 2, 14], dparts(toDate_('2023-07-13 6:02:14')));
  check('toDate_ padded hour', [2023, 12, 10, 15, 48, 6], dparts(toDate_('2023-12-10 15:48:06')));
  check('toDate_ ISO with T', [2023, 12, 10, 15, 48, 6], dparts(toDate_('2023-12-10T15:48:06')));
  check('toDate_ date only', [2023, 1, 1, 0, 0, 0], dparts(toDate_('2023-01-01')));
  check('toDate_ passes a Date through', [2024, 2, 29, 1, 2, 3],
    dparts(toDate_(new Date(2024, 1, 29, 1, 2, 3))));
  check('toDate_ blank', null, toDate_(''));
  check('toDate_ garbage', null, toDate_('not a date'));

  // countNumbers_ — the cross-check parser must not split a decimal into two numbers
  check('countNumbers_ integers', 3, countNumbers_('[36, 93, 108]'));
  check('countNumbers_ decimals stay one number', 2, countNumbers_('[36.5, 93.25]'));
  check('countNumbers_ empty list', 0, countNumbers_('[]'));

  // mapCategory_ — every dirty variant present in the source
  check('mapCategory_ canonical source', ['Organic Search', 'canonical'],
    valueStatus_(mapCategory_('Organic Search', SOURCE_MAP)));
  check('mapCategory_ Organic folds', ['Organic Search', 'normalised'],
    valueStatus_(mapCategory_('Organic', SOURCE_MAP)));
  check('mapCategory_ PaidAds folds', ['Paid Ads', 'normalised'],
    valueStatus_(mapCategory_('PaidAds', SOURCE_MAP)));
  check('mapCategory_ lowercase email folds', ['Email', 'normalised'],
    valueStatus_(mapCategory_('email', SOURCE_MAP)));
  check('mapCategory_ unknown source kept', ['Referral', 'unmapped'],
    valueStatus_(mapCategory_('Referral', SOURCE_MAP)));
  check('mapCategory_ device D folds', ['Desktop', 'normalised'],
    valueStatus_(mapCategory_('D', DEVICE_MAP)));
  check('mapCategory_ device lowercase folds', ['Tablet', 'normalised'],
    valueStatus_(mapCategory_('tablet', DEVICE_MAP)));
  check('mapCategory_ blank', ['', 'blank'], valueStatus_(mapCategory_('', DEVICE_MAP)));

  // geography dictionary
  check('CITY_COUNTRY resolves New York', 'USA', CITY_COUNTRY['new york']);
  check('CITY_COUNTRY has no entry for a city outside the universe', undefined, CITY_COUNTRY['paris']);

  // every check code carries a severity the report knows how to rank
  check('CHECKS registry severities are valid', [],
    Object.keys(CHECKS).filter(function (c) { return SEVERITIES.indexOf(CHECKS[c].severity) === -1; }));
  // header lists must match what the writers actually emit
  check('SESSION_HEADERS width', 37, SESSION_HEADERS.length);
  check('PAGE_VIEW_HEADERS width', 21, PAGE_VIEW_HEADERS.length);
  check('SESSION_HEADERS are unique', 37, uniq_(SESSION_HEADERS).length);
  check('PAGE_VIEW_HEADERS are unique', 21, uniq_(PAGE_VIEW_HEADERS).length);
  // the formatted columns must still be the ones the headers say they are
  check('Purchase Value is column 22', 22, SESSION_HEADERS.indexOf('Purchase Value') + 1);
  check('Session Timestamp is column 3', 3, SESSION_HEADERS.indexOf('Session Timestamp') + 1);

  return { rows: rows, failed: failed };
}

function valueStatus_(result) {
  return [result.value, result.status];
}
