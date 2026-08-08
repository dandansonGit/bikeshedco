// ============================================================
// BSC Production Hub — Production tracker backend
// Stage 3: shop-floor stage tick-off, QC faults, odd jobs.
// ============================================================

// Jobs + state in ONE call (the old app raced two separate fetches).
function getTrackerData(forceRefresh) {
  return cachedPayload_('payload_tracker', forceRefresh, function() {
    return buildTrackerData_(forceRefresh);
  });
}

function buildTrackerData_(forceRefresh) {
  var live = fetchLiveData(forceRefresh);
  // Dispatch state is per SHED since v10 — this read was still keyed by
  // deal_id (missed in the per-shed rewrite), so app-side dispatch drafts
  // never reached Tracker planning dates. Fixed 2026-07-16.
  var dispatchState = {};
  storeReadLatest(CONFIG.TABS.dispatch, 'shed_id').forEach(function(r) {
    if (r.shed_id) dispatchState[String(r.shed_id).trim()] = r;
  });

  // Same planning-date resolution as the Scheduler/Dispatch views — the
  // Tracker used to show the shed's raw (often stale) install_date instead,
  // which is exactly what made it disagree with the other two views.
  var jobs = live.sheds.map(function(j) {
    var plan = resolvePlanningInfo_(j, dispatchState[j.id] || {});
    return Object.assign({}, j, plan);
  });

  return {
    jobs: jobs,
    state: storeReadLatest(CONFIG.TABS.jobs, 'shed_id'),
    config: getClientConfig(),
    timestamp: live.timestamp
  };
}

// Save a DELTA of fields for one shed. null clears a field — so deleting
// a note, clearing fault text or un-completing a stage's date actually
// persists (the old app silently ignored empties).
function saveJobState(shedId, delta) {
  var allowed = {};
  Object.keys(delta || {}).forEach(function(k) {
    if (k !== 'shed_id' && CONFIG.JOBS_HEADERS.indexOf(k) > -1) allowed[k] = delta[k];
  });
  var result = storeUpsert(CONFIG.TABS.jobs, 'shed_id', shedId, allowed);

  // Marking Dispatched writes the permanent Archive snapshot (all stage
  // dates); un-ticking Dispatched un-archives it again (Dan, 2026-07-16).
  if (allowed.stage_dispatched === 'TRUE' || allowed.stage_dispatched === true) {
    try { archiveDispatchedJob_(shedId); } catch (e) { Logger.log('archive: ' + e.message); }
  } else if ('stage_dispatched' in allowed) {
    try { storeUpsert(CONFIG.TABS.archive, 'shed_id', shedId, { restored: 'TRUE' }); } catch (e2) {}
  }
  return result;
}

// ── Archive (completed jobs keep their history) ──────────────

function archiveDispatchedJob_(shedId) {
  var id = String(shedId).trim();
  var state = null;
  storeReadLatest(CONFIG.TABS.jobs, 'shed_id').forEach(function(r) {
    if (String(r.shed_id).trim() === id) state = r;
  });
  state = state || {};

  var job = null;
  try {
    var live = fetchLiveData(false);
    for (var i = 0; i < live.sheds.length; i++) {
      if (live.sheds[i].id === id) { job = live.sheds[i]; break; }
    }
  } catch (e) {}
  job = job || {};

  var fields = {
    shed_name:      job.jobRef || state.job_ref || '',
    shed_type:      job.shedType || state.shed_type || '',
    finish:         job.finish || state.finish || '',
    deal_id:        job.dealId || '',
    post_code:      job.postCode || '',
    dispatch_value: job.perShedValue || '',
    product_value:  job.productValue || '',
    notes:          state.notes || '',
    archived_at:    new Date().toISOString(),
    restored:       null
  };
  ['planned_week', 'planned_spray_date', 'planned_assembly_date',
   'stage_cut_date', 'stage_framed_date', 'stage_component_prep_date',
   'stage_qc1_date', 'stage_qc1_faults', 'stage_qc1_fault_cats',
   'stage_spray_prep_date', 'stage_sprayed_date',
   'stage_qc2_date', 'stage_qc2_faults', 'stage_qc2_fault_cats',
   'stage_assembled_date',
   'stage_qc3_date', 'stage_qc3_faults', 'stage_qc3_fault_cats',
   'stage_dispatched_date', 'lid_complete_date',
   'stage_cut_by', 'stage_framed_by', 'stage_component_prep_by',
   'stage_qc1_by', 'stage_spray_prep_by', 'stage_sprayed_by',
   'stage_qc2_by', 'stage_assembled_by', 'stage_qc3_by',
   'stage_dispatched_by', 'lid_complete_by'].forEach(function(k) { fields[k] = state[k] || ''; });

  return storeUpsert(CONFIG.TABS.archive, 'shed_id', shedId, fields);
}

// Newest first; restored (un-archived) rows are hidden.
function getArchive() {
  return storeReadLatest(CONFIG.TABS.archive, 'shed_id')
    .filter(function(r) { return r.shed_id && r.restored !== 'TRUE'; })
    .sort(function(a, b) { return String(b.archived_at).localeCompare(String(a.archived_at)); })
    .slice(0, 300);
}

// Un-archive: hide the snapshot and un-tick Dispatched on the live row so
// the job reappears in the Tracker (mistaken tick — Dan, 2026-07-16).
function restoreArchived(shedId) {
  storeUpsert(CONFIG.TABS.archive, 'shed_id', shedId, { restored: 'TRUE' });
  storeUpsert(CONFIG.TABS.jobs, 'shed_id', shedId,
    { stage_dispatched: 'FALSE', stage_dispatched_date: null });
  return { ok: true };
}

// Odd jobs: mark one or many sheds done ('' / null clears).
function saveBatchOddJob(taskKey, shedIds, value) {
  var valid = CONFIG.ODD_JOBS.some(function(oj) { return oj.key === taskKey; });
  if (!valid) throw new Error('Unknown odd-job key: ' + taskKey);
  var v = (value === undefined) ? new Date().toISOString() : value;
  return storeBatchSetField(CONFIG.TABS.jobs, 'shed_id', shedIds, taskKey, v);
}
