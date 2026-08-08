// ============================================================
// BSC Production Hub — Production scheduler backend
// Stage 2: plan build weeks around dispatch dates, batching the
// spray booth by finish. One shed = one card.
// ============================================================

function getSchedulerData(forceRefresh) {
  return cachedPayload_('payload_scheduler', forceRefresh, function() {
    return buildSchedulerData_(forceRefresh);
  });
}

function buildSchedulerData_(forceRefresh) {
  var live      = fetchLiveData(forceRefresh);
  var jobsState = {};
  storeReadLatest(CONFIG.TABS.jobs, 'shed_id').forEach(function(r) { jobsState[r.shed_id] = r; });
  // Dispatch state is per-shed now (was per-deal)
  var dispatchState = {};
  storeReadLatest(CONFIG.TABS.dispatch, 'shed_id').forEach(function(r) {
    if (r.shed_id) dispatchState[String(r.shed_id).trim()] = r;
  });

  var jobs = live.sheds.map(function(j) {
    var s  = jobsState[j.id] || {};
    var ds = dispatchState[j.id] || {};

    var standard = estimateBuildDays_(j.shedType);
    var override = s.override_build_days !== '' && s.override_build_days !== undefined
      ? parseFloat(s.override_build_days) : null;
    // Build-time precedence (same rule as Reports/Day sheets): explicit app
    // override > HubSpot estimated_build_hours > standard BUILD_DAYS. Before
    // 2026-08-07 capacity ignored the HubSpot estimate entirely, so a bespoke
    // with estimated_build_hours counted as 0 here but not on day sheets.
    var estDays = j.estBuildHours ? j.estBuildHours / CONFIG.PRODUCTIVE_HRS_PER_DAY : null;

    var plan = resolvePlanningInfo_(j, ds);

    return Object.assign({}, j, plan, {
      plannedWeek:          s.planned_week || '',
      plannedDay:           s.planned_day || '',
      plannedSprayDate:     s.planned_spray_date || '',
      plannedAssemblyDate:  s.planned_assembly_date || '',
      overrideBuildDays:    override,
      standardBuildDays:    standard,          // frontend can restore this on override clear
      buildDays:            override !== null ? override : (estDays !== null ? estDays : standard),
      isBespoke:            isBespoke_(j.shedType),
      needsDrawings:        needsDrawings_(j.shedType),
      weekLocked:           s.week_locked === 'TRUE' || s.week_locked === true,
      sprayBatchId:         s.spray_batch_id || '',
      notes:                s.notes || '',
      // Drawing/buying gates (Dan ticks these; bespoke jobs must not start
      // production until SKP + LYT are done)
      skpDone:              s.skp_done === 'TRUE',
      skpDoneDate:          s.skp_done_date || '',
      lytDone:              s.lyt_done === 'TRUE',
      lytDoneDate:          s.lyt_done_date || '',
      sedumOrdered:         s.sedum_ordered === 'TRUE',
      stagesDone:           countStagesDone_(s)
    });
  });

  return {
    jobs: jobs,
    leave: getTimetasticLeave(forceRefresh),
    config: getClientConfig(),
    timestamp: live.timestamp
  };
}

// Persist a scheduling decision. Only these fields; null clears.
function saveAllocation(shedId, alloc) {
  var allowed = {};
  ['planned_week', 'planned_day', 'planned_spray_date', 'planned_assembly_date',
   'override_build_days', 'week_locked', 'spray_batch_id', 'notes',
   'skp_done', 'skp_done_date', 'lyt_done', 'lyt_done_date', 'sedum_ordered']
    .forEach(function(k) { if (alloc && k in alloc) allowed[k] = alloc[k]; });
  return storeUpsert(CONFIG.TABS.jobs, 'shed_id', shedId, allowed);
}

// Batch apply a spray plan: [{shedId, planned_spray_date, planned_assembly_date, planned_week}]
function saveSprayPlan(entries) {
  (entries || []).forEach(function(e) {
    saveAllocation(e.shedId, {
      planned_week:          e.planned_week,
      planned_spray_date:    e.planned_spray_date || null,
      planned_assembly_date: e.planned_assembly_date || null
    });
  });
  return { ok: true, count: (entries || []).length, timestamp: new Date().toISOString() };
}

// ── Build-time helpers ───────────────────────────────────────

function estimateBuildDays_(shedType) {
  if (!shedType) return null;
  // Green-roof SKUs fall back to the base model (CONFIG.TYPE_ALIASES):
  // candidates are tried in order, so a future explicit PGR/BSGR entry wins.
  var cands = typeMatchCandidates_(shedType);
  var keys = Object.keys(CONFIG.BUILD_DAYS);
  for (var c = 0; c < cands.length; c++) {
    for (var i = 0; i < keys.length; i++) {
      if (cands[c].indexOf(keys[i].toUpperCase()) === 0) return CONFIG.BUILD_DAYS[keys[i]];
    }
  }
  return null; // bespoke — no standard estimate
}

function isBespoke_(shedType) {
  if (!shedType) return false;
  if (/besp/i.test(shedType)) return true;
  return estimateBuildDays_(shedType) === null;
}

// SKP/LYT drawing gates apply to every bespoke AND all BAY-bike variants
// (Dan, 2026-08-07: bay-style builds always need drawings even though
// BAY-bike has a standard build time).
function needsDrawings_(shedType) {
  return isBespoke_(shedType) || /bay/i.test(shedType || '');
}

function countStagesDone_(stateRow) {
  var count = 0;
  CONFIG.STAGES.forEach(function(s) {
    var v = stateRow['stage_' + s.key];
    if (v === 'TRUE' || v === true || v === 'true') count++;
  });
  return count;
}

// ── Timetastic ───────────────────────────────────────────────

function getTimetasticLeave(forceRefresh) {
  var cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    var cached = cache.get(CONFIG.TT_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  }

  var apiKey = PropertiesService.getScriptProperties().getProperty('TIMETASTIC_API_KEY');
  if (!apiKey) return { error: 'TIMETASTIC_API_KEY not set', leaves: [] };

  // Rolling window: 1 week back (overdue views) to 8 weeks ahead
  var start = Utilities.formatDate(new Date(Date.now() - 7 * 86400000),  CONFIG.TIMEZONE, 'yyyy-MM-dd');
  var end   = Utilities.formatDate(new Date(Date.now() + 56 * 86400000), CONFIG.TIMEZONE, 'yyyy-MM-dd');

  try {
    var resp = UrlFetchApp.fetch(
      'https://app.timetastic.co.uk/api/holidays?start=' + start + '&end=' + end,
      { headers: { 'Authorization': 'Bearer ' + apiKey }, muteHttpExceptions: true }
    );
    if (resp.getResponseCode() !== 200) {
      return { error: 'Timetastic HTTP ' + resp.getResponseCode(), leaves: [] };
    }
    var leaves = (JSON.parse(resp.getContentText()).holidays || [])
      .filter(function(h) {
        return h.status === 'Approved' && CONFIG.WORKSHOP_TEAM.indexOf(h.userName) > -1;
      })
      .map(function(h) {
        return {
          name:      h.userName,
          startDate: (h.startDate || '').substring(0, 10),
          endDate:   (h.endDate   || '').substring(0, 10),
          startType: h.startType  || 'Morning',
          endType:   h.endType    || 'Afternoon',
          leaveType: h.leaveTypeName || 'Leave'
        };
      });

    var result = { leaves: leaves, fetched: new Date().toISOString() };
    cache.put(CONFIG.TT_CACHE_KEY, JSON.stringify(result), CONFIG.TT_CACHE_TTL);
    return result;
  } catch (e) {
    return { error: e.message, leaves: [] };
  }
}
