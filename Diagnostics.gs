// ── TEMPORARY DIAGNOSTIC — safe to delete once we've answered the question ──
// Read-only. Writes nothing, changes nothing.
//
// HOW TO RUN
//   1. Apps Script editor → + (Files) → Script → name it "Diagnostics"
//   2. Paste this whole file in, save (Ctrl+S)
//   3. Function dropdown at the top → choose  whereIsTheAppWriting
//   4. Click ▶ Run   (approve permissions if asked)
//   5. Click "Execution log" and copy everything it prints
//
// Follows the project's V8 rules: var + function only, no const/let/arrows.

function whereIsTheAppWriting() {
  var out = [];
  function say(s) { out.push(s); Logger.log(s); }

  say('===== BSC JOB TRACKER — WRITE TARGET DIAGNOSTIC =====');
  say('Run at: ' + new Date().toString());
  say('');

  // ── 1. Who is this running as? ──────────────────────────────
  // If these differ, the web app is running as one user while a
  // different person is clicking — which changes whose Drive is used.
  say('--- IDENTITY ---');
  try { say('Effective user (whose Drive is used): ' + Session.getEffectiveUser().getEmail()); }
  catch (e) { say('Effective user: UNAVAILABLE (' + e.message + ')'); }
  try {
    var active = Session.getActiveUser().getEmail();
    say('Active user (who is clicking)          : ' + (active || '(blank — anonymous access)'));
  } catch (e) { say('Active user: UNAVAILABLE (' + e.message + ')'); }
  say('');

  // ── 2. Which spreadsheet is pinned? ─────────────────────────
  say('--- PINNED STATE SPREADSHEET ---');
  var props = PropertiesService.getScriptProperties();
  var pinned = props.getProperty('STATE_SS_ID');
  say('STATE_SS_ID script property: ' + (pinned || '(NOT SET — app will search Drive by title)'));

  var ss = null;
  try {
    ss = getOrCreateStateSS();          // the app's own resolver
    say('Resolved spreadsheet name : ' + ss.getName());
    say('Resolved spreadsheet ID   : ' + ss.getId());
    say('Resolved spreadsheet URL  : ' + ss.getUrl());
    say('>>> THIS is where ticks are being saved. <<<');
  } catch (e) {
    say('!! getOrCreateStateSS() FAILED: ' + e.message);
    return finish(out);
  }
  say('');

  // ── 3. Duplicate-title check ────────────────────────────────
  // getOrCreateStateSS() falls back to a title search and silently
  // takes the FIRST match, so more than one is a real hazard.
  say('--- ALL SPREADSHEETS TITLED "' + STATE_SHEET_NAME + '" ---');
  try {
    var files = DriveApp.searchFiles(
      'title = "' + STATE_SHEET_NAME + '" and mimeType = "application/vnd.google-apps.spreadsheet" and trashed = false'
    );
    var n = 0;
    while (files.hasNext()) {
      var f = files.next();
      n++;
      say('  [' + n + '] ' + f.getId() + (f.getId() === ss.getId() ? '   <-- the one in use' : '') +
          '  | owner: ' + f.getOwner().getEmail() +
          '  | modified: ' + f.getLastUpdated());
    }
    say('Total exact-title matches: ' + n + (n > 1 ? '   *** DUPLICATES — the app may be reading a different one than you are ***' : ''));
  } catch (e) { say('Drive search failed: ' + e.message); }
  say('');

  // ── 4. Tabs present ─────────────────────────────────────────
  say('--- TABS IN THAT SPREADSHEET ---');
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    say('  "' + sheets[i].getName() + '"  rows=' + sheets[i].getLastRow() + '  cols=' + sheets[i].getLastColumn());
  }
  say('');

  // ── 5. Most recent writes in the state tab ──────────────────
  say('--- 15 MOST RECENT ROWS IN THE STATE TAB ---');
  var tab = ss.getSheetByName(STATE_SHEET_NAME);
  if (!tab) {
    say('!! No tab named "' + STATE_SHEET_NAME + '" — the state tab is missing.');
    return finish(out);
  }
  var data = tab.getDataRange().getValues();
  say('Data rows (excluding header): ' + Math.max(0, data.length - 1));

  var rows = [];
  for (var r = 1; r < data.length; r++) {
    var id = String(data[r][0] || '').trim();
    var ts = data[r][2];
    if (!id) continue;
    rows.push({ id: id, ts: (ts instanceof Date && !isNaN(ts.getTime())) ? ts : null });
  }
  rows.sort(function(a, b) {
    if (!a.ts && !b.ts) return 0;
    if (!a.ts) return -1;
    if (!b.ts) return 1;
    return a.ts.getTime() - b.ts.getTime();
  });
  var start = Math.max(0, rows.length - 15);
  for (var k = start; k < rows.length; k++) {
    say('  ' + (rows[k].ts ? Utilities.formatDate(rows[k].ts, 'Europe/London', 'yyyy-MM-dd EEE HH:mm:ss') : '(no timestamp)   ') +
        '   job ' + rows[k].id);
  }
  say('');

  // ── 6. Anything at all since 3 Aug? ─────────────────────────
  say('--- WRITES SINCE 2026-08-03 ---');
  var cutoff = new Date(2026, 7, 3, 0, 0, 0); // month is 0-based: 7 = August
  var recent = 0;
  for (var m = 0; m < rows.length; m++) {
    if (rows[m].ts && rows[m].ts.getTime() >= cutoff.getTime()) {
      recent++;
      say('  ' + Utilities.formatDate(rows[m].ts, 'Europe/London', 'yyyy-MM-dd EEE HH:mm:ss') + '   job ' + rows[m].id);
    }
  }
  if (!recent) say('  NONE. Nothing has been written to this spreadsheet since 3 Aug 2026.');
  say('');
  say('===== END — copy everything above =====');

  return finish(out);
}

function finish(out) {
  var text = out.join('\n');
  // Returned as well as logged, so it also shows in the editor's return value.
  return text;
}
