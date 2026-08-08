// ============================================================
// BSC Production Hub — Dispatch planner backend
// Stage 1 of the three-stage model: propose dispatch dates to
// customers, geo-optimised into install days, then hand confirmed
// dates to the production scheduler.
//
// Dispatch is planned per SHED (one card per shed), NOT per deal:
// a deal's sheds can go to different sites on different dates. Dispatch
// state lives in the Dispatch tab, one row per shed (keyed shed_id).
// Status flow: (unplanned) → draft → proposed → confirmed.
// ============================================================

function getDispatchData(forceRefresh) {
  return cachedPayload_('payload_dispatch', forceRefresh, function() {
    return buildDispatchData_(forceRefresh);
  });
}

function buildDispatchData_(forceRefresh) {
  var live  = fetchLiveData(forceRefresh);
  var state = {};
  storeReadLatest(CONFIG.TABS.dispatch, 'shed_id').forEach(function(r) {
    if (r.shed_id) state[String(r.shed_id).trim()] = r;
  });

  var amendments = live.amendments || [];
  var allPostcodes = live.sheds.map(function(j) { return j.postCode; })
    .concat(amendments.map(function(a) { return a.postCode; }))
    .concat([CONFIG.INSTALL_DAY.WORKSHOP_POSTCODE]);   // day-hours estimate uses it too
  var coords = geocodePostcodes_(allPostcodes);

  var today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  var jobs = live.sheds.map(function(j) {
    var s  = state[j.id] || {};
    var pc = normalizePostcode_(j.postCode);

    // Status resolution: HubSpot's shed dispatch_status (Proposed/Confirmed,
    // set by sales) beats the app's internal draft state. When HubSpot owns
    // the status, the shed's dispatch_date (install_date) IS the proposed/
    // confirmed date.
    var hs = j.hsDispatchStatus;
    var fromHubspot = (hs === 'proposed' || hs === 'confirmed');
    var status = fromHubspot ? hs : (s.dispatch_status || '');
    var proposedDate = fromHubspot ? (j.targetDispatchDate || '')
                                   : (s.proposed_dispatch_date || '');

    // 14-day penalty window: moving a confirmed date this close incurs a fee
    var inPenaltyWindow = status === 'confirmed' && proposedDate &&
      today >= addDays_(proposedDate, -CONFIG.PENALTY_WINDOW_DAYS) &&
      today <= proposedDate;

    return Object.assign({}, j, {
      name:          j.jobRef,             // shed hs_name (display name)
      numSheds:      1,                    // a card is one shed
      coords:        pc && coords[pc] ? coords[pc] : null,
      area:          pc ? outwardCode_(pc) : '',
      proposedDate:  proposedDate,
      status:        status,
      statusSource:  fromHubspot ? 'hubspot' : (status ? 'app' : ''),
      inPenaltyWindow: inPenaltyWindow,
      singleDay:     s.single_day === 'TRUE',
      group:         s.dispatch_group || '',
      dispatchNotes: s.notes || '',
      hsUrl: 'https://app.hubspot.com/contacts/' + CONFIG.HS_PORTAL_ID + '/record/' + CONFIG.HS_SHED_TYPE + '/' + j.id
    });
  });

  amendments = amendments.map(function(a) {
    var pc = normalizePostcode_(a.postCode);
    return Object.assign({}, a, {
      coords: pc && coords[pc] ? coords[pc] : null,
      area:   pc ? outwardCode_(pc) : ''
    });
  });

  // Per-day planning notes (expanded week view)
  var dayNotes = {};
  storeReadLatest(CONFIG.TABS.dayNotes, 'day').forEach(function(r) {
    if (r.day && r.notes) dayNotes[r.day] = r.notes;
  });

  // Estimated crew hours per placed day (drive + install, speed model) —
  // the board divides day/week £ value by these for the rev/hour guestimate.
  // Only crew-served jobs (Install / team delivery) consume crew hours.
  var workshop = coords[normalizePostcode_(CONFIG.INSTALL_DAY.WORKSHOP_POSTCODE)] ||
                 { lat: 51.4545, lng: -2.5879 };
  var byDay = {};
  jobs.forEach(function(j) {
    if (j.proposedDate && j.geoEligible && !j.onHold) {
      (byDay[j.proposedDate] = byDay[j.proposedDate] || []).push(j);
    }
  });
  var dayHours = {};
  Object.keys(byDay).forEach(function(day) {
    dayHours[day] = estimatePlacedDayHours_(byDay[day], workshop);
  });

  return {
    jobs: jobs,
    amendments: amendments,
    amendmentsError: live.amendmentsError || null,
    dayNotes: dayNotes,
    dayHours: dayHours,
    config: getClientConfig(),
    timestamp: live.timestamp
  };
}

// Read-only look-back: archived (dispatched) sheds whose dispatch date
// falls inside [startIso, endIso], so past weeks on the board can show
// what actually shipped. Each job is placed on its PLANNED dispatch date
// (Dispatch tab — the day the van went out per the planner), falling back
// to the archive's actual ticked date. Deliberately NOT in the cached
// view payload: it's a small read, fetched only when the user navigates
// into past weeks.
function getDispatchHistory(startIso, endIso) {
  var isoRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoRe.test(String(startIso || '')) || !isoRe.test(String(endIso || ''))) {
    throw new Error('getDispatchHistory: bad date range');
  }
  var planned = {};
  storeReadLatest(CONFIG.TABS.dispatch, 'shed_id').forEach(function(r) {
    if (r.shed_id) planned[String(r.shed_id).trim()] = r;
  });
  var jobs = [];
  storeReadLatest(CONFIG.TABS.archive, 'shed_id').forEach(function(r) {
    if (!r.shed_id || r.restored === 'TRUE') return;
    var actual = String(r.stage_dispatched_date || '').substring(0, 10);
    var p = planned[String(r.shed_id).trim()] || {};
    var date = p.proposed_dispatch_date || actual;
    if (!date || date < startIso || date > endIso) return;
    jobs.push({
      id:        r.shed_id,
      name:      r.shed_name || String(r.shed_id),
      shedType:  r.shed_type || '',
      finish:    r.finish || '',
      postCode:  p.post_code || r.post_code || '',
      date:      date,
      actualDate: actual,
      value:     parseFloat(r.dispatch_value) || 0
    });
  });
  return { start: startIso, end: endIso, jobs: jobs };
}

// Save the free-text note for one dispatch day (null/empty clears).
function saveDayNote(day, notes) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) {
    throw new Error('saveDayNote: bad day "' + day + '"');
  }
  return storeUpsert(CONFIG.TABS.dayNotes, 'day', day, { notes: notes || null });
}

// Suggestions are full install DAYS — see Planner.gs (suggestInstallDays).

// Place / move / clear a shed on the board.
// fields: { proposed_dispatch_date, dispatch_group, notes, single_day } (null clears).
// Clearing the date resets status to unplanned.
function saveDispatch(shedId, fields) {
  var allowed = {};
  ['proposed_dispatch_date', 'dispatch_group', 'notes', 'single_day'].forEach(function(k) {
    if (fields && k in fields) allowed[k] = fields[k];
  });

  // HubSpot-managed statuses can't be rearranged from the app
  if ('proposed_dispatch_date' in allowed) {
    var hs = hsStatusForShed_(shedId);
    if (hs === 'proposed' || hs === 'confirmed') {
      throw new Error('This shed is marked ' + hs + ' in HubSpot — change its dispatch_status/date there, then Refresh.');
    }
  }

  if ('proposed_dispatch_date' in allowed && allowed.proposed_dispatch_date === null) {
    allowed.dispatch_status = null;   // off the board → unplanned
    allowed.dispatch_group  = null;
  } else if ('proposed_dispatch_date' in allowed) {
    // Placing/moving a card: confirmed dates must be un-confirmed first
    var existing = findDispatchRow_(shedId);
    if (existing && existing.dispatch_status === 'confirmed') {
      throw new Error('This dispatch date is confirmed with the client. Set it back to draft before moving it.');
    }
    if (!existing || !existing.dispatch_status) allowed.dispatch_status = 'draft';
  }

  denormaliseShed_(shedId, allowed);
  return storeUpsert(CONFIG.TABS.dispatch, 'shed_id', shedId, allowed);
}

function hsStatusForShed_(shedId) {
  try {
    var live = fetchLiveData(false);
    for (var i = 0; i < live.sheds.length; i++) {
      if (live.sheds[i].id === String(shedId)) return live.sheds[i].hsDispatchStatus || '';
    }
  } catch (e) {}
  return '';
}

// Status transitions, with the finish gate the spray booth depends on.
function setDispatchStatus(shedId, status) {
  if (CONFIG.DISPATCH_STATUSES.indexOf(status) === -1) {
    throw new Error('Unknown dispatch status: ' + status);
  }
  var hs = hsStatusForShed_(shedId);
  if (hs === 'proposed' || hs === 'confirmed') {
    throw new Error('This shed\'s status is managed in HubSpot (currently ' + hs + ') — update dispatch_status there, then Refresh.');
  }
  var row = findDispatchRow_(shedId);
  if (!row || !row.proposed_dispatch_date) {
    throw new Error('Place the shed on a dispatch date before changing its status.');
  }

  if (status === 'proposed' || status === 'confirmed') {
    var live = fetchLiveData(false);
    var shed = null;
    for (var i = 0; i < live.sheds.length; i++) {
      if (live.sheds[i].id === String(shedId)) { shed = live.sheds[i]; break; }
    }
    if (shed && shed.missingFinish) {
      throw new Error('Cannot propose a dispatch date until this shed has a colour/finish (spray batching needs it).');
    }
  }

  var fields = { dispatch_status: status };
  denormaliseShed_(shedId, fields);
  return storeUpsert(CONFIG.TABS.dispatch, 'shed_id', shedId, fields);
}

// Accept a suggestion: place every shed in the group on the suggested date.
function applySuggestedGroup(shedIds, date, groupLabel) {
  var results = [];
  (shedIds || []).forEach(function(id) {
    results.push(saveDispatch(id, {
      proposed_dispatch_date: date,
      dispatch_group: groupLabel || ''
    }));
  });
  return { ok: true, count: results.length };
}

// ── helpers ──────────────────────────────────────────────────

function findDispatchRow_(shedId) {
  var id = String(shedId).trim();
  var rows = storeReadLatest(CONFIG.TABS.dispatch, 'shed_id');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].shed_id).trim() === id) return rows[i];
  }
  return null;
}

// Keep human-readable columns on the Dispatch tab in sync with HubSpot.
function denormaliseShed_(shedId, fields) {
  try {
    var live = fetchLiveData(false);
    for (var i = 0; i < live.sheds.length; i++) {
      var j = live.sheds[i];
      if (j.id === String(shedId)) {
        fields.shed_name           = j.jobRef;
        fields.deal_id             = j.dealId || '';  // legacy col kept populated
        fields.deal_name           = j.jobRef;        // legacy col kept populated
        fields.post_code           = j.postCode;
        fields.target_dispatch_date = j.targetDispatchDate || '';
        break;
      }
    }
  } catch (e) { /* denormalised columns are cosmetic — never block a save */ }
}
