// ============================================================
// BSC Production Hub — in-app test notes ("🗒 Notes" header
// button, injected by Shared.html into every view).
// Dan records issues while testing; "Copy for Claude" formats
// the open ones for pasting into a fix session. Rows live in
// the AppFeedback tab of the state sheet.
//
// Deliberately NOT via storeUpsert: these writes must not bust
// the cached view payloads (bustViewPayloads_) — a note is not
// production state.
// ============================================================

function getAppFeedback() {
  var rows = storeReadAll(CONFIG.TABS.feedback);
  rows.sort(function (a, b) {
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
  return rows;
}

function addAppFeedback(view, text) {
  text = String(text || '').trim();
  if (!text) throw new Error('Note is empty');
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getTab_(CONFIG.TABS.feedback);
    var cols  = headerMap_(sheet);
    var now   = new Date().toISOString();
    var row   = new Array(sheet.getLastColumn()).fill('');
    row[cols.note_key]     = 'fb_' + Utilities.getUuid().slice(0, 8);
    row[cols.created_at]   = now;
    row[cols.view]         = String(view || '');
    row[cols.note]         = text;
    row[cols.status]       = 'open';
    row[cols.last_updated] = now;
    sheet.appendRow(row);
    SpreadsheetApp.flush();
    return { ok: true, timestamp: now };
  } finally {
    lock.releaseLock();
  }
}

function setAppFeedbackStatus(noteKey, status) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sheet = getTab_(CONFIG.TABS.feedback);
    var cols  = headerMap_(sheet);
    var data  = sheet.getDataRange().getValues();
    var key   = String(noteKey).trim();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][cols.note_key]).trim() === key) {
        sheet.getRange(i + 1, cols.status + 1).setValue(status);
        if (cols.last_updated !== undefined) {
          sheet.getRange(i + 1, cols.last_updated + 1).setValue(new Date().toISOString());
        }
        SpreadsheetApp.flush();
        return { ok: true };
      }
    }
    throw new Error('Note not found: ' + key);
  } finally {
    lock.releaseLock();
  }
}
