// ============================================================
// BSC LIVE JOBS TRACKER — Apps Script backend
// ============================================================
// WHICH APP AM I?  This is the REVCAP-fed tracker Dan and Steve use daily.
// It is NOT the BSC Production Hub. The two are easy to confuse: both are
// production trackers, both have a state sheet whose name starts
// "BSC_", and neither knows about the other's ticks.
//
//   Script ID    1a7lIjP7wbANshiHihuj0GSt3PIC8tnd17a4y2L4U7nWRBel_2Ifr1dn5
//   Live URL     .../s/AKfycbxeSb1NB7JKxqbNw4KUAMlwhLpu8xmXbrPa_36oik4C-1FEurCei73V3CGKbp8D7dIV/exec
//   HEAD URL     .../s/AKfycbzhmQ2UCi_4wXSEA160hERZX0HQ6bVY7mHEEtor-0Y/exec   (testing)
//   State sheet  BSC_JobTracker_State — 1ckWXJkStag_M_6jQ8kBtDiDJBS0QDT-POQNUzH307WQ
//                  tab BSC_JobTracker_State     job ticks (this file writes it)
//                  tab BSC_JobTracker_Snapshot  job list snapshot, for change detection
//   Data source  REVCAP .xlsm, dropped in by hand — parsed client-side in
//                Index.html. Until a file is dropped the page reads
//                "Fetching live projects from HubSpot", which is a
//                misleading placeholder, not a hang. Code.gs does contain a
//                HubSpot loader, but the REVCAP path is what runs.
//
// SIBLING APP — different project, different sheet, no shared state:
//   BSC Production Hub  1QocduDGGpH__j0UF7sSCO_fwRlVhmSxigOnglEouqvLK1QCwRrNfgoXS
//   Six views via ?view=  (tracker, scheduler, dispatch, installer,
//   reports, daysheets). Writes BSC_ProdTracker_State.
//
// DEPLOYING — pushing alone changes nothing for users. The live URL is
// pinned to a version, so it keeps serving the old code until you redeploy:
//   clasp push -f
//   clasp redeploy AKfycbxeSb1NB7JKxqbNw4KUAMlwhLpu8xmXbrPa_36oik4C-1FEurCei73V3CGKbp8D7dIV -d "vN - ..."
// or in the editor: Deploy > Manage deployments > pencil > New version.
// Bump the version in the <footer> of Index.html in the same change, so the
// footer tells you which build someone is actually looking at.
// ============================================================

// -- CONFIG --------------------------------------------------
const STATE_SHEET_NAME = 'BSC_JobTracker_State';

// -- WEB APP ENTRY POINT -------------------------------------

function doGet() {
  var tmpl = HtmlService.createTemplateFromFile('Index');
  tmpl.selfUrl = ScriptApp.getService().getUrl();
  return tmpl.evaluate()
    .setTitle('BSC — Live Jobs Tracker')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// -- SERVE REVCAP AS BASE64 -----------------------------------
// Called from the browser to fetch the latest REVCAP file bytes.
// Searches Drive for any file whose name starts with "REVCAP".

function getRevcapBase64() {
  // Try common name variants first (fast path)
  var names = ['REVCAP OCT25.xlsm', 'REVCAP Oct25.xlsm', 'REVCAP_Oct25.xlsm', 'REVCAP Oct 25.xlsm'];
  for (var i = 0; i < names.length; i++) {
    var files = DriveApp.getFilesByName(names[i]);
    if (files.hasNext()) {
      var f = files.next();
      return { base64: Utilities.base64Encode(f.getBlob().getBytes()), filename: f.getName() };
    }
  }
  // Broader search � any file with REVCAP in the name
  var search = DriveApp.searchFiles('title contains "REVCAP" and trashed = false');
  if (search.hasNext()) {
    var f = search.next();
    return { base64: Utilities.base64Encode(f.getBlob().getBytes()), filename: f.getName() };
  }
  throw new Error('Cannot find REVCAP file in Google Drive. Please make sure it has been uploaded/shared with this account.');
}

// -- STATE: READ ----------------------------------------------
// Returns { jobId: stateObject, ... } for all jobs.

function getState() {
  var sheet = getOrCreateStateSheet();
  var data  = sheet.getDataRange().getValues();
  var state = {};

  // Row 1 = headers; rows 2+ = data: col A = Job ID, col B = State JSON, col C = Last Updated
  for (var i = 1; i < data.length; i++) {
    var id  = String(data[i][0]).trim();
    var raw = data[i][1];
    if (!id || id === 'Job ID') continue;
    try {
      state[id] = typeof raw === 'string' ? JSON.parse(raw) : {};
    } catch (e) {
      state[id] = {};
    }
  }
  return state;
}

// -- WHO IS TICKING -------------------------------------------
// Resolves the person whose click caused this save, for the "Updated By"
// column. The web app is deployed with executeAs: USER_DEPLOYING, so:
//   getActiveUser()    = the person clicking (Steve) — only returned when
//                        they share a Workspace domain with the deployer,
//                        which everyone here does, AND only once the
//                        userinfo.email scope has been granted. It throws
//                        outright if that scope is missing, so it must be
//                        guarded or every save would fail.
//   getEffectiveUser() = whoever deployed (Dan) — a poor stand-in for the
//                        clicker, so it is tagged rather than recorded bare.
// Never throws; worst case the audit column reads 'unknown'.

function currentUserEmail_() {
  try {
    var active = Session.getActiveUser().getEmail();
    if (active) return active;
  } catch (e) {}
  try {
    var eff = Session.getEffectiveUser().getEmail();
    if (eff) return eff + ' (deployer — clicker not available)';
  } catch (e) {}
  return 'unknown';
}

// -- STATE: WRITE ---------------------------------------------
// Saves the full state object for a single job.

function saveJobState(jobId, stateJson) {
  var sheet = getOrCreateStateSheet();
  var data  = sheet.getDataRange().getValues();
  var id    = String(jobId).trim();
  var now   = new Date();
  var who   = currentUserEmail_();

  // Label column D on sheets created before the audit column existed.
  // Read from the data we already have, so this costs no extra API call.
  if (!data.length || !String((data[0] || [])[3] || '').trim()) {
    sheet.getRange(1, 4).setValue('Updated By')
         .setFontWeight('bold').setBackground('#2d5a27').setFontColor('#ffffff');
    sheet.setColumnWidth(4, 240);
  }

  var firstRow     = -1;
  var duplicates   = [];

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === id) {
      if (firstRow === -1) {
        firstRow = i + 1; // 1-based row number of first match
      } else {
        duplicates.push(i + 1); // collect any duplicate rows
      }
    }
  }

  if (firstRow === -1) {
    // Brand new job
    sheet.appendRow([id, stateJson, now, who]);
  } else {
    // Update first row — one setValues() call rather than three setValue()
    // calls, since this runs on every tick
    sheet.getRange(firstRow, 2, 1, 3).setValues([[stateJson, now, who]]);
    // Delete duplicates bottom-to-top so row numbers don't shift
    for (var j = duplicates.length - 1; j >= 0; j--) {
      sheet.deleteRow(duplicates[j]);
    }
  }

  SpreadsheetApp.flush();
  return { ok: true };
}

// -- ONE-TIME CLEANUP: REMOVE DUPLICATE JOB ROWS --------------
// Run this ONCE from the Apps Script editor to fix existing duplicates.
// Keeps the first row for each job ID and deletes any later duplicates.

function cleanupDuplicateRows() {
  var sheet = getOrCreateStateSheet();
  var data  = sheet.getDataRange().getValues();
  var seen  = {};
  var toDelete = [];

  for (var i = 1; i < data.length; i++) {
    var id = String(data[i][0]).trim();
    if (!id || id === 'Job ID') continue;
    if (seen[id]) {
      toDelete.push(i + 1);
    } else {
      seen[id] = true;
    }
  }

  // Delete bottom-to-top so row indices stay valid
  for (var j = toDelete.length - 1; j >= 0; j--) {
    sheet.deleteRow(toDelete[j]);
  }
  SpreadsheetApp.flush();
  var msg = 'Removed ' + toDelete.length + ' duplicate rows.';
  Logger.log(msg);
  return msg;
}

// -- ONE-TIME MIGRATION: IMPORT FROM LOCALSTORAGE -------------
// Paste your localStorage JSON as the argument and run this ONCE from
// the Apps Script editor (not from the web app).
// Example: importFromLocalStorage('{"405":{"sprayDate":"..."},...}')

function importFromLocalStorage(jsonString) {
  var data;
  try {
    data = JSON.parse(jsonString);
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message);
  }

  var sheet = getOrCreateStateSheet();
  var existing = sheet.getDataRange().getValues();

  // Build index of existing rows: id ? row index (1-based)
  var rowIndex = {};
  for (var i = 1; i < existing.length; i++) {
    var existingId = String(existing[i][0]).trim();
    if (existingId) rowIndex[existingId] = i + 1;
  }

  var now = new Date();
  var written = 0;
  var skipped = 0;

  for (var jobId in data) {
    var stateObj = data[jobId];
    // Skip jobs that are entirely default / empty (no meaningful data)
    var hasData = stateObj.lastSaved || stateObj.notes;
    if (!hasData) { skipped++; continue; }

    var stateJson = JSON.stringify(stateObj);
    var via = 'localStorage migration';
    if (rowIndex[jobId]) {
      sheet.getRange(rowIndex[jobId], 2, 1, 3).setValues([[stateJson, now, via]]);
    } else {
      sheet.appendRow([jobId, stateJson, now, via]);
    }
    written++;
  }

  Logger.log('Migration complete: ' + written + ' jobs written, ' + skipped + ' empty jobs skipped.');
  return 'Done: ' + written + ' written, ' + skipped + ' skipped.';
}

// -- RUN MIGRATION (one-time) ----------------------------------
// 1. Open this file in Notepad, copy all, paste into Apps Script Code.gs
// 2. Find PASTE_JSON_HERE below and replace it with your localStorage JSON
// 3. Select runMigration from the dropdown and click Run

function runMigration() {
  var json = 'PASTE_JSON_HERE';
  Logger.log(importFromLocalStorage(json));
}

// -- SNAPSHOT: READ -------------------------------------------
// Stored one-row-per-job in BSC_JobTracker_Snapshot sheet tab.
// This avoids the 50 KB per-cell limit that caused silent save failures.

function getSnapshot() {
  try {
    var ss    = getOrCreateStateSS();
    var sheet = ss.getSheetByName('BSC_JobTracker_Snapshot');
    if (!sheet || sheet.getLastRow() < 2) return '{}';
    var data  = sheet.getDataRange().getValues();
    var snap  = {};
    for (var i = 1; i < data.length; i++) {
      var id = String(data[i][0]).trim();
      if (!id) continue;
      // Sheets auto-converts 'YYYY-MM-DD' strings to Date objects � convert back
      var rawDate = data[i][1];
      var installDate = null;
      if (rawDate) {
        if (rawDate instanceof Date) {
          installDate = rawDate.getFullYear() + '-' +
                        String(rawDate.getMonth() + 1).padStart(2, '0') + '-' +
                        String(rawDate.getDate()).padStart(2, '0');
        } else {
          installDate = String(rawDate);
        }
      }
      snap[id] = {
        installDate : installDate,
        colour      : String(data[i][2] || ''),
        colourDet   : String(data[i][3] || ''),
        supplyType  : String(data[i][4] || ''),
        modelSize   : String(data[i][5] || '')
      };
    }
    return JSON.stringify(snap);
  } catch (e) {
    Logger.log('getSnapshot error: ' + e.message);
    return '{}';
  }
}

// -- SNAPSHOT: WRITE -------------------------------------------
// Clears and rewrites the snapshot sheet � one row per job, no cell-size limit.

function saveSnapshot(jsonString) {
  try {
    var ss    = getOrCreateStateSS();
    var sheet = ss.getSheetByName('BSC_JobTracker_Snapshot');
    if (!sheet) {
      sheet = ss.insertSheet('BSC_JobTracker_Snapshot');
    }
    sheet.clearContents();
    sheet.appendRow(['Job ID', 'Install Date', 'Colour', 'Colour Det', 'Supply Type', 'Model Size']);

    var data;
    try { data = JSON.parse(jsonString); } catch (e) {
      throw new Error('Invalid snapshot JSON: ' + e.message);
    }
    var rows = [];
    for (var id in data) {
      var s = data[id];
      rows.push([id, s.installDate || '', s.colour || '', s.colourDet || '', s.supplyType || '', s.modelSize || '']);
    }
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, 6).setValues(rows);
    }
    return { ok: true };
  } catch (e) {
    Logger.log('saveSnapshot error: ' + e.message);
    throw e;
  }
}

// -- HELPER: OPEN THE STATE SPREADSHEET ----------------------
// Pins the spreadsheet by ID via PropertiesService after first lookup so
// every function (getState, saveJobState, getSnapshot, saveSnapshot) always
// opens the exact same file � prevents split-brain reads/writes if there
// are duplicate-named files in Drive.

function getOrCreateStateSS() {
  var props = PropertiesService.getScriptProperties();
  var ssId  = props.getProperty('STATE_SS_ID');
  var ss;

  if (ssId) {
    try {
      ss = SpreadsheetApp.openById(ssId);
    } catch (e) {
      Logger.log('Stored spreadsheet ID invalid, re-searching: ' + e.message);
      props.deleteProperty('STATE_SS_ID');
      ss = null;
    }
  }

  if (!ss) {
    var files = DriveApp.searchFiles(
      'title = "' + STATE_SHEET_NAME + '" and mimeType = "application/vnd.google-apps.spreadsheet" and trashed = false'
    );
    if (files.hasNext()) {
      ss = SpreadsheetApp.open(files.next());
      if (files.hasNext()) {
        Logger.log('WARNING: multiple spreadsheets named "' + STATE_SHEET_NAME + '" in Drive � using first. Please delete duplicates.');
      }
    } else {
      ss = SpreadsheetApp.create(STATE_SHEET_NAME);
    }
    props.setProperty('STATE_SS_ID', ss.getId());
    Logger.log('Pinned state spreadsheet ID: ' + ss.getId());
  }

  return ss;
}

// -- TIMETASTIC: FETCH LEAVE ----------------------------------
// Returns approved leave for the given date range.
// startDate / endDate are ISO strings: 'YYYY-MM-DD'
//
// SETUP: In Apps Script ? Project Settings ? Script Properties,
// add a property named TIMETASTIC_API_KEY with your Timetastic API token.

function getTimetasticLeave(startDate, endDate) {
  var props  = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('TIMETASTIC_API_KEY');
  if (!apiKey) {
    return { error: 'Timetastic API key not set. Go to Apps Script ? Project Settings ? Script Properties and add TIMETASTIC_API_KEY.' };
  }
  try {
    var url  = 'https://app.timetastic.co.uk/api/holidays?StartDate=' + startDate + '&EndDate=' + endDate;
    var resp = UrlFetchApp.fetch(url, {
      method:             'GET',
      headers:            { 'Authorization': 'Bearer ' + apiKey },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      return { error: 'Timetastic returned HTTP ' + resp.getResponseCode() };
    }
    var data   = JSON.parse(resp.getContentText());
    var leaves = (data.holidays || [])
      .filter(function(h) { return h.status === 'Approved'; })
      .map(function(h) {
        return {
          name:      h.userName        || 'Unknown',
          startDate: (h.startDate || '').substring(0, 10),
          endDate:   (h.endDate   || '').substring(0, 10),
          startType: h.startType       || 'Morning',
          endType:   h.endType         || 'Afternoon',
          leaveType: h.leaveTypeName   || 'Leave'
        };
      });
    return { leaves: leaves };
  } catch (e) {
    return { error: e.message };
  }
}

// ============================================================
// HUBSPOT INTEGRATION
// ============================================================

var HS_BASE = 'https://api.hubapi.com';
var HS_PROJECTS_PIPELINE = '749565496';

// Called from the browser on page load.
// Returns an array of job objects in the same shape as parseWorkbook().
function getHubSpotJobs(forceRefresh) {
  // ── CACHE CHECK ──────────────────────────────────────────────
  if (!forceRefresh) {
    var cached = hsCacheGet();
    if (cached) {
      Logger.log('Returning ' + cached.length + ' jobs from cache');
      return cached;
    }
  }

  var token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_API_TOKEN');
  if (!token) throw new Error('HUBSPOT_API_TOKEN not set. Add it in Apps Script → Project Settings → Script Properties.');

  var TICKET_PROPS = [
    'subject', 'hs_pipeline',
    'install_date',
    'main_product_type__project_', 'main_product_size__project_',
    'main_product_colour__project_', 'colour_details__project_',
    'supply_type__project_',
    'security_pack__project_', 'bi_folds__project_', 'green_roof__project_',
    'joining_panel__project_', 'storage_hooks__project_', 'end_shelves__project_',
    'recycling_shelf__project_', 'steadyracks__project_',
    'additional_product_requirements__project_'
  ];

  // Step 1 — lightweight search: get IDs + subject + pipeline only
  var rawTickets = hsSearchAll(token, 'tickets', {
    filterGroups: [{
      filters: [{ propertyName: 'hs_pipeline_stage', operator: 'EQ', value: '1089431706' }]
    }],
    properties: ['subject', 'hs_pipeline']
  });

  // Step 2 — filter to Projects pipeline by pipeline ID and subject prefix
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  var cutoffStr = cutoff.toISOString().substring(0, 10);

  var projectIds = rawTickets
    .filter(function(t) {
      var p = t.properties;
      var subj = p.subject || '';
      return p.hs_pipeline === HS_PROJECTS_PIPELINE &&
             /^Project\s*[-–]/i.test(subj) &&
             !/form.?submission/i.test(subj) &&
             !/site.?visit/i.test(subj);   // exclude pure site-visit enquiries if needed
    })
    .map(function(t) { return t.id; });

  Logger.log('HubSpot: rawTickets=' + rawTickets.length + ' projectIds=' + projectIds.length);

  if (!projectIds.length) return [];

  // Step 3 — batch read the filtered tickets with full properties
  // (batch/read is more reliable for custom properties than search)
  var tickets = hsBatchRead(token, 'tickets', projectIds, TICKET_PROPS);

  // Step 4 — drop old jobs (install_date older than 90 days)
  tickets = tickets.filter(function(t) {
    var d = t.properties.install_date;
    return !d || d >= cutoffStr;
  });

  if (!tickets.length) return [];

  // Step 5 — deal values: ticket → deal → line items
  var ticketIds     = tickets.map(function(t) { return t.id; });
  var ticketToDeals = hsBatchAssoc(token, 'tickets', 'deals', ticketIds);

  var dealIdsArr = [];
  Object.keys(ticketToDeals).forEach(function(k) {
    (ticketToDeals[k] || []).forEach(function(id) { dealIdsArr.push(id); });
  });
  var dealIds = hsDedupeArr(dealIdsArr);

  var dealMap = {};
  if (dealIds.length) {
    hsBatchRead(token, 'deals', dealIds, ['amount_in_home_currency']).forEach(function(d) {
      dealMap[d.id] = d;
    });
  }

  // Line items: split by SKU prefix — ST-I-* = install, rest = product/job value
  var dealToLineItems = dealIds.length ? hsBatchAssoc(token, 'deals', 'line_items', dealIds) : {};
  var liIdsArr = [];
  Object.keys(dealToLineItems).forEach(function(k) {
    (dealToLineItems[k] || []).forEach(function(id) { liIdsArr.push(id); });
  });
  var lineItemIds = hsDedupeArr(liIdsArr);

  var lineItemMap = {};
  if (lineItemIds.length) {
    hsBatchRead(token, 'line_items', lineItemIds, ['hs_sku', 'amount']).forEach(function(li) {
      lineItemMap[li.id] = li;
    });
  }

  var dealValues = {};
  dealIds.forEach(function(dealId) {
    var jobVal = 0, installVal = 0;
    (dealToLineItems[dealId] || []).forEach(function(liId) {
      var li = lineItemMap[liId];
      if (!li) return;
      var sku = (li.properties.hs_sku || '').toUpperCase();
      var amt = parseFloat(li.properties.amount || 0) || 0;
      if (/^ST-I-/.test(sku)) {
        installVal += amt;
      } else if (!/^ST-D-/.test(sku)) {
        jobVal += amt; // exclude delivery SKUs from job value
      }
    });
    dealValues[dealId] = {
      jobValue:     Math.round(jobVal     * 100) / 100,
      installValue: Math.round(installVal * 100) / 100
    };
  });

  // Step 6 — contacts: ticket → contact → delivery address
  var ticketToContacts = hsBatchAssoc(token, 'tickets', 'contacts', ticketIds);
  var contactIdsArr = [];
  Object.keys(ticketToContacts).forEach(function(k) {
    (ticketToContacts[k] || []).forEach(function(id) { contactIdsArr.push(id); });
  });
  var contactIds = hsDedupeArr(contactIdsArr);

  var contactMap = {};
  if (contactIds.length) {
    hsBatchRead(token, 'contacts', contactIds,
      ['firstname','lastname','phone','email','address','city','state','zip']
    ).forEach(function(c) {
      contactMap[c.id] = c;
    });
  }

  // Step 7 — build job objects
  var EXTRAS = [
    ['security_pack__project_',                   'Security Pack'],
    ['bi_folds__project_',                        'Bi-folds'],
    ['green_roof__project_',                      'Green Roof'],
    ['joining_panel__project_',                   'Joining Panel'],
    ['storage_hooks__project_',                   'Hooks'],
    ['end_shelves__project_',                     'End Shelf'],
    ['recycling_shelf__project_',                 'Recycling Shelf'],
    ['steadyracks__project_',                     'Steadyracks'],
    ['additional_product_requirements__project_', 'Additional Info']
  ];

  var jobs = tickets.map(function(t) {
    var p = t.properties;

    // Extract numeric job ID from subject e.g. "Project - 1076 - Wilkinson - NW8 9SE"
    var subject  = (p.subject || '').replace(/^Project\s*[-–]\s*/i, '').trim();
    var numMatch = subject.match(/^(\d+)\s*[-–]\s*/);
    var id       = numMatch ? parseInt(numMatch[1], 10) : t.id;
    var name     = numMatch ? subject.replace(/^\d+\s*[-–]\s*/, '').trim() : subject;

    // Values from associated deal
    var dealId   = (ticketToDeals[t.id] || [])[0];
    var deal     = dealId ? dealMap[dealId] : null;
    var orderVal = deal ? (parseFloat(deal.properties.amount_in_home_currency || 0) || 0) : 0;
    var vals     = dealValues[dealId] || { jobValue: 0, installValue: 0 };

    // Contact / delivery address
    var contactId = (ticketToContacts[t.id] || [])[0];
    var cp        = contactId ? (contactMap[contactId] ? contactMap[contactId].properties : {}) : {};
    var addrParts = [cp.address, cp.city, cp.state, cp.zip].filter(function(s) { return s && s.trim(); });
    var deliveryAddress = addrParts.join(', ');

    // Extras
    var extras = [];
    EXTRAS.forEach(function(pair) {
      var val = hsStripHtml(p[pair[0]] || '').trim();
      if (val && val.toLowerCase() !== 'none') extras.push({ label: pair[1], value: val });
    });

    // Model + size
    var model     = p['main_product_type__project_'] || '';
    var size      = p['main_product_size__project_']  || '';
    var modelSize = size ? (model + ' ' + size).trim() : model;

    // Install date — plain string 'YYYY-MM-DD'; browser converts to Date
    var installDate = p.install_date || null;

    return {
      id:              id,
      hubspotId:       t.id,
      name:            name,
      orderVal:        orderVal,
      jobValue:        vals.jobValue,
      installValue:    vals.installValue,
      model:           model,
      modelSize:       modelSize,
      colour:          p['main_product_colour__project_'] || '',
      colourDet:       hsStripHtml(p['colour_details__project_'] || ''),
      supplyType:      p['supply_type__project_'] || '',
      extras:          extras,
      installDate:     installDate,
      postcode:        cp.zip ? cp.zip.trim().toUpperCase() : null,
      contactName:     cp.delivery_full_name || ((cp.firstname || '') + ' ' + (cp.lastname || '')).trim() || '',
      contactPhone:    cp.delivery_telephone_number || cp.phone || '',
      contactEmail:    cp.email || '',
      deliveryAddress: deliveryAddress
    };
  });

  hsCachePut(jobs);
  Logger.log('Fetched ' + jobs.length + ' jobs from HubSpot and cached');
  return jobs;
}

// -- JOB VALUES (job product value + install value split) ----
// Returns { "jobNum": { jobValue: X, installValue: Y }, ... }
// Tries the script cache first (zero API calls if warm).
// Falls back to a targeted HubSpot fetch if cold.

function getJobValues() {
  // ── Cache hit — extract from existing full jobs cache ────────
  var cached = hsCacheGet();
  if (cached) {
    var map = {};
    cached.forEach(function(j) {
      if (j.id != null) map[String(j.id)] = {
        jobValue:     j.jobValue     || 0,
        installValue: j.installValue || 0
      };
    });
    Logger.log('getJobValues: ' + Object.keys(map).length + ' entries from jobs cache');
    return map;
  }

  // ── Cache cold — fetch financial data only from HubSpot ──────
  var token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_API_TOKEN');
  if (!token) throw new Error('HUBSPOT_API_TOKEN not set.');

  // Lightweight ticket search (IDs + subject + pipeline only)
  var rawTickets = hsSearchAll(token, 'tickets', {
    filterGroups: [{ filters: [{ propertyName: 'hs_pipeline_stage', operator: 'EQ', value: '1089431706' }] }],
    properties: ['subject', 'hs_pipeline']
  });

  // Map job number → ticket ID
  var jobNumToTicketId = {};
  rawTickets.forEach(function(t) {
    var p = t.properties, subj = p.subject || '';
    if (p.hs_pipeline !== HS_PROJECTS_PIPELINE) return;
    if (!/^Project\s*[-–]/i.test(subj)) return;
    var m = subj.replace(/^Project\s*[-–]\s*/i, '').match(/^(\d+)\s*[-–]/);
    if (m) jobNumToTicketId[m[1]] = t.id;
  });

  var ticketIds = Object.keys(jobNumToTicketId).map(function(k) { return jobNumToTicketId[k]; });
  if (!ticketIds.length) return {};

  // Tickets → deals
  var ticketToDeals = hsBatchAssoc(token, 'tickets', 'deals', ticketIds);
  var dealIdsArr = [];
  Object.keys(ticketToDeals).forEach(function(k) {
    (ticketToDeals[k] || []).forEach(function(id) { dealIdsArr.push(id); });
  });
  var dealIds = hsDedupeArr(dealIdsArr);
  if (!dealIds.length) return {};

  // Deals → line items
  var dealToLineItems = hsBatchAssoc(token, 'deals', 'line_items', dealIds);
  var liIdsArr = [];
  Object.keys(dealToLineItems).forEach(function(k) {
    (dealToLineItems[k] || []).forEach(function(id) { liIdsArr.push(id); });
  });
  var lineItemIds = hsDedupeArr(liIdsArr);

  var lineItemMap = {};
  if (lineItemIds.length) {
    hsBatchRead(token, 'line_items', lineItemIds, ['hs_sku', 'amount']).forEach(function(li) {
      lineItemMap[li.id] = li;
    });
  }

  // Compute per-deal split
  var dealValues = {};
  dealIds.forEach(function(dealId) {
    var jobVal = 0, installVal = 0;
    (dealToLineItems[dealId] || []).forEach(function(liId) {
      var li = lineItemMap[liId];
      if (!li) return;
      var sku = (li.properties.hs_sku || '').toUpperCase();
      var amt = parseFloat(li.properties.amount || 0) || 0;
      if      (/^ST-I-/.test(sku)) { installVal += amt; }
      else if (!/^ST-D-/.test(sku)) { jobVal     += amt; }
    });
    dealValues[dealId] = {
      jobValue:     Math.round(jobVal     * 100) / 100,
      installValue: Math.round(installVal * 100) / 100
    };
  });

  // Build job number → values map
  var ticketToDeal = {};
  Object.keys(ticketToDeals).forEach(function(tid) {
    var ds = ticketToDeals[tid];
    if (ds && ds.length) ticketToDeal[tid] = ds[0];
  });

  var result = {};
  Object.keys(jobNumToTicketId).forEach(function(jobNum) {
    var dealId = ticketToDeal[jobNumToTicketId[jobNum]];
    if (dealId && dealValues[dealId]) result[jobNum] = dealValues[dealId];
  });

  Logger.log('getJobValues: fetched from HubSpot (' + Object.keys(result).length + ' entries)');
  return result;
}

// -- HUBSPOT CACHE HELPERS -----------------------------------
// Stores job array in Apps Script CacheService (30-minute TTL).
// Chunks into groups of 40 to stay under the 100 KB per-key limit.

var HS_CACHE_PREFIX = 'hs_jobs_v5_';
var HS_CACHE_TTL    = 1800; // seconds (30 min)

function hsCacheGet() {
  try {
    var cache = CacheService.getScriptCache();
    var meta  = cache.get(HS_CACHE_PREFIX + 'meta');
    if (!meta) return null;
    var m    = JSON.parse(meta);
    var jobs = [];
    for (var i = 0; i < m.chunks; i++) {
      var chunk = cache.get(HS_CACHE_PREFIX + i);
      if (!chunk) return null; // partial cache — treat as miss
      jobs = jobs.concat(JSON.parse(chunk));
    }
    return jobs; // installDate stays as 'YYYY-MM-DD' string; browser converts
  } catch(e) {
    Logger.log('hsCacheGet error: ' + e.message);
    return null;
  }
}

function hsCachePut(jobs) {
  try {
    var cache     = CacheService.getScriptCache();
    var CHUNK     = 40;
    var numChunks = Math.ceil(jobs.length / CHUNK);
    for (var i = 0; i < numChunks; i++) {
      cache.put(HS_CACHE_PREFIX + i, JSON.stringify(jobs.slice(i * CHUNK, (i + 1) * CHUNK)), HS_CACHE_TTL);
    }
    cache.put(HS_CACHE_PREFIX + 'meta', JSON.stringify({ chunks: numChunks }), HS_CACHE_TTL);
  } catch(e) {
    Logger.log('hsCachePut error: ' + e.message);
  }
  // Also write a compact copy to getUserCache so the Route Planner can read it
  // without making its own HubSpot API calls.
  try {
    var compact = jobs.map(function(j) {
      return {
        id:              j.id,
        name:            j.name,
        postcode:        j.postcode        || null,
        amount:          (j.jobValue || 0) + (j.installValue || 0) || null,
        date:            j.installDate     || null,
        product_type:    j.model           || null,
        supply_type:     j.supplyType      || null,
        contactName:     j.contactName     || null,
        contactPhone:    j.contactPhone    || null,
        deliveryAddress: j.deliveryAddress || null
      };
    });
    var uCache    = CacheService.getUserCache();
    var CHUNK     = 40;
    var RP_TTL    = 21600; // 6 hours — max for getUserCache; keeps route planner fed all day
    var numChunks = Math.ceil(compact.length / CHUNK);
    for (var i = 0; i < numChunks; i++) {
      uCache.put('bsc_rp_v2_' + i, JSON.stringify(compact.slice(i * CHUNK, (i + 1) * CHUNK)), RP_TTL);
    }
    uCache.put('bsc_rp_v2_meta', JSON.stringify({ chunks: numChunks }), RP_TTL);
  } catch(e) {
    Logger.log('hsCachePut (userCache) error: ' + e.message);
  }
}

// Write REVCAP job data to a shared Drive file so the Route Planner can read it.
// Drive files are accessible across Apps Script projects; user cache is not.
var RP_DRIVE_FILENAME = 'bsc_route_data.json';
function saveRevcapRouteJobs(jobsJson) {
  try {
    var files = DriveApp.getFilesByName(RP_DRIVE_FILENAME);
    if (files.hasNext()) {
      files.next().setContent(jobsJson);
    } else {
      DriveApp.createFile(RP_DRIVE_FILENAME, jobsJson, MimeType.PLAIN_TEXT);
    }
    Logger.log('Saved REVCAP route jobs to Drive: ' + RP_DRIVE_FILENAME);
  } catch(e) {
    Logger.log('saveRevcapRouteJobs error: ' + e.message);
    throw e;
  }
}

function hsCacheInvalidate() {
  try {
    var cache = CacheService.getScriptCache();
    var meta  = cache.get(HS_CACHE_PREFIX + 'meta');
    if (meta) {
      var m = JSON.parse(meta);
      for (var i = 0; i < m.chunks; i++) cache.remove(HS_CACHE_PREFIX + i);
      cache.remove(HS_CACHE_PREFIX + 'meta');
    }
  } catch(e) {}
}

// -- HUBSPOT HTTP HELPERS ------------------------------------

function hsPost(token, path, body) {
  var resp = UrlFetchApp.fetch(HS_BASE + path, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code >= 300) throw new Error('HubSpot ' + path + ' → HTTP ' + code + ': ' + resp.getContentText().substring(0, 300));
  return JSON.parse(resp.getContentText());
}

// Paginate search results (up to 200 per page)
function hsSearchAll(token, objectType, body) {
  var all = [], after = null;
  do {
    var req = JSON.parse(JSON.stringify(body));
    req.limit = 200;
    if (after) req.after = after;
    var data = hsPost(token, '/crm/v3/objects/' + objectType + '/search', req);
    all   = all.concat(data.results || []);
    after = data.paging && data.paging.next ? data.paging.next.after : null;
  } while (after);
  return all;
}

// Batch associations — returns { fromId: [toId, ...], ... }
function hsBatchAssoc(token, fromType, toType, ids) {
  var map = {};
  for (var i = 0; i < ids.length; i += 100) {
    var chunk = ids.slice(i, i + 100);
    var data  = hsPost(token, '/crm/v3/associations/' + fromType + '/' + toType + '/batch/read', {
      inputs: chunk.map(function(id) { return { id: id }; })
    });
    (data.results || []).forEach(function(r) {
      map[r.from.id] = (r.to || []).map(function(x) { return x.id; });
    });
  }
  return map;
}

// Batch read objects — returns array of { id, properties }
function hsBatchRead(token, objectType, ids, properties) {
  var all = [];
  for (var i = 0; i < ids.length; i += 100) {
    var chunk = ids.slice(i, i + 100);
    var data  = hsPost(token, '/crm/v3/objects/' + objectType + '/batch/read', {
      inputs: chunk.map(function(id) { return { id: id }; }),
      properties: properties
    });
    all = all.concat(data.results || []);
  }
  return all;
}

function hsDedupeArr(arr) {
  var seen = {}, out = [];
  arr.forEach(function(v) { if (!seen[v]) { seen[v] = true; out.push(v); } });
  return out;
}

function hsStripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// -- DATE NORMALISATION ------------------------------------------
// HubSpot stores date properties as midnight in the portal's timezone
// (Europe/London). The v3 API returns the UTC date of that midnight,
// which is one day behind during BST (late Mar – late Oct).
//
// Fix: treat 23:00 UTC on the returned date as the true local midnight
// and format in Europe/London — during BST this rolls forward one day,
// during GMT it stays the same.

function normalizeHsDate(val) {
  if (!val) return null;
  var s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // Parse 23:00 UTC on the returned date and format in Europe/London.
    // BST:  23:00 UTC = midnight BST next day  → adds 1 day  ✓
    // GMT:  23:00 UTC = 23:00 GMT same day     → unchanged   ✓
    return Utilities.formatDate(new Date(s + 'T23:00:00Z'), 'Europe/London', 'yyyy-MM-dd');
  }
  // Unix ms timestamp (older HubSpot API responses)
  var n = Number(s);
  if (!isNaN(n) && n > 1e11) {
    return Utilities.formatDate(new Date(n), 'Europe/London', 'yyyy-MM-dd');
  }
  return null;
}

// -- ROUTE PLANNER CONFIG ----------------------------------------
var RP_HARDCODED_URL = 'https://script.google.com/a/macros/thebikeshedcompany.com/s/AKfycbx-qWV7LRm05eHZosUlc7s2JwOtXXOK0Cw887ko_OG52C6JmU3V-vQGGwkT8icXg5Bz/exec';

function getConfig() {
  return {
    routePlannerUrl: RP_HARDCODED_URL
  };
}

// ============================================================
// HELPER: GET OR CREATE STATE SHEET TAB -------------------

function getOrCreateStateSheet() {
  var ss    = getOrCreateStateSS();
  var sheet = ss.getSheetByName(STATE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(STATE_SHEET_NAME);
    sheet.appendRow(['Job ID', 'State JSON', 'Last Updated', 'Updated By']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#2d5a27').setFontColor('#ffffff');
    sheet.setColumnWidth(1, 80);
    sheet.setColumnWidth(2, 600);
    sheet.setColumnWidth(3, 160);
    sheet.setColumnWidth(4, 240);
  }
  return sheet;
}
