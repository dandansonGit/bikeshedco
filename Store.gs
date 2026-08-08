// ============================================================
// BSC Production Hub — State store
// The ONE place that touches the state spreadsheet.
//
// Guarantees the old apps didn't have:
//   • Header-keyed reads AND writes — column order never matters.
//   • LockService around every read-modify-write.
//   • Explicit clear semantics: in an update payload,
//       value === null  → cell is cleared to ''
//       key absent      → cell left untouched
//   • Idempotent schema migration: missing tabs/columns are appended,
//     nothing is ever deleted or reordered.
// ============================================================

// ── Spreadsheet / tab access ─────────────────────────────────

// Opening the spreadsheet costs ~300-500ms (Properties + openById) and a
// single request reads several tabs — memoise the handle per execution.
// (Perf pass 2026-07-17: each tab read was independently re-opening.)
var SS_MEMO_ = null;

function openStateSpreadsheet_() {
  if (SS_MEMO_) return SS_MEMO_;
  var props = PropertiesService.getScriptProperties();
  var ssId  = props.getProperty('STATE_SS_ID');

  if (ssId) {
    try { return (SS_MEMO_ = SpreadsheetApp.openById(ssId)); }
    catch (e) { props.deleteProperty('STATE_SS_ID'); }
  }

  // First-run fallback: find by name, then pin the ID so a rename or
  // duplicate can never silently repoint us.
  var files = DriveApp.searchFiles(
    'title = "' + CONFIG.STATE_SHEET_NAME +
    '" and mimeType = "application/vnd.google-apps.spreadsheet" and trashed = false'
  );
  var ss = files.hasNext() ? SpreadsheetApp.open(files.next())
                           : SpreadsheetApp.create(CONFIG.STATE_SHEET_NAME);
  props.setProperty('STATE_SS_ID', ss.getId());
  SS_MEMO_ = ss;
  return ss;
}

var TAB_SCHEMAS_ = null;
function tabSchemas_() {
  if (!TAB_SCHEMAS_) {
    TAB_SCHEMAS_ = {};
    TAB_SCHEMAS_[CONFIG.TABS.jobs]     = CONFIG.JOBS_HEADERS;
    TAB_SCHEMAS_[CONFIG.TABS.dispatch] = CONFIG.DISPATCH_HEADERS;
    TAB_SCHEMAS_[CONFIG.TABS.geo]      = CONFIG.GEO_HEADERS;
    TAB_SCHEMAS_[CONFIG.TABS.dayNotes] = CONFIG.DAY_NOTES_HEADERS;
    TAB_SCHEMAS_[CONFIG.TABS.archive]  = CONFIG.ARCHIVE_HEADERS;
    TAB_SCHEMAS_[CONFIG.TABS.reports]  = CONFIG.INSTALL_REPORT_HEADERS;
    TAB_SCHEMAS_[CONFIG.TABS.dayTasks] = CONFIG.DAY_TASKS_HEADERS;
    TAB_SCHEMAS_[CONFIG.TABS.worklog]  = CONFIG.WORKLOG_HEADERS;
    TAB_SCHEMAS_[CONFIG.TABS.feedback] = CONFIG.FEEDBACK_HEADERS;
  }
  return TAB_SCHEMAS_;
}

// Returns the sheet for a tab, creating it and appending any missing
// schema headers (at the end — never reordering existing columns).
// The handle AND the schema check are memoised per execution — the
// header comparison costs a range read and can't change mid-request.
var TAB_MEMO_ = {};

function getTab_(tabName) {
  if (TAB_MEMO_[tabName]) return TAB_MEMO_[tabName];
  var ss    = openStateSpreadsheet_();
  var sheet = ss.getSheetByName(tabName);

  if (!sheet) {
    // Legacy: the Jobs tab may exist as the original unnamed first sheet
    if (tabName === CONFIG.TABS.jobs && ss.getSheets().length === 1 &&
        ss.getSheets()[0].getLastRow() === 0) {
      sheet = ss.getSheets()[0];
      sheet.setName(tabName);
    } else {
      sheet = ss.insertSheet(tabName);
    }
    sheet.setFrozenRows(1);
  }

  var schema  = tabSchemas_()[tabName] || [];
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var missing = schema.filter(function(h) { return headers.indexOf(h) === -1; });

  if (missing.length) {
    var startCol = Math.max(1, headers.filter(String).length + 1);
    if (sheet.getMaxColumns() < startCol + missing.length - 1) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(),
        startCol + missing.length - 1 - sheet.getMaxColumns());
    }
    sheet.getRange(1, startCol, 1, missing.length)
      .setValues([missing])
      .setFontWeight('bold')
      .setBackground('#2d5a27')
      .setFontColor('#ffffff');
  }
  TAB_MEMO_[tabName] = sheet;
  return sheet;
}

function headerMap_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  headers.forEach(function(h, i) { if (h) map[h] = i; });
  return map;
}

// ── Reads ────────────────────────────────────────────────────

// Sheets auto-parses written 'yyyy-mm-dd' strings into Date objects, so a
// naive toISOString() read-back turns '2026-07-14' into
// '2026-07-13T23:00:00.000Z' (BST) and breaks every string comparison the
// frontends do. Pure dates (midnight in the sheet's timezone) come back as
// 'yyyy-MM-dd'; genuine datetimes keep their full ISO form.
function sheetValueToString_(v) {
  if (!(v instanceof Date)) return v === undefined ? '' : v;
  if (Utilities.formatDate(v, CONFIG.TIMEZONE, 'HHmmss') === '000000') {
    return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  return v.toISOString();
}

// All rows of a tab as objects keyed by the ACTUAL header row.
function storeReadAll(tabName) {
  var sheet = getTab_(tabName);
  var data  = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    // Skip only genuinely empty rows. Testing column 0 here silently dropped
    // every per-shed Dispatch row (legacy deal_id in column A stays blank
    // since v10) — Dan's drafts vanished on every refresh (2026-07-16).
    if (data[i].join('') === '') continue;
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      if (!headers[j]) continue;
      obj[headers[j]] = sheetValueToString_(data[i][j]);
    }
    rows.push(obj);
  }
  return rows;
}

// Like storeReadAll, but deduped: one row per key, newest last_updated wins.
// The legacy apps' unguarded appendRow left duplicate rows in the Jobs tab
// (e.g. three rows for one shed) — without this, a stale duplicate can
// shadow the real state.
function storeReadLatest(tabName, keyField) {
  var byKey = {};
  storeReadAll(tabName).forEach(function(r) {
    var k = String(r[keyField]).trim();
    var existing = byKey[k];
    if (!existing || String(r.last_updated || '') >= String(existing.last_updated || '')) {
      byKey[k] = r;
    }
  });
  return Object.keys(byKey).map(function(k) { return byKey[k]; });
}

// ── Writes ───────────────────────────────────────────────────

// Upsert one row. `fields`: {header: value}; null clears, absent skips.
// Sets last_updated automatically if that column exists.
function storeUpsert(tabName, keyField, keyValue, fields) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getTab_(tabName);
    var cols  = headerMap_(sheet);
    if (cols[keyField] === undefined) throw new Error(tabName + ': key column "' + keyField + '" missing');

    var id   = String(keyValue).trim();
    var now  = new Date().toISOString();
    var data = sheet.getDataRange().getValues();

    var rowIdx = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][cols[keyField]]).trim() === id) { rowIdx = i + 1; break; }
    }

    var width = sheet.getLastColumn();
    var row   = rowIdx === -1
      ? new Array(width).fill('')
      : sheet.getRange(rowIdx, 1, 1, width).getValues()[0];

    row[cols[keyField]] = id;
    Object.keys(fields || {}).forEach(function(k) {
      if (cols[k] === undefined) return;      // unknown column: ignore
      var v = fields[k];
      if (v === undefined) return;            // absent: leave untouched
      row[cols[k]] = (v === null) ? '' : v;   // null: explicit clear
    });
    if (cols.last_updated !== undefined) row[cols.last_updated] = now;

    if (rowIdx === -1) sheet.appendRow(row);
    else sheet.getRange(rowIdx, 1, 1, width).setValues([row]);

    SpreadsheetApp.flush();
    // State changed → cached view payloads are stale
    try { bustViewPayloads_(); } catch (e) {}
    return { ok: true, timestamp: now };
  } finally {
    lock.releaseLock();
  }
}

// Set one field to the same value on many rows (odd-job batch complete).
function storeBatchSetField(tabName, keyField, keyValues, fieldName, value) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getTab_(tabName);
    var cols  = headerMap_(sheet);
    if (cols[fieldName] === undefined) throw new Error(tabName + ': column "' + fieldName + '" missing');

    var wanted = {};
    (keyValues || []).forEach(function(k) { wanted[String(k).trim()] = true; });

    var data = sheet.getDataRange().getValues();
    var col  = cols[fieldName] + 1;
    var v    = (value === null || value === undefined) ? '' : value;
    var found = {};
    for (var i = 1; i < data.length; i++) {
      var id = String(data[i][cols[keyField]]).trim();
      if (wanted[id]) { sheet.getRange(i + 1, col).setValue(v); found[id] = true; }
    }
    // Rows the tracker hasn't touched yet won't exist — create them
    Object.keys(wanted).forEach(function(id) {
      if (!found[id]) {
        var fields = {};
        fields[fieldName] = v;
        // storeUpsert takes its own lock; do the minimal insert inline instead
        var width = sheet.getLastColumn();
        var row   = new Array(width).fill('');
        row[cols[keyField]] = id;
        row[cols[fieldName]] = v;
        if (cols.last_updated !== undefined) row[cols.last_updated] = new Date().toISOString();
        sheet.appendRow(row);
      }
    });

    SpreadsheetApp.flush();
    try { bustViewPayloads_(); } catch (e) {}
    return { ok: true, timestamp: new Date().toISOString() };
  } finally {
    lock.releaseLock();
  }
}
