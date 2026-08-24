/**
 * Bulls Media — Test task for analyst V3, Part 5 (analysis layer)
 * Pivot tables, statistical blocks and charts on top of the normalised output.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------------------------------------------------------
 * `normalize.gs` turns the raw export into two fact tables and audits them. This file reads
 * those tables and presents them. The split keeps transformation and presentation concerns separate.
 *
 * DEPENDENCY: the two files live in the same Apps Script project and share a global scope.
 * This file reuses `str_()` and `uniq_()` from normalize.gs, and the menu it hangs off is
 * defined there too. Paste both files into the project — neither runs alone.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PRODUCES — four tabs, all rebuilt from scratch on every run
 * ---------------------------------------------------------------------------
 *   pivot_sessions   13 native pivot tables at the session grain
 *   pivot_pages       5 native pivot tables at the page-view grain
 *   analysis         the numbers a pivot table cannot express: Wilson confidence intervals,
 *                    chi-square independence tests, a two-proportion z-test, a replication split,
 *                    correlations, uniformity goodness-of-fit, and the three revenue rules
 *   charts            9 charts, sourced from the `analysis` blocks
 *
 * ---------------------------------------------------------------------------
 * DESIGN DECISIONS
 * ---------------------------------------------------------------------------
 *  1. Pivots are NATIVE pivot tables, not values written by the script. The reviewer can re-group
 *     them, and the brief asks for pivot tables — not for a picture of one.
 *  2. Inferential tests and selected rates on `analysis` are live formulas (CHISQ.TEST,
 *     NORM.S.DIST, CORREL, SUMIF, and Wilson bounds). Descriptive blocks are recalculated by the
 *     script on rebuild. Formula-driven results remain inspectable against their source ranges.
 *  3. Charts read the `analysis` blocks, never the output of a pivot table. A pivot's height
 *     changes with the data, and a chart pinned to a range that moved is a silently wrong chart.
 *  4. Columns are resolved by HEADER NAME through colIndex_(), which throws when a header is
 *     missing. If `sessions` is re-laid-out, the rebuild stops instead of using the wrong field.
 *  5. Layout anchors are declared, not computed, and runAnalysisSelfTest_() verifies that no pivots
 *     overlap. Overlapping pivots throw at creation time, halfway through a rebuild.
 *  6. Idempotent: existing pivots and charts are removed before anything is written, so a rebuild
 *     never stacks two generations of artifacts on one tab.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT BUILT, AND WHY
 * ---------------------------------------------------------------------------
 *  - No funnel chart. In the supplied snapshot, paths often conflict with the expected stage order.
 *    "Page reach" and the position-preserving transition table are therefore more defensible.
 *  - No revenue KPI or AOV. `Purchase Value` conflicts with `Conversion Event`, so three explicit
 *    interpretations that differ by 3.5x are shown side by side.
 *  - No geographic map. The country/city test provides no evidence of association (chi-square
 *    p = 0.65), and the pairings conflict with the supplied lookup. The contingency table remains
 *    visible for audit, but geography is excluded from segmentation.
 *
 * HOW TO RUN: menu "Bulls Media" -> "Rebuild pivots & charts", or run rebuildAnalysis().
 * Run rebuildAll() first — this file reads `sessions` and `page_views`.
 */

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const ANALYSIS_CONFIG = {
  SESSIONS: 'sessions',
  PAGE_VIEWS: 'page_views',
  PIVOT_SESSIONS_SHEET: 'pivot_sessions',
  PIVOT_PAGES_SHEET: 'pivot_pages',
  ANALYSIS_SHEET: 'analysis',
  CHARTS_SHEET: 'charts',

  Z95: 1.959963985,          // two-sided 95% normal quantile, used by every Wilson interval
  H1_LAST_MONTH: '2023-06',  // replication split: first half of the observed period
  BLOCK_GAP: 2,              // blank rows between blocks on the analysis tab

  PCT_FORMAT: '0.0%',
  MONEY_FORMAT: '#,##0.00',
  NUM_FORMAT: '#,##0',
  P_FORMAT: '0.0000',
  CORR_FORMAT: '+0.000;-0.000',
};

/** Brand palette, same colours as the Power BI theme in Part 3 so the submission looks like one project. */
const PALETTE = {
  gold: '#EEC106',
  navy: '#3D4B7B',
  steel: '#8F9EB0',
  paleBlue: '#CCDFEB',
  charcoal: '#383F42',
  warn: '#D18C20',
};

/**
 * Pivot specifications, declared as data.
 * `size` is the area reserved for the pivot — used only by the overlap self-test, and set with
 * headroom, because a pivot grows when a new category appears in the source.
 */
const SESSION_PIVOTS = [
  {
    anchor: [3, 1], size: [8, 6], title: '1. Conversion mix by traffic channel',
    question: 'Does the acquisition channel change what a session does?',
    rows: [{ col: 'Traffic Source' }],
    cols: [{ col: 'Conversion Event' }],
    values: [{ col: 'Session ID', fn: 'COUNTA', showAs: 'PERCENT_OF_ROW_TOTAL', name: '% of sessions' }],
  },
  {
    anchor: [13, 1], size: [7, 6], title: '2. Conversion mix by device type',
    question: 'How does the observed conversion mix vary by device?',
    rows: [{ col: 'Device Type' }],
    cols: [{ col: 'Conversion Event' }],
    values: [{ col: 'Session ID', fn: 'COUNTA', showAs: 'PERCENT_OF_ROW_TOTAL', name: '% of sessions' }],
  },
  {
    anchor: [22, 1], size: [6, 6], title: '3. Conversion mix by observed visitor type',
    question: 'Do repeat-observed visitors convert differently within this extract?',
    rows: [{ col: 'Visitor Type' }],
    cols: [{ col: 'Conversion Event' }],
    values: [{ col: 'Session ID', fn: 'COUNTA', showAs: 'PERCENT_OF_ROW_TOTAL', name: '% of sessions' }],
  },
  {
    anchor: [30, 1], size: [10, 6], title: '4. Conversion mix by session depth',
    question: 'How does the recorded purchase-event rate vary with session depth?',
    rows: [{ col: 'Page Count' }],
    cols: [{ col: 'Conversion Event' }],
    values: [{ col: 'Session ID', fn: 'COUNTA', showAs: 'PERCENT_OF_ROW_TOTAL', name: '% of sessions' }],
  },
  {
    anchor: [42, 1], size: [10, 3], title: '5. Entry pages',
    question: 'Where do sessions start?',
    rows: [{ col: 'Entry Page' }],
    cols: [],
    values: [{ col: 'Session ID', fn: 'COUNTA', name: 'Sessions' }],
  },
  {
    anchor: [54, 1], size: [10, 3], title: '6. Exit pages',
    question: 'Where do sessions end?',
    rows: [{ col: 'Exit Page' }],
    cols: [],
    values: [{ col: 'Session ID', fn: 'COUNTA', name: 'Sessions' }],
  },
  {
    anchor: [3, 8], size: [7, 8], title: '7. Conversion event x positive value — data-quality cross-check',
    question: 'How often do Conversion Event and positive Purchase Value disagree?',
    rows: [{ col: 'Conversion Event' }],
    cols: [{ col: 'Has Revenue' }],
    values: [
      { col: 'Session ID', fn: 'COUNTA', name: 'Sessions' },
      { col: 'Purchase Value', fn: 'SUM', name: 'Value' },
    ],
  },
  {
    anchor: [13, 8], size: [9, 8], title: '8. Country x City',
    question: 'Is the city inside the country it is filed under?',
    rows: [{ col: 'Country' }],
    cols: [{ col: 'City' }],
    values: [{ col: 'Session ID', fn: 'COUNTA', name: 'Sessions' }],
  },
  {
    anchor: [24, 8], size: [16, 5], title: '9. Volume and money by month',
    question: 'How does volume vary across the observed months?',
    rows: [{ col: 'Session Month' }],
    cols: [],
    values: [
      { col: 'Session ID', fn: 'COUNTA', name: 'Sessions' },
      { col: 'Purchase Value', fn: 'SUM', name: 'Recorded value' },
      { col: 'Total Time (s)', fn: 'AVERAGE', name: 'Avg session time' },
    ],
  },
  {
    anchor: [42, 8], size: [11, 4], title: '10. Volume by weekday',
    question: 'Is there a visible weekly rhythm?',
    rows: [{ col: 'Session Weekday' }],
    cols: [],
    values: [
      { col: 'Session ID', fn: 'COUNTA', name: 'Sessions' },
      { col: 'Purchase Value', fn: 'SUM', name: 'Recorded value' },
    ],
  },
  {
    anchor: [55, 8], size: [7, 3], title: '11. Data-quality severity',
    question: 'How much of the table is clean?',
    rows: [{ col: 'DQ Severity' }],
    cols: [],
    values: [{ col: 'Session ID', fn: 'COUNTA', name: 'Sessions' }],
  },
  {
    anchor: [3, 17], size: [28, 3], title: '12. Volume by hour of day',
    question: 'Is there a daily pattern in the recorded traffic?',
    rows: [{ col: 'Session Hour' }],
    cols: [],
    values: [{ col: 'Session ID', fn: 'COUNTA', name: 'Sessions' }],
  },
  {
    anchor: [33, 17], size: [7, 6], title: '13. Cart action x conversion event',
    question: 'How is Cart Change associated with the recorded conversion event?',
    rows: [{ col: 'Cart Change' }],
    cols: [{ col: 'Conversion Event' }],
    values: [{ col: 'Session ID', fn: 'COUNTA', showAs: 'PERCENT_OF_ROW_TOTAL', name: '% of sessions' }],
  },
];

const PAGE_PIVOTS = [
  {
    anchor: [3, 1], size: [14, 7], title: '1. Page engagement by funnel stage and page',
    question: 'Which page holds attention?',
    rows: [{ col: 'Funnel Stage' }, { col: 'Page Name' }],
    cols: [],
    values: [
      { col: 'Page View ID', fn: 'COUNTA', name: 'Page views' },
      { col: 'Time on Page (s)', fn: 'AVERAGE', name: 'Avg seconds' },
      { col: 'Clicks', fn: 'AVERAGE', name: 'Avg clicks' },
      { col: 'Scrolls', fn: 'AVERAGE', name: 'Avg scrolls' },
    ],
  },
  {
    anchor: [20, 1], size: [10, 10], title: '2. Transitions: page -> next page',
    question: 'Where does a visitor go next? The empty diagonal shows no immediate self-transitions; source validation separately found no repeated page code within a session.',
    rows: [{ col: 'Page Code' }],
    cols: [{ col: 'Next Page' }],
    values: [{ col: 'Page View ID', fn: 'COUNTA', name: 'Page views' }],
  },
  {
    anchor: [32, 1], size: [10, 4], title: '3. Attention by position in the path',
    question: 'How does recorded time on page vary by path position?',
    rows: [{ col: 'Position' }],
    cols: [],
    values: [
      { col: 'Page View ID', fn: 'COUNTA', name: 'Page views' },
      { col: 'Time on Page (s)', fn: 'AVERAGE', name: 'Avg seconds' },
    ],
  },
  {
    anchor: [44, 1], size: [7, 6], title: '4. Page type x conversion outcome',
    question: 'Do sessions that reach a cart page end differently?',
    rows: [{ col: 'Page Type' }],
    cols: [{ col: 'Conversion Event' }],
    values: [{ col: 'Page View ID', fn: 'COUNTA', showAs: 'PERCENT_OF_ROW_TOTAL', name: '% of page views' }],
  },
  {
    anchor: [3, 12], size: [10, 6], title: '5. Average seconds on page by device',
    question: 'How does recorded time on page vary by device?',
    rows: [{ col: 'Page Name' }],
    cols: [{ col: 'Device Type' }],
    values: [{ col: 'Time on Page (s)', fn: 'AVERAGE', name: 'Avg seconds' }],
  },
];

// ---------------------------------------------------------------------------
// ENTRY POINTS
// ---------------------------------------------------------------------------

/** Rebuilds pivot_sessions, pivot_pages, analysis and charts. Safe to run repeatedly. */
function rebuildAnalysis() {
  const started = new Date();
  const ss = SpreadsheetApp.getActive();

  const sessions = readTable_(ANALYSIS_CONFIG.SESSIONS);
  const pageViews = readTable_(ANALYSIS_CONFIG.PAGE_VIEWS);

  const selfTest = runAnalysisSelfTest_(sessions.headers, pageViews.headers);
  if (selfTest.failed) {
    // A layout or column-name problem would produce a plausible-looking but wrong dashboard.
    throw new Error('Analysis self-test failed: ' +
      selfTest.rows.filter(function (r) { return r[3] === 'FAIL'; })
        .map(function (r) { return r[0]; }).join('; '));
  }

  buildPivots_(ANALYSIS_CONFIG.PIVOT_SESSIONS_SHEET, sessions, SESSION_PIVOTS);
  buildPivots_(ANALYSIS_CONFIG.PIVOT_PAGES_SHEET, pageViews, PAGE_PIVOTS);
  const blocks = buildAnalysisTab_(sessions, pageViews);
  buildCharts_(blocks, pageViews);

  SpreadsheetApp.flush();
  const msg = (SESSION_PIVOTS.length + PAGE_PIVOTS.length) + ' pivot tables, ' +
    Object.keys(blocks).length + ' analysis blocks, 9 charts in ' +
    Math.round((new Date() - started) / 100) / 10 + 's';
  Logger.log(msg);
  try {
    ss.toast(msg, 'Pivots and charts rebuilt', 10);
  } catch (e) {
    // no UI context (trigger run) — the log line is the result
  }
  return msg;
}

/** Shows the layout and column-resolution assertions without rebuilding anything. */
function showAnalysisSelfTest() {
  const result = runAnalysisSelfTest_(
    readTable_(ANALYSIS_CONFIG.SESSIONS).headers,
    readTable_(ANALYSIS_CONFIG.PAGE_VIEWS).headers);
  const ui = SpreadsheetApp.getUi();
  ui.alert('Analysis self-test: ' + (result.failed ? result.failed + ' FAILED' : 'all passed'),
    result.rows.map(function (r) { return r[3] + '  ' + r[0]; }).join('\n'), ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// PIVOT TABLES
// ---------------------------------------------------------------------------

/**
 * Rebuilds one tab of native pivot tables.
 * Each pivot gets a title and an explicit analytical question above it.
 */
function buildPivots_(tabName, source, specs) {
  const sheet = prepareSheet_(tabName);
  const sourceRange = source.sheet.getDataRange();

  sheet.getRange(1, 1).setValue(tabName + ' — built by analysis.gs from ' + source.name +
    '. Every table below is a live pivot table: re-group it freely, a rebuild restores this layout.')
    .setFontWeight('bold');

  specs.forEach(function (spec) {
    const row = spec.anchor[0];
    const col = spec.anchor[1];
    sheet.getRange(row - 2, col).setValue(spec.title).setFontWeight('bold');
    sheet.getRange(row - 1, col).setValue(spec.question).setFontStyle('italic')
      .setFontColor(PALETTE.steel);

    const pivot = sheet.getRange(row, col).createPivotTable(sourceRange);

    spec.rows.forEach(function (g) {
      // Totals stay on: for a nested pair (Funnel Stage > Page Name) they become stage subtotals,
      // which is exactly the read a stage grouping is for.
      pivot.addRowGroup(colIndex_(source.headers, g.col)).showTotals(true).sortAscending();
    });
    spec.cols.forEach(function (g) {
      pivot.addColumnGroup(colIndex_(source.headers, g.col)).showTotals(true).sortAscending();
    });
    spec.values.forEach(function (v) {
      const value = pivot.addPivotValue(colIndex_(source.headers, v.col),
        SpreadsheetApp.PivotTableSummarizeFunction[v.fn]);
      if (v.showAs) value.showAs(SpreadsheetApp.PivotValueDisplayType[v.showAs]);
      if (v.name) value.setDisplayName(v.name);
    });
  });

  sheet.setFrozenRows(1);
  return sheet;
}

// ---------------------------------------------------------------------------
// ANALYSIS TAB — descriptive blocks rebuilt by script; inferential results exposed as formulas
// ---------------------------------------------------------------------------

/**
 * Writes the statistical blocks and returns a registry of the ranges each chart needs.
 * The cursor advances block by block, so inserting a block never breaks the ones below it —
 * and no formula in here contains a row number that was typed by hand.
 */
function buildAnalysisTab_(sessions, pageViews) {
  const sheet = prepareSheet_(ANALYSIS_CONFIG.ANALYSIS_SHEET);
  const S = sessions.rows;
  const P = pageViews.rows;
  const sIdx = function (name) { return colIndex_(sessions.headers, name) - 1; };
  const pIdx = function (name) { return colIndex_(pageViews.headers, name) - 1; };
  const blocks = {};
  let cursor = 1;

  // -- header ---------------------------------------------------------------
  sheet.getRange(cursor, 1).setValue(
    'ANALYSIS — descriptive blocks rebuild from source; inferential results are live formulas')
    .setFontWeight('bold');
  cursor += 1;
  sheet.getRange(cursor, 1).setValue('z (two-sided 95%)');
  sheet.getRange(cursor, 2).setValue(ANALYSIS_CONFIG.Z95);
  const zRef = '$B$' + cursor;
  sheet.getRange(cursor, 3).setValue(
    'Used by every Wilson interval below. Wilson intervals provide finite-sample coverage and ' +
    'remain bounded between 0 and 1.').setFontColor(PALETTE.steel);
  cursor += ANALYSIS_CONFIG.BLOCK_GAP;

  // -- 1. purchase rate with Wilson CI, three segmentations -----------------
  const CONV = 'Conversion Event';
  const rateBlock = function (label, colName, note) {
    const groups = groupCount_(S, sIdx(colName), sIdx(CONV));
    const keys = Object.keys(groups).sort();
    cursor = sectionTitle_(sheet, cursor, 'PURCHASE RATE BY ' + label.toUpperCase(), note);
    const head = ['Segment', 'Sessions', 'Purchased', 'Purchase rate', 'CI low', 'CI high',
      'CI width, pp', 'Added to cart', 'Add-to-cart rate'];
    sheet.getRange(cursor, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    const first = cursor + 1;
    const body = keys.map(function (k) {
      const g = groups[k];
      return [k, g.total, g['Purchased'] || 0, '', '', '', '', g['Added to Cart'] || 0, ''];
    });
    sheet.getRange(first, 1, body.length, head.length).setValues(body);
    // Formulas: rate, Wilson bounds, width, add-to-cart rate.
    const formulas = body.map(function (_, i) {
      const r = first + i;
      const p = 'C' + r + '/B' + r;
      const den = '(1+' + zRef + '^2/B' + r + ')';
      const centre = '((' + p + ')+' + zRef + '^2/(2*B' + r + '))/' + den;
      const half = zRef + '*SQRT((' + p + ')*(1-(' + p + '))/B' + r + '+' + zRef +
        '^2/(4*B' + r + '^2))/' + den;
      return ['=' + p, '=' + centre + '-' + half, '=' + centre + '+' + half,
        '=(F' + r + '-E' + r + ')*100', '=H' + r + '/B' + r];
    });
    formulas.forEach(function (f, i) {
      const r = first + i;
      sheet.getRange(r, 4, 1, 3).setValues([f.slice(0, 3)]);
      sheet.getRange(r, 7).setValue(f[3]);
      sheet.getRange(r, 9).setValue(f[4]);
    });
    sheet.getRange(first, 4, body.length, 3).setNumberFormat(ANALYSIS_CONFIG.PCT_FORMAT);
    sheet.getRange(first, 7, body.length, 1).setNumberFormat('0.0');
    sheet.getRange(first, 9, body.length, 1).setNumberFormat(ANALYSIS_CONFIG.PCT_FORMAT);
    const range = { firstRow: first, lastRow: first + body.length - 1, keys: keys, groups: groups };
    cursor = first + body.length + ANALYSIS_CONFIG.BLOCK_GAP;
    return range;
  };

  blocks.rateChannel = rateBlock('traffic channel', 'Traffic Source',
    'The intervals overlap; a direct contrast test is needed before interpreting the ranking as a difference.');
  blocks.rateDevice = rateBlock('device type', 'Device Type',
    'One pairwise contrast has p<0.05; interpret it with the temporal stability check and multiple-testing caveat below.');
  blocks.rateVisitor = rateBlock('observed visitor type', 'Visitor Type',
    'New/Returning is based only on session order within this extract; the intervals overlap.');

  // -- 2. conversion mix, for the 100% stacked charts -----------------------
  const mixBlock = function (label, colName) {
    const groups = groupCount_(S, sIdx(colName), sIdx(CONV));
    const keys = Object.keys(groups).sort();
    const outcomes = ['No Conversion', 'Added to Cart', 'Purchased'];
    cursor = sectionTitle_(sheet, cursor, 'CONVERSION MIX BY ' + label.toUpperCase(),
      'Session counts. The charts stack these to 100%.');
    sheet.getRange(cursor, 1, 1, outcomes.length + 1)
      .setValues([[label].concat(outcomes)]).setFontWeight('bold');
    const first = cursor + 1;
    const body = keys.map(function (k) {
      return [k].concat(outcomes.map(function (o) { return groups[k][o] || 0; }));
    });
    sheet.getRange(first, 1, body.length, outcomes.length + 1).setValues(body);
    const range = { headerRow: cursor, firstRow: first, lastRow: first + body.length - 1,
      firstCol: 1, lastCol: outcomes.length + 1 };
    cursor = first + body.length + ANALYSIS_CONFIG.BLOCK_GAP;
    return range;
  };
  blocks.mixChannel = mixBlock('Traffic Source', 'Traffic Source');
  blocks.mixDevice = mixBlock('Device Type', 'Device Type');

  // -- 3. chi-square independence tests ------------------------------------
  const chiBlock = function (label, colName, note) {
    const groups = groupCount_(S, sIdx(colName), sIdx(CONV));
    const keys = Object.keys(groups).sort();
    const outcomes = ['No Conversion', 'Added to Cart', 'Purchased'];
    cursor = sectionTitle_(sheet, cursor, 'CHI-SQUARE: ' + label.toUpperCase() + ' x CONVERSION', note);

    const headRow = cursor;
    sheet.getRange(headRow, 1, 1, 1 + outcomes.length + 1)
      .setValues([['Observed'].concat(outcomes).concat(['Row total'])]).setFontWeight('bold');
    sheet.getRange(headRow, 7, 1, 1 + outcomes.length)
      .setValues([['Expected'].concat(outcomes)]).setFontWeight('bold');

    const first = headRow + 1;
    const obs = keys.map(function (k) {
      return [k].concat(outcomes.map(function (o) { return groups[k][o] || 0; }));
    });
    sheet.getRange(first, 1, obs.length, 1 + outcomes.length).setValues(obs);
    const last = first + obs.length - 1;
    const totalRow = last + 1;

    // row totals, column totals, grand total — all formulas so the table audits itself
    for (let i = 0; i < obs.length; i++) {
      sheet.getRange(first + i, 5).setValue('=SUM(B' + (first + i) + ':D' + (first + i) + ')');
    }
    sheet.getRange(totalRow, 1).setValue('Column total').setFontWeight('bold');
    for (let c = 2; c <= 5; c++) {
      sheet.getRange(totalRow, c).setValue(
        '=SUM(' + colLetter_(c) + first + ':' + colLetter_(c) + last + ')');
    }
    // expected = row total * column total / grand total
    for (let i = 0; i < obs.length; i++) {
      const r = first + i;
      sheet.getRange(r, 7).setValue('=A' + r);
      for (let j = 0; j < outcomes.length; j++) {
        sheet.getRange(r, 8 + j).setValue(
          '=$E' + r + '*' + colLetter_(2 + j) + '$' + totalRow + '/$E$' + totalRow);
      }
    }
    sheet.getRange(first, 8, obs.length, outcomes.length).setNumberFormat('0.0');

    const pRow = totalRow + 1;
    sheet.getRange(pRow, 1).setValue('p-value (CHISQ.TEST)').setFontWeight('bold');
    sheet.getRange(pRow, 2).setValue('=CHISQ.TEST(B' + first + ':D' + last + ',H' + first + ':J' + last + ')')
      .setNumberFormat(ANALYSIS_CONFIG.P_FORMAT);
    sheet.getRange(pRow, 3).setValue(
      '=IF(B' + pRow + '<0.05,"significant at 5% before correcting for multiple tests",' +
      '"no evidence of a difference")');
    cursor = pRow + ANALYSIS_CONFIG.BLOCK_GAP;
    return { pRow: pRow };
  };

  blocks.chiChannel = chiBlock('traffic channel', 'Traffic Source',
    'Tests whether the channel and the outcome are associated.');
  blocks.chiDevice = chiBlock('device type', 'Device Type',
    'The device result is unadjusted for multiple exploratory comparisons and should be treated as tentative.');

  // -- 4. pairwise z-test + within-sample temporal stability check ----------
  cursor = sectionTitle_(sheet, cursor, 'TWO-PROPORTION Z-TEST AND TEMPORAL STABILITY CHECK',
    'The strongest contrast in the sample is repeated inside each half of the observed period. ' +
    'This is a within-sample stability check, not out-of-sample validation.');
  const zHead = ['Comparison', 'n1', 'purchases1', 'n2', 'purchases2', 'rate1', 'rate2',
    'difference, pp', 'z', 'p-value', 'verdict'];
  sheet.getRange(cursor, 1, 1, zHead.length).setValues([zHead]).setFontWeight('bold');
  const zFirst = cursor + 1;

  /*
   * The half-year split reads the `Session Month` column rather than re-deriving it from the
   * timestamp: that column is the workbook's single definition of which month a session is in, and
   * every pivot table groups by it. Deriving a second answer here is how a replication test ends up
   * disagreeing with the pivot beside it.
   */
  const isH1 = function (row) {
    return monthKey_(row[sIdx('Session Month')]) <= ANALYSIS_CONFIG.H1_LAST_MONTH;
  };
  const pick = function (filter) {
    let n = 0, k = 0;
    S.forEach(function (row) {
      if (!filter(row)) return;
      n += 1;
      if (str_(row[sIdx(CONV)]) === 'Purchased') k += 1;
    });
    return [n, k];
  };
  const dev = function (row) { return str_(row[sIdx('Device Type')]); };
  const comparisons = [
    ['Mobile vs Tablet, whole period'].concat(pick(function (r) { return dev(r) === 'Mobile'; }))
      .concat(pick(function (r) { return dev(r) === 'Tablet'; })),
    ['Tablet vs other devices, whole period'].concat(pick(function (r) { return dev(r) === 'Tablet'; }))
      .concat(pick(function (r) { return dev(r) !== 'Tablet'; })),
    ['Tablet vs other devices, first half'].concat(pick(function (r) { return dev(r) === 'Tablet' && isH1(r); }))
      .concat(pick(function (r) { return dev(r) !== 'Tablet' && isH1(r); })),
    ['Tablet vs other devices, second half'].concat(pick(function (r) { return dev(r) === 'Tablet' && !isH1(r); }))
      .concat(pick(function (r) { return dev(r) !== 'Tablet' && !isH1(r); })),
  ];
  sheet.getRange(zFirst, 1, comparisons.length, 5).setValues(comparisons);
  comparisons.forEach(function (_, i) {
    const r = zFirst + i;
    const p1 = 'C' + r + '/B' + r;
    const p2 = 'E' + r + '/D' + r;
    const pooled = '(C' + r + '+E' + r + ')/(B' + r + '+D' + r + ')';
    sheet.getRange(r, 6).setValue('=' + p1);
    sheet.getRange(r, 7).setValue('=' + p2);
    sheet.getRange(r, 8).setValue('=(F' + r + '-G' + r + ')*100');
    sheet.getRange(r, 9).setValue('=(' + p1 + '-' + p2 + ')/SQRT((' + pooled + ')*(1-(' + pooled +
      '))*(1/B' + r + '+1/D' + r + '))');
    sheet.getRange(r, 10).setValue('=2*(1-NORM.S.DIST(ABS(I' + r + '),TRUE))');
    sheet.getRange(r, 11).setValue('=IF(J' + r + '<0.05,"p < 0.05 (unadjusted)","p >= 0.05")');
  });
  sheet.getRange(zFirst, 6, comparisons.length, 2).setNumberFormat(ANALYSIS_CONFIG.PCT_FORMAT);
  sheet.getRange(zFirst, 8, comparisons.length, 1).setNumberFormat('+0.0;-0.0');
  sheet.getRange(zFirst, 9, comparisons.length, 1).setNumberFormat('0.00');
  sheet.getRange(zFirst, 10, comparisons.length, 1).setNumberFormat(ANALYSIS_CONFIG.P_FORMAT);
  cursor = zFirst + comparisons.length + ANALYSIS_CONFIG.BLOCK_GAP;

  // -- 5. correlations ------------------------------------------------------
  cursor = sectionTitle_(sheet, cursor, 'CORRELATIONS',
    'CORREL measures linear association, not causality. Depth and total time are mechanically linked; ' +
    'average time per page reduces that link.');
  const pvRange = function (name) {
    const c = colLetter_(colIndex_(pageViews.headers, name));
    return ANALYSIS_CONFIG.PAGE_VIEWS + '!' + c + '2:' + c + (P.length + 1);
  };
  const seRange = function (name) {
    const c = colLetter_(colIndex_(sessions.headers, name));
    return ANALYSIS_CONFIG.SESSIONS + '!' + c + '2:' + c + (S.length + 1);
  };
  const corrHead = ['Pair', 'Grain', 'Correlation', 'Reading'];
  sheet.getRange(cursor, 1, 1, corrHead.length).setValues([corrHead]).setFontWeight('bold');
  const corrFirst = cursor + 1;
  const corrRows = [
    ['Clicks vs time on page', 'page view', pvRange('Clicks'), pvRange('Time on Page (s)'),
      'No material linear association is visible in this sample.'],
    ['Scrolls vs time on page', 'page view', pvRange('Scrolls'), pvRange('Time on Page (s)'),
      'No material linear association is visible in this sample.'],
    ['Clicks vs scrolls', 'page view', pvRange('Clicks'), pvRange('Scrolls'),
      'No material linear association is visible in this sample.'],
    ['Page count vs total session time', 'session', seRange('Page Count'), seRange('Total Time (s)'),
      'This relationship is partly mechanical because total time sums page-level durations.'],
    ['Page count vs avg time per page', 'session', seRange('Page Count'), seRange('Avg Time per Page (s)'),
      'Average time per page removes the mechanical summation effect.'],
    ['Purchase value vs total clicks', 'session', seRange('Purchase Value'), seRange('Total Clicks'),
      'No material linear association with the recorded amount is visible.'],
    ['Purchase value vs page count', 'session', seRange('Purchase Value'), seRange('Page Count'),
      'No material linear association with session depth is visible.'],
    ['Purchase value vs total time', 'session', seRange('Purchase Value'), seRange('Total Time (s)'),
      'No material linear association with total session time is visible.'],
  ];
  sheet.getRange(corrFirst, 1, corrRows.length, 2)
    .setValues(corrRows.map(function (r) { return [r[0], r[1]]; }));
  corrRows.forEach(function (r, i) {
    sheet.getRange(corrFirst + i, 3).setValue('=CORREL(' + r[2] + ',' + r[3] + ')');
    sheet.getRange(corrFirst + i, 4).setValue(r[4]);
  });
  sheet.getRange(corrFirst, 3, corrRows.length, 1).setNumberFormat(ANALYSIS_CONFIG.CORR_FORMAT);
  cursor = corrFirst + corrRows.length + ANALYSIS_CONFIG.BLOCK_GAP;

  // -- 6. uniformity goodness of fit ---------------------------------------
  cursor = sectionTitle_(sheet, cursor, 'ARE THE RAW METRICS UNIFORM?',
    'The observed distributions are unusually flat. Counts come from the script; expected values and the ' +
    'p-value are formulas.');
  const uniform = function (label, values, min, max) {
    const counts = {};
    for (let v = min; v <= max; v++) counts[v] = 0;
    values.forEach(function (v) { if (v >= min && v <= max) counts[v] += 1; });
    sheet.getRange(cursor, 1).setValue(label).setFontWeight('bold');
    const headRow = cursor + 1;
    sheet.getRange(headRow, 1, 1, 3).setValues([['Value', 'Observed', 'Expected']])
      .setFontWeight('bold');
    const first = headRow + 1;
    const body = [];
    for (let v = min; v <= max; v++) body.push([v, counts[v], '']);
    sheet.getRange(first, 1, body.length, 3).setValues(body);
    const last = first + body.length - 1;
    for (let i = 0; i < body.length; i++) {
      sheet.getRange(first + i, 3).setValue('=SUM($B$' + first + ':$B$' + last + ')/' + body.length);
    }
    sheet.getRange(first, 3, body.length, 1).setNumberFormat('0.0');
    const pRow = last + 1;
    sheet.getRange(pRow, 1).setValue('p-value (uniform?)').setFontWeight('bold');
    sheet.getRange(pRow, 2).setValue('=CHISQ.TEST(B' + first + ':B' + last + ',C' + first + ':C' + last + ')')
      .setNumberFormat(ANALYSIS_CONFIG.P_FORMAT);
    sheet.getRange(pRow, 3).setValue('=IF(B' + pRow + '>0.05,"no evidence against uniformity at alpha=0.05",' +
      '"evidence against uniformity at alpha=0.05")');
    cursor = pRow + ANALYSIS_CONFIG.BLOCK_GAP;
    return { firstRow: first, lastRow: last, pRow: pRow };
  };
  blocks.uniformClicks = uniform('Clicks per page view', column_(P, pIdx('Clicks')), 1, 10);
  blocks.uniformScrolls = uniform('Scrolls per page view', column_(P, pIdx('Scrolls')), 1, 15);

  // -- 7. the three revenue rules ------------------------------------------
  cursor = sectionTitle_(sheet, cursor, 'REVENUE SENSITIVITY TO EVENT/VALUE RULES',
    'Purchase Value conflicts with Conversion Event, so the workbook reports three explicit interpretations. ' +
    'All three are SUMIF formulas over `sessions`.');
  const convCol = colLetter_(colIndex_(sessions.headers, CONV));
  const valCol = colLetter_(colIndex_(sessions.headers, 'Purchase Value'));
  const lastRowS = S.length + 1;
  const convRange = ANALYSIS_CONFIG.SESSIONS + '!' + convCol + '2:' + convCol + lastRowS;
  const valRange = ANALYSIS_CONFIG.SESSIONS + '!' + valCol + '2:' + valCol + lastRowS;
  sheet.getRange(cursor, 1, 1, 4)
    .setValues([['Rule', 'Recorded value', 'Sessions counted', 'What it assumes']]).setFontWeight('bold');
  const revFirst = cursor + 1;
  const revRules = [
    ['A. Only sessions marked Purchased',
      '=SUMIF(' + convRange + ',"Purchased",' + valRange + ')',
      '=COUNTIF(' + convRange + ',"Purchased")',
      'Assumes Conversion Event is authoritative; zero-valued purchase records contribute 0.'],
    ['B. Purchased and Added to Cart',
      '=SUMIF(' + convRange + ',"Purchased",' + valRange + ')+SUMIF(' + convRange +
        ',"Added to Cart",' + valRange + ')',
      '=COUNTIF(' + convRange + ',"Purchased")+COUNTIF(' + convRange + ',"Added to Cart")',
      'Assumes positive value on Added to Cart can be counted; this cannot be validated from the available fields.'],
    ['C. Every non-zero value, whatever the event',
      '=SUM(' + valRange + ')',
      '=COUNTIF(' + valRange + ',">0")',
      'Assumes Purchase Value is authoritative; sessions not marked Purchased still contribute recorded value.'],
  ];
  sheet.getRange(revFirst, 1, revRules.length, 4).setValues(revRules);
  sheet.getRange(revFirst, 2, revRules.length, 1).setNumberFormat(ANALYSIS_CONFIG.MONEY_FORMAT);
  const revSpread = revFirst + revRules.length;
  sheet.getRange(revSpread, 1).setValue('Spread between the widest pair').setFontWeight('bold');
  sheet.getRange(revSpread, 2).setValue('=MAX(B' + revFirst + ':B' + (revFirst + 2) + ')/MIN(B' +
    revFirst + ':B' + (revFirst + 2) + ')').setNumberFormat('0.0"x"');
  blocks.revenue = { headerRow: cursor, firstRow: revFirst, lastRow: revFirst + revRules.length - 1 };
  cursor = revSpread + ANALYSIS_CONFIG.BLOCK_GAP;

  // -- 8. chart-source series ----------------------------------------------
  const series = function (key, title, note, header, rows, formats) {
    cursor = sectionTitle_(sheet, cursor, title, note);
    sheet.getRange(cursor, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    const first = cursor + 1;
    sheet.getRange(first, 1, rows.length, header.length).setValues(rows);
    (formats || []).forEach(function (f) {
      sheet.getRange(first, f.col, rows.length, 1).setNumberFormat(f.format);
    });
    blocks[key] = { headerRow: cursor, firstRow: first, lastRow: first + rows.length - 1,
      lastCol: header.length };
    cursor = first + rows.length + ANALYSIS_CONFIG.BLOCK_GAP;
  };

  // monthly volume — keyed off the same `Session Month` column every month pivot groups by
  const monthly = {};
  S.forEach(function (row) {
    const key = monthKey_(row[sIdx('Session Month')]) || '(no timestamp)';
    if (!monthly[key]) monthly[key] = { n: 0, value: 0 };
    monthly[key].n += 1;
    monthly[key].value += Number(row[sIdx('Purchase Value')]) || 0;
  });
  const monthCol = colLetter_(colIndex_(sessions.headers, 'Session Month'));
  series('monthly', 'VOLUME BY MONTH',
    'The monthly series has no obvious pattern. Campaign and launch metadata are unavailable. ' +
    'The last column re-counts the same months with COUNTIF from the `sessions` tab so any future ' +
    'definition drift is visible.',
    ['Month', 'Sessions', 'Recorded value', 'Cross-check (COUNTIF)'],
    Object.keys(monthly).sort().map(function (k) { return [k, monthly[k].n, monthly[k].value, '']; }),
    [{ col: 3, format: ANALYSIS_CONFIG.MONEY_FORMAT }]);
  for (let i = blocks.monthly.firstRow; i <= blocks.monthly.lastRow; i++) {
    sheet.getRange(i, 4).setValue('=COUNTIF(' + ANALYSIS_CONFIG.SESSIONS + '!$' + monthCol +
      '$2:$' + monthCol + '$' + (S.length + 1) + ',A' + i + ')');
  }

  // hourly volume
  const hourly = {};
  for (let h = 0; h < 24; h++) hourly[h] = 0;
  S.forEach(function (row) {
    const h = Number(row[sIdx('Session Hour')]);
    if (h >= 0 && h < 24) hourly[h] += 1;
  });
  series('hourly', 'VOLUME BY HOUR OF DAY',
    'The recorded daily distribution is unusually flat and warrants a tracking review.',
    ['Hour', 'Sessions'],
    Object.keys(hourly).map(function (h) { return [Number(h), hourly[h]]; }));

  // depth distribution + purchase rate per depth
  const depth = groupCount_(S, sIdx('Page Count'), sIdx(CONV));
  series('depth', 'SESSION DEPTH',
    'Pages per session, and the purchase rate at each depth.',
    ['Pages in session', 'Sessions', 'Purchase rate'],
    Object.keys(depth).sort(function (a, b) { return Number(a) - Number(b); }).map(function (k) {
      return [Number(k), depth[k].total, (depth[k]['Purchased'] || 0) / depth[k].total];
    }),
    [{ col: 3, format: ANALYSIS_CONFIG.PCT_FORMAT }]);

  // page-level engagement + reach + exit rate
  const pages = {};
  const sessionsTouching = {};
  P.forEach(function (row) {
    const code = str_(row[pIdx('Page Code')]);
    const name = str_(row[pIdx('Page Name')]);
    if (!pages[code]) pages[code] = { name: name, views: 0, time: 0, clicks: 0, scrolls: 0, exits: 0 };
    const e = pages[code];
    e.views += 1;
    e.time += Number(row[pIdx('Time on Page (s)')]) || 0;
    e.clicks += Number(row[pIdx('Clicks')]) || 0;
    e.scrolls += Number(row[pIdx('Scrolls')]) || 0;
    if (isTrue_(row[pIdx('Is Exit')])) e.exits += 1;
    const key = code + '|' + str_(row[pIdx('Session ID')]);
    if (!sessionsTouching[key]) {
      sessionsTouching[key] = true;
      e.reach = (e.reach || 0) + 1;
    }
  });
  series('pages', 'PAGE REACH AND ATTENTION',
    'Reach, not a funnel: paths preserve order but do not follow a canonical stage sequence. ' +
    'Exit rate is exits divided by views of that page. Compare page views with sessions reached; ' +
    'equality in this snapshot indicates no repeated page code within a session.',
    ['Page', 'Page views', 'Sessions reaching it', 'Reach % of sessions', 'Avg seconds',
      'Avg clicks', 'Avg scrolls', 'Exit rate'],
    Object.keys(pages).sort().map(function (code) {
      const e = pages[code];
      return [e.name, e.views, e.reach, e.reach / S.length, e.time / e.views,
        e.clicks / e.views, e.scrolls / e.views, e.exits / e.views];
    }),
    [{ col: 4, format: ANALYSIS_CONFIG.PCT_FORMAT }, { col: 5, format: '0.0' },
     { col: 6, format: '0.00' }, { col: 7, format: '0.00' },
     { col: 8, format: ANALYSIS_CONFIG.PCT_FORMAT }]);

  // data-quality findings, sorted worst first
  const flags = {};
  S.forEach(function (row) {
    str_(row[sIdx('DQ Flags')]).split(';').forEach(function (f) {
      const name = str_(f);
      if (name) flags[name] = (flags[name] || 0) + 1;
    });
  });
  series('dq', 'DATA-QUALITY FINDINGS BY SHARE OF SESSIONS',
    'Sorted worst first. High-share flags indicate tracking or data-contract issues rather than ' +
    'isolated row repairs.',
    ['Finding', 'Sessions affected', 'Share of sessions'],
    Object.keys(flags).sort(function (a, b) { return flags[b] - flags[a]; }).map(function (k) {
      return [k, flags[k], flags[k] / S.length];
    }),
    [{ col: 3, format: ANALYSIS_CONFIG.PCT_FORMAT }]);

  // geography contingency, with the match rate
  const geo = {};
  const cities = {};
  S.forEach(function (row) {
    const c = str_(row[sIdx('Country')]);
    const city = str_(row[sIdx('City')]);
    cities[city] = true;
    if (!geo[c]) geo[c] = {};
    geo[c][city] = (geo[c][city] || 0) + 1;
  });
  const cityList = Object.keys(cities).sort();
  const geoRows = Object.keys(geo).sort().map(function (c) {
    return [c].concat(cityList.map(function (city) { return geo[c][city] || 0; }));
  });
  series('geo', 'COUNTRY x CITY',
    'Country-city pairings are diffuse relative to the supplied lookup, so geography is excluded from segmentation.',
    ['Country'].concat(cityList), geoRows);
  const geoP = blocks.geo.lastRow + 1;
  sheet.getRange(geoP, 1).setValue('Sessions where the city is in the stated country')
    .setFontWeight('bold');
  const geoConsistentCol = colLetter_(colIndex_(sessions.headers, 'Geo Consistent'));
  sheet.getRange(geoP, 2).setValue('=COUNTIF(' + ANALYSIS_CONFIG.SESSIONS + '!' +
    geoConsistentCol + '2:' + geoConsistentCol + lastRowS + ',TRUE)');
  sheet.getRange(geoP, 3).setValue('=B' + geoP + '/' + S.length)
    .setNumberFormat(ANALYSIS_CONFIG.PCT_FORMAT);
  sheet.getRange(geoP, 4).setValue('with five mapped pairs, the independence baseline is 20%');
  cursor = geoP + ANALYSIS_CONFIG.BLOCK_GAP;

  sheet.setColumnWidth(1, 300);
  sheet.setColumnWidth(4, 260);
  sheet.setFrozenRows(1);
  return blocks;
}

// ---------------------------------------------------------------------------
// CHARTS
// ---------------------------------------------------------------------------

/**
 * Nine charts on their own tab, each anchored to a fixed cell so the tab reads like a dashboard.
 * Type-specific builders (asColumnChart etc.) are used instead of Charts.ChartType so the file has
 * no dependency on the legacy Charts service.
 */
function buildCharts_(blocks, pageViews) {
  const sheet = prepareSheet_(ANALYSIS_CONFIG.CHARTS_SHEET);
  const analysis = SpreadsheetApp.getActive().getSheetByName(ANALYSIS_CONFIG.ANALYSIS_SHEET);
  const pv = pageViews.sheet;

  sheet.getRange(1, 1).setValue(
    'CHARTS — built by analysis.gs from the `analysis` tab. Each chart states what it shows ' +
    'and gives a concise interpretation.').setFontWeight('bold');

  const at = function (block, firstCol, lastCol, withHeader) {
    return analysis.getRange(block.headerRow ? (withHeader ? block.headerRow : block.firstRow) : block.firstRow,
      firstCol, (block.lastRow - (withHeader && block.headerRow ? block.headerRow : block.firstRow) + 1),
      lastCol - firstCol + 1);
  };

  const place = function (builder, row, col, title, subtitle) {
    sheet.getRange(row - 1, col).setValue(subtitle).setFontStyle('italic')
      .setFontColor(PALETTE.steel);
    const chart = builder
      .setOption('title', title)
      .setOption('titleTextStyle', { color: PALETTE.charcoal, fontSize: 14, bold: true })
      .setOption('fontName', 'Arial')
      .setOption('legend', { position: 'bottom' })
      .setOption('width', 620)
      .setOption('height', 340)
      .setPosition(row, col, 0, 0)
      .build();
    sheet.insertChart(chart);
  };

  // 1. conversion mix by channel, stacked to 100%
  place(sheet.newChart().asColumnChart()
    .addRange(at(blocks.mixChannel, 1, blocks.mixChannel.lastCol, true))
    .setNumHeaders(1)
    .setOption('isStacked', 'percent')
    .setOption('colors', [PALETTE.paleBlue, PALETTE.steel, PALETTE.gold]),
    4, 1, 'Conversion mix by traffic channel',
    'Channel conversion mixes are similar; statistical results are in the analysis tab.');

  // 2. conversion mix by device
  place(sheet.newChart().asColumnChart()
    .addRange(at(blocks.mixDevice, 1, blocks.mixDevice.lastCol, true))
    .setNumHeaders(1)
    .setOption('isStacked', 'percent')
    .setOption('colors', [PALETTE.paleBlue, PALETTE.steel, PALETTE.gold]),
    4, 12, 'Conversion mix by device type',
    'Tablet has the smallest purchased share; uncertainty and temporal stability are shown in the analysis tab.');

  /*
   * 3. purchase rate by device, with the interval bounds as their own bars.
   * Sheets has no error bars on a column chart, so the three series are ordered low - estimate -
   * high deliberately: each device reads as a rising triplet whose outer bars are the interval.
   * The ranges are added one column at a time to force that order, since the block stores the
   * estimate in D and the bounds in E and F.
   */
  const devRows = blocks.rateDevice.lastRow - blocks.rateDevice.firstRow + 1;
  place(sheet.newChart().asColumnChart()
    .addRange(analysis.getRange(blocks.rateDevice.firstRow, 1, devRows, 1))   // device name
    .addRange(analysis.getRange(blocks.rateDevice.firstRow, 5, devRows, 1))   // CI low
    .addRange(analysis.getRange(blocks.rateDevice.firstRow, 4, devRows, 1))   // purchase rate
    .addRange(analysis.getRange(blocks.rateDevice.firstRow, 6, devRows, 1))   // CI high
    .setOption('colors', [PALETTE.paleBlue, PALETTE.navy, PALETTE.paleBlue])
    .setOption('vAxis', { format: 'percent', title: 'purchase rate' }),
    22, 1, 'Purchase rate by device, with 95% interval bounds',
    'The 95% intervals overlap, so the device ranking is uncertain.');

  // 4. page reach and attention
  place(sheet.newChart().asComboChart()
    .addRange(analysis.getRange(blocks.pages.firstRow, 1,
      blocks.pages.lastRow - blocks.pages.firstRow + 1, 1))
    .addRange(analysis.getRange(blocks.pages.firstRow, 2,
      blocks.pages.lastRow - blocks.pages.firstRow + 1, 1))
    .addRange(analysis.getRange(blocks.pages.firstRow, 5,
      blocks.pages.lastRow - blocks.pages.firstRow + 1, 1))
    .setOption('seriesType', 'bars')
    .setOption('series', { 1: { type: 'line', targetAxisIndex: 1 } })
    .setOption('colors', [PALETTE.navy, PALETTE.gold]),
    22, 12, 'Page views and average seconds per page',
    'Page-view volume and average time are similar across pages; funnel interpretation is limited by non-canonical paths.');

  // 5. volume by month
  place(sheet.newChart().asLineChart()
    .addRange(at(blocks.monthly, 1, 2, true))
    .setNumHeaders(1)
    .setOption('colors', [PALETTE.navy])
    .setOption('pointSize', 5),
    40, 1, 'Sessions by month',
    'No pronounced month-to-month pattern is visible within the single observed year.');

  // 6. volume by hour
  place(sheet.newChart().asColumnChart()
    .addRange(at(blocks.hourly, 1, 2, true))
    .setNumHeaders(1)
    .setOption('colors', [PALETTE.steel])
    .setOption('hAxis', { title: 'hour of day' }),
    40, 12, 'Sessions by hour of day',
    'The observed hourly distribution is unusually flat and should be validated against tracking logs.');

  // 7. session depth
  place(sheet.newChart().asColumnChart()
    .addRange(at(blocks.depth, 1, 2, true))
    .setNumHeaders(1)
    .setOption('colors', [PALETTE.navy])
    .setOption('hAxis', { title: 'pages in session' }),
    58, 1, 'Sessions by depth',
    'One to six pages have near-equal counts; observed depth is unusually even.');

  // 8. clicks vs time on page — 3500 points, straight from the fact table
  const clicksCol = colLetter_(colIndex_(pageViews.headers, 'Clicks'));
  const timeCol = colLetter_(colIndex_(pageViews.headers, 'Time on Page (s)'));
  const lastPv = pageViews.rows.length + 1;
  place(sheet.newChart().asScatterChart()
    .addRange(pv.getRange(clicksCol + '2:' + clicksCol + lastPv))
    .addRange(pv.getRange(timeCol + '2:' + timeCol + lastPv))
    .setOption('colors', [PALETTE.warn])
    .setOption('pointSize', 2)
    .setOption('legend', { position: 'none' })
    .setOption('hAxis', { title: 'clicks on the page' })
    .setOption('vAxis', { title: 'seconds on the page' }),
    58, 12, 'Clicks against seconds, per page view',
    'Almost no linear correlation is visible in this snapshot; see the analysis tab for the exact coefficient.');

  // 9. data-quality findings
  place(sheet.newChart().asBarChart()
    .addRange(analysis.getRange(blocks.dq.firstRow, 1,
      blocks.dq.lastRow - blocks.dq.firstRow + 1, 1))
    .addRange(analysis.getRange(blocks.dq.firstRow, 3,
      blocks.dq.lastRow - blocks.dq.firstRow + 1, 1))
    .setOption('colors', [PALETTE.warn])
    .setOption('legend', { position: 'none' })
    .setOption('hAxis', { format: 'percent' })
    .setOption('height', 420),
    76, 1, 'Data-quality findings, share of sessions affected',
    'High-share flags indicate tracking or data-contract issues rather than isolated row repairs.');

  return sheet;
}

// ---------------------------------------------------------------------------
// SHEET AND RANGE HELPERS
// ---------------------------------------------------------------------------

/** Reads a table and returns {sheet, name, headers, rows}. Throws if the tab is missing. */
function readTable_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) {
    throw new Error('Tab "' + name + '" not found. Run "Rebuild all" from normalize.gs first.');
  }
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) throw new Error('Tab "' + name + '" has no data rows.');
  return {
    sheet: sheet,
    name: name,
    headers: values[0].map(function (h) { return str_(h); }),
    rows: values.slice(1),
  };
}

/**
 * 1-based column index by header name. Throws rather than returning 0, because a pivot built on
 * the wrong column produces a chart that looks fine and says something false.
 */
function colIndex_(headers, name) {
  const i = headers.indexOf(name);
  if (i === -1) {
    throw new Error('Column "' + name + '" not found. Available: ' + headers.join(', '));
  }
  return i + 1;
}

/** 1 -> A, 27 -> AA. */
function colLetter_(index) {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Creates or clears an output tab, dropping the pivots and charts a previous run left behind. */
function prepareSheet_(name) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.getCharts().forEach(function (c) { sheet.removeChart(c); });
  sheet.getPivotTables().forEach(function (p) { p.remove(); });
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.clearConditionalFormatRules();
  sheet.clear();
  return sheet;
}

/** Writes a section title plus its explanatory line, and returns the next free row. */
function sectionTitle_(sheet, row, title, note) {
  sheet.getRange(row, 1).setValue(title).setFontWeight('bold').setFontColor(PALETTE.navy);
  if (note) {
    sheet.getRange(row + 1, 1).setValue(note).setFontStyle('italic').setFontColor(PALETTE.steel);
    return row + 2;
  }
  return row + 1;
}

// ---------------------------------------------------------------------------
// AGGREGATION HELPERS
// ---------------------------------------------------------------------------

/** { groupValue: { outcome: n, total: n } } for a pair of column indexes. */
function groupCount_(rows, groupCol, outcomeCol) {
  const out = {};
  rows.forEach(function (row) {
    const key = str_(row[groupCol]);
    const outcome = str_(row[outcomeCol]);
    if (!out[key]) out[key] = { total: 0 };
    out[key].total += 1;
    out[key][outcome] = (out[key][outcome] || 0) + 1;
  });
  return out;
}

function column_(rows, index) {
  return rows.map(function (row) { return Number(row[index]); })
    .filter(function (v) { return !isNaN(v); });
}

/**
 * 'yyyy-MM' from a Date, or from whatever the cell holds if it is not a Date.
 *
 * MUST format in the SPREADSHEET's time zone, not the script project's.
 * A Date from getValues() is an instant; `getMonth()` renders it in the script's zone, while
 * normalize.gs writes `Session Month` / `Session Hour` / `Session Weekday` with
 * Utilities.formatDate in the spreadsheet's zone. This workbook's two zones differ by more than
 * eight hours (the copy inherited the source file's zone), and 26 of the 1,000 sessions sit within
 * three hours of a month boundary — so the naive version put 12 sessions in the wrong month and
 * made the monthly chart disagree with the pivot table built on the same column.
 * In this workbook, ten of twelve months differed by one or two sessions under the naive approach.
 */
function monthKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, getTimeZone_(), 'yyyy-MM');
  }
  const text = str_(value);
  return text.length >= 7 ? text.slice(0, 7) : text;
}

/** Sheets booleans arrive as true/false, but an imported copy can hold the strings. */
function isTrue_(value) {
  return value === true || value === 'TRUE' || value === 'true' || value === 1;
}

// ---------------------------------------------------------------------------
// SELF-TEST — layout and column resolution, before anything is written
// ---------------------------------------------------------------------------

/**
 * Asserts that every column a pivot references exists, that no two pivots overlap, and that the
 * small helpers behave. Layout collisions and renamed columns are the two failure modes that
 * produce a dashboard which looks built but is wrong.
 */
function runAnalysisSelfTest_(sessionHeaders, pageHeaders) {
  const rows = [];
  let failed = 0;
  const check = function (name, expected, actual) {
    const exp = JSON.stringify(expected);
    const act = JSON.stringify(actual);
    const pass = exp === act;
    if (!pass) failed += 1;
    rows.push([name, exp, act, pass ? 'PASS' : 'FAIL']);
  };

  check('colLetter_ 1', 'A', colLetter_(1));
  check('colLetter_ 26', 'Z', colLetter_(26));
  check('colLetter_ 27', 'AA', colLetter_(27));
  check('colLetter_ 37', 'AK', colLetter_(37));
  check('monthKey_ from Date', '2023-07', monthKey_(new Date(2023, 6, 13)));
  check('monthKey_ from text', '2023-12', monthKey_('2023-12-10 15:48:06'));
  check('isTrue_ boolean', true, isTrue_(true));
  check('isTrue_ string', true, isTrue_('TRUE'));
  check('isTrue_ false', false, isTrue_(''));

  // every referenced column must exist
  const missing = function (specs, headers) {
    const names = [];
    specs.forEach(function (s) {
      s.rows.concat(s.cols).forEach(function (g) { names.push(g.col); });
      s.values.forEach(function (v) { names.push(v.col); });
    });
    return uniq_(names).filter(function (n) { return headers.indexOf(n) === -1; });
  };
  check('session pivots reference existing columns', [], missing(SESSION_PIVOTS, sessionHeaders));
  check('page pivots reference existing columns', [], missing(PAGE_PIVOTS, pageHeaders));

  // columns the analysis tab needs directly
  const needSessions = ['Session Timestamp', 'Session Hour', 'Conversion Event', 'Purchase Value',
    'Device Type', 'Traffic Source', 'Visitor Type', 'Page Count', 'Country', 'City',
    'Geo Consistent', 'Total Time (s)', 'Total Clicks', 'Avg Time per Page (s)', 'DQ Flags'];
  const needPages = ['Clicks', 'Scrolls', 'Time on Page (s)', 'Page Code', 'Page Name',
    'Session ID', 'Is Exit'];
  check('analysis tab session columns exist', [],
    needSessions.filter(function (n) { return sessionHeaders.indexOf(n) === -1; }));
  check('analysis tab page columns exist', [],
    needPages.filter(function (n) { return pageHeaders.indexOf(n) === -1; }));

  // no two pivots may overlap: Sheets throws when a pivot is created over another one
  const overlaps = function (specs) {
    const bad = [];
    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        const a = specs[i], b = specs[j];
        // the reserved box starts two rows above the anchor, where the title is written
        const aTop = a.anchor[0] - 2, aBottom = a.anchor[0] + a.size[0] - 1;
        const bTop = b.anchor[0] - 2, bBottom = b.anchor[0] + b.size[0] - 1;
        const aLeft = a.anchor[1], aRight = a.anchor[1] + a.size[1] - 1;
        const bLeft = b.anchor[1], bRight = b.anchor[1] + b.size[1] - 1;
        if (aTop <= bBottom && bTop <= aBottom && aLeft <= bRight && bLeft <= aRight) {
          bad.push(a.title.split('.')[0] + '/' + b.title.split('.')[0]);
        }
      }
    }
    return bad;
  };
  check('session pivot layout has no overlaps', [], overlaps(SESSION_PIVOTS));
  check('page pivot layout has no overlaps', [], overlaps(PAGE_PIVOTS));

  // the enum names in the specs must exist on the SpreadsheetApp enums
  const badFn = [];
  const badShowAs = [];
  SESSION_PIVOTS.concat(PAGE_PIVOTS).forEach(function (s) {
    s.values.forEach(function (v) {
      if (!SpreadsheetApp.PivotTableSummarizeFunction[v.fn]) badFn.push(v.fn);
      if (v.showAs && !SpreadsheetApp.PivotValueDisplayType[v.showAs]) badShowAs.push(v.showAs);
    });
  });
  check('summarize functions are valid enum names', [], uniq_(badFn));
  check('display types are valid enum names', [], uniq_(badShowAs));

  return { rows: rows, failed: failed };
}
