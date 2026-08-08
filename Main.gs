// ============================================================
// BSC Production Hub — Web app entry point & view routing
// One project, three views:
//   ?view=tracker    (default) — shop-floor production tracker
//   ?view=scheduler  — weekly production scheduling board
//   ?view=dispatch   — dispatch date planning board (Trello replacement)
// Create one deployment per audience; each URL just carries its view param.
// ============================================================

var VIEWS = {
  tracker:   { file: 'Tracker',   title: 'BSC — Production Tracker' },
  scheduler: { file: 'Scheduler', title: 'BSC — Production Scheduler' },
  dispatch:  { file: 'Dispatch',  title: 'BSC — Dispatch Planner' },
  installer: { file: 'Installer', title: 'BSC — Installer' },
  reports:   { file: 'Reports',   title: 'BSC — Reports' },
  daysheets: { file: 'Daysheets', title: 'BSC — Day Sheets' }
};

function doGet(e) {
  // Diagnostic: ?debug=shednames force-fetches from HubSpot and lists the raw
  // shed hs_name values so field-mapping issues can be seen without the UI.
  if (e && e.parameter && e.parameter.debug === 'shednames') {
    var snap = fetchLiveData(true);
    var rows = snap.sheds.slice(0, 25).map(function(j) {
      return { shedId: j.id, name: j.jobRef, dealId: j.dealId,
               shedType: j.shedType,
               productValue: j.productValue, valueSource: j.valueSource,
               dealProductTotal: j.dealProductTotal,
               valueReviewWhy: j.valueReviewWhy || '' };
    });
    return ContentService
      .createTextOutput(JSON.stringify({ count: snap.sheds.length, sample: rows }, null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Diagnostic: ?debug=dispatchstate dumps the raw Dispatch-tab rows and the
  // per-shed result getDispatchData computes from them (draft-loss triage).
  if (e && e.parameter && e.parameter.debug === 'dispatchstate') {
    var rows2 = storeReadLatest(CONFIG.TABS.dispatch, 'shed_id').map(function(r) {
      return { shed_id: r.shed_id, shed_name: r.shed_name,
               proposed_dispatch_date: r.proposed_dispatch_date,
               dispatch_status: r.dispatch_status, dispatch_group: r.dispatch_group,
               last_updated: r.last_updated };
    });
    var jobs2 = getDispatchData(false).jobs
      .filter(function(j) { return j.proposedDate || j.status; })
      .map(function(j) {
        return { id: j.id, name: j.name, hsStatus: j.hsDispatchStatus,
                 status: j.status, proposedDate: j.proposedDate,
                 target: j.targetDispatchDate };
      });
    return ContentService
      .createTextOutput(JSON.stringify({ dispatchRows: rows2, jobsWithState: jobs2 }, null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Backup admin (run AS the deployer via a temp deployment):
  // ?debug=installbackup installs/resets the nightly trigger;
  // ?debug=runbackup takes and verifies a snapshot right now.
  if (e && e.parameter && e.parameter.debug === 'installbackup') {
    return ContentService.createTextOutput(JSON.stringify(installBackupTrigger(), null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e && e.parameter && e.parameter.debug === 'installwarmer') {
    return ContentService.createTextOutput(JSON.stringify(installCacheWarmTrigger(), null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e && e.parameter && e.parameter.debug === 'runbackup') {
    return ContentService.createTextOutput(JSON.stringify(nightlyBackup(), null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Diagnostic: ?debug=reportscov — coverage as the cached reports payload
  // sees it vs a fresh rebuild (value-derivation triage, 2026-07-18)
  if (e && e.parameter && e.parameter.debug === 'reportscov') {
    var cachedPay = getReportsData(false);
    var freshPay  = buildReportsData_(false);
    var liveNow   = fetchLiveData(false);
    var sample = liveNow.sheds.slice(0, 5).map(function(j) {
      return { name: j.jobRef, productValue: j.productValue, src: j.valueSource };
    });
    return ContentService.createTextOutput(JSON.stringify({
      cachedCoverage: cachedPay.coverage,
      cachedTimestamp: cachedPay.timestamp,
      freshCoverage: freshPay.coverage,
      liveSample: sample
    }, null, 2)).setMimeType(ContentService.MimeType.JSON);
  }

  // Diagnostic: ?debug=timing — per-phase server timings (perf work)
  if (e && e.parameter && e.parameter.debug === 'timing') {
    var T = {}, t = Date.now();
    var live = fetchLiveData(false);
    T.fetchLive_ms = Date.now() - t; T.sheds = live.sheds.length;
    t = Date.now(); storeReadLatest(CONFIG.TABS.dispatch, 'shed_id'); T.readDispatchTab_ms = Date.now() - t;
    t = Date.now(); storeReadLatest(CONFIG.TABS.reports, 'shed_id');  T.readReportsTab_ms = Date.now() - t;
    t = Date.now(); storeReadLatest(CONFIG.TABS.jobs, 'shed_id');     T.readJobsTab_ms = Date.now() - t;
    t = Date.now(); geocodePostcodes_(live.sheds.map(function(j) { return j.postCode; })); T.geocodeJobs_ms = Date.now() - t;
    t = Date.now(); geocodePostcodes_([CONFIG.INSTALL_DAY.WORKSHOP_POSTCODE]); T.geocodeWorkshop_ms = Date.now() - t;
    t = Date.now(); getClientConfig(); T.clientConfig_ms = Date.now() - t;
    t = Date.now(); getInstallerData(false); T.fullInstallerCall_ms = Date.now() - t;
    t = Date.now(); getTrackerData(false); T.fullTrackerCall_ms = Date.now() - t;
    return ContentService.createTextOutput(JSON.stringify(T, null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var key  = (e && e.parameter && e.parameter.view) || 'tracker';
  var view = VIEWS[key] || VIEWS.tracker;
  var tpl  = HtmlService.createTemplateFromFile(view.file);
  tpl.view = key;
  return tpl.evaluate()
    .setTitle(view.title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Used by templates: <?!= include('Shared'); ?>
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
