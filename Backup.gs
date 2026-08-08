// ============================================================
// BSC Production Hub — nightly state-sheet backup
// Runs on Google's servers via a time-driven trigger (installed once by
// installBackupTrigger — see the ?debug=installbackup endpoint), so it
// happens whether Dan's machine is on or not. Copies the whole state
// spreadsheet into the "BSC Hub Backups" Drive folder, VERIFIES the copy
// (every tab present, row/column counts match), prunes old snapshots
// (last 30 dailies + 1st-of-month kept ~2 years), and emails Dan ONLY on
// failure — silence means healthy. Restore runbook: HANDOVER.html.
// Triggers always execute the LATEST pushed code (not a deployment).
// ============================================================

function nightlyBackup() {
  var B = CONFIG.BACKUP;
  try {
    var ss     = openStateSpreadsheet_();
    var folder = backupFolder_();
    var stamp  = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
    var name   = CONFIG.STATE_SHEET_NAME + ' backup ' + stamp;

    // Re-running the same day replaces that day's snapshot
    var dupes = folder.getFilesByName(name);
    while (dupes.hasNext()) dupes.next().setTrashed(true);

    var copyFile = DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
    var problems = verifyBackup_(ss, copyFile.getId());
    if (problems.length) {
      copyFile.setTrashed(true);   // a bad backup is worse than none — retry tomorrow, alert now
      throw new Error('verification failed: ' + problems.join('; '));
    }

    var pruned = pruneBackups_(folder);
    Logger.log('nightlyBackup OK: ' + name + ' (' + ss.getSheets().length +
      ' tabs verified, ' + pruned + ' old snapshot(s) pruned)');
    return { ok: true, name: name, pruned: pruned };
  } catch (e) {
    try {
      MailApp.sendEmail(B.ALERT_EMAIL,
        '⚠ BSC Hub backup FAILED — ' + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'd MMM yyyy'),
        'The nightly backup of ' + CONFIG.STATE_SHEET_NAME + ' failed:\n\n' + e.message +
        '\n\nNo action is urgent — the live sheet is untouched and last night\'s snapshot still exists — ' +
        'but the backup should be re-run (open the app with ?debug=runbackup on a temp deployment, ' +
        'or run nightlyBackup in the script editor). Runbook: HANDOVER.html → BACKUPS.');
    } catch (e2) { Logger.log('backup alert email also failed: ' + e2.message); }
    Logger.log('nightlyBackup FAILED: ' + e.message);
    return { ok: false, error: e.message };
  }
}

// Every source tab must exist in the copy with identical dimensions.
function verifyBackup_(ss, copyId) {
  var copy = SpreadsheetApp.openById(copyId);
  var problems = [];
  ss.getSheets().forEach(function(src) {
    var dst = copy.getSheetByName(src.getName());
    if (!dst) { problems.push('tab "' + src.getName() + '" missing'); return; }
    if (dst.getLastRow() !== src.getLastRow() || dst.getLastColumn() !== src.getLastColumn()) {
      problems.push('tab "' + src.getName() + '" size mismatch (' +
        src.getLastRow() + 'x' + src.getLastColumn() + ' → ' +
        dst.getLastRow() + 'x' + dst.getLastColumn() + ')');
    }
  });
  return problems;
}

// Keep: every snapshot from the last DAILY_KEEP days, plus 1st-of-month
// snapshots up to MONTHLY_KEEP_DAYS old. Trash the rest.
function pruneBackups_(folder) {
  var B = CONFIG.BACKUP;
  var now = new Date().getTime();
  var pruned = 0;
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var m = f.getName().match(/ backup (\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;                                  // not one of ours
    var ageDays = (now - new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T12:00:00Z').getTime()) / 86400000;
    var isMonthly = m[3] === '01';
    var keep = ageDays <= B.DAILY_KEEP || (isMonthly && ageDays <= B.MONTHLY_KEEP_DAYS);
    if (!keep) { f.setTrashed(true); pruned++; }
  }
  return pruned;
}

function backupFolder_() {
  var it = DriveApp.getFoldersByName(CONFIG.BACKUP.FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.BACKUP.FOLDER_NAME);
}

// ── HubSpot snapshot warmer ──────────────────────────────────
// The 30-min snapshot cache made the FIRST load after expiry pay the
// full HubSpot fetch (~15-30s). This trigger refreshes it every 15 min
// on Google's servers, so humans always hit a warm cache. Timetastic
// leave is warmed alongside. Installed once via ?debug=installwarmer.

function keepLiveCacheWarm() {
  try { fetchLiveData(true); } catch (e) { Logger.log('cache warm (live): ' + e.message); }
  try { getTimetasticLeave(true); } catch (e2) { Logger.log('cache warm (leave): ' + e2.message); }
  // Pre-build every view's payload so user requests serve from cache
  try { getTrackerData(true); }   catch (e3) { Logger.log('cache warm (tracker): '   + e3.message); }
  try { getSchedulerData(true); } catch (e4) { Logger.log('cache warm (scheduler): ' + e4.message); }
  try { getDispatchData(true); }  catch (e5) { Logger.log('cache warm (dispatch): '  + e5.message); }
  try { getInstallerData(true); } catch (e6) { Logger.log('cache warm (installer): ' + e6.message); }
  try { getReportsData(true); }   catch (e7) { Logger.log('cache warm (reports): '   + e7.message); }
}

function installCacheWarmTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'keepLiveCacheWarm') { ScriptApp.deleteTrigger(t); removed++; }
  });
  ScriptApp.newTrigger('keepLiveCacheWarm').timeBased().everyMinutes(15).create();
  return { ok: true, replaced: removed, schedule: 'every 15 minutes' };
}

// One-time: install (or reset) the nightly trigger. Run as Dan — via the
// ?debug=installbackup endpoint on a temp deployment, or the editor.
function installBackupTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'nightlyBackup') { ScriptApp.deleteTrigger(t); removed++; }
  });
  ScriptApp.newTrigger('nightlyBackup')
    .timeBased().everyDays(1).atHour(CONFIG.BACKUP.HOUR)
    .create();
  return { ok: true, replaced: removed,
           schedule: 'daily around ' + CONFIG.BACKUP.HOUR + ':00 ' + CONFIG.TIMEZONE };
}
