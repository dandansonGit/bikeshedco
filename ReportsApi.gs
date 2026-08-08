// ============================================================
// BSC Production Hub — Efficiency reports backend (Dan, 2026-07-17)
// The board numbers: value produced (earned from stage ticks × DRAFT
// hour-share weights × product value), value dispatched, dispatch
// service £ added to production at REPORTING stage (Dan's decision —
// no separate install-crew target), revenue per SOLD hour vs revenue
// per PAID hour (workshop and combined incl. install crew), and
// utilisation — per day / week / month, plus per-person patterns.
// Product value: HubSpot shed_value, else derived from deal line items
// (single-shed deals); coverage gaps are reported, never guessed.
// ============================================================

function getReportsData(forceRefresh) {
  return cachedPayload_('payload_reports', forceRefresh, function() {
    return buildReportsData_(forceRefresh);
  });
}

var REPORT_STAGE_KEYS_ = ['cut', 'framed', 'component_prep', 'qc1', 'spray_prep',
  'sprayed', 'qc2', 'assembled', 'qc3', 'dispatched'];

function buildReportsData_(forceRefresh) {
  var live = fetchLiveData(forceRefresh);
  var W = CONFIG.STAGE_HOUR_WEIGHTS;

  var jobsState = {};
  storeReadLatest(CONFIG.TABS.jobs, 'shed_id').forEach(function(r) {
    if (r.shed_id) jobsState[String(r.shed_id).trim()] = r;
  });
  var liveById = {};
  live.sheds.forEach(function(j) { liveById[j.id] = j; });
  var archiveRows = storeReadLatest(CONFIG.TABS.archive, 'shed_id')
    .filter(function(r) { return r.shed_id && r.restored !== 'TRUE' && !liveById[String(r.shed_id).trim()]; });

  // Build-time precedence (one rule app-wide since 2026-08-07): explicit
  // app override > HubSpot estimated_build_hours > standard BUILD_DAYS
  function hoursFor(shedType, overrideDays, estHours) {
    var override = overrideDays ? parseFloat(overrideDays) : null;
    if (override) return override * CONFIG.PRODUCTIVE_HRS_PER_DAY;
    if (estHours) return estHours;
    var days = estimateBuildDays_(shedType);
    return days ? days * CONFIG.PRODUCTIVE_HRS_PER_DAY : 0;
  }
  function dayOf(iso) { return String(iso || '').substring(0, 10); }

  // ── Events: every stage completion earns weight × value/hours ──
  var events = [];        // {day, val, hrs, who, stage, name}
  var dispatchEvents = []; // {day, svc, product, name}
  var missingValue = [], multiShedReview = [], noHours = [];

  live.sheds.forEach(function(j) {
    var s = jobsState[j.id] || {};
    var value = j.productValue || 0;
    var hours = hoursFor(j.shedType, s.override_build_days, j.estBuildHours);
    if (!value) missingValue.push(j.jobRef);
    if (j.valueSource === 'multi_shed_review') multiShedReview.push(j.jobRef);
    if (!hours) noHours.push(j.jobRef);
    REPORT_STAGE_KEYS_.forEach(function(k) {
      var d = s['stage_' + k + '_date'];
      if (!d) return;
      events.push({ day: dayOf(d), val: value * (W[k] || 0), hrs: hours * (W[k] || 0),
                    who: s['stage_' + k + '_by'] || '', stage: k, name: j.jobRef });
    });
    if (s.stage_dispatched_date) {
      dispatchEvents.push({ day: dayOf(s.stage_dispatched_date),
        svc: j.perShedValue || 0, product: value, name: j.jobRef });
    }
  });
  archiveRows.forEach(function(r) {
    var value = parseFloat(r.product_value) || 0;
    var hours = hoursFor(r.shed_type, '', 0);
    REPORT_STAGE_KEYS_.forEach(function(k) {
      var d = r['stage_' + k + '_date'];
      if (!d) return;
      events.push({ day: dayOf(d), val: value * (W[k] || 0), hrs: hours * (W[k] || 0),
                    who: r['stage_' + k + '_by'] || '', stage: k, name: r.shed_name });
    });
    if (r.stage_dispatched_date) {
      dispatchEvents.push({ day: dayOf(r.stage_dispatched_date),
        svc: parseFloat(r.dispatch_value) || 0, product: value, name: r.shed_name });
    }
  });

  // ── Period buckets ──────────────────────────────────────────
  var today = new Date();
  var todayIso = Utilities.formatDate(today, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  var holidays = getBankHolidays_();

  function mondayOf(iso) {
    var d = parseIsoDate_(iso);
    var dow = (d.getUTCDay() + 6) % 7;
    return addDays_(iso, -dow);
  }
  function monthOf(iso) { return String(iso).substring(0, 7); }
  function isWorkday(iso) {
    var dow = parseIsoDate_(iso).getUTCDay();
    return dow >= 1 && dow <= 5 && !holidays[iso];
  }
  // Workdays elapsed in a period, capped at today (never count the future)
  function workdaysBetween(startIso, endIso) {
    var n = 0, end = endIso < todayIso ? endIso : todayIso;
    for (var d = startIso; d <= end; d = addDays_(d, 1)) if (isWorkday(d)) n++;
    return n;
  }

  var leave = [];
  try { leave = (getTimetasticLeave(false) || {}).leaves || []; } catch (e) {}
  function leaveHrs(startIso, endIso) {
    var hrs = 0, end = endIso < todayIso ? endIso : todayIso;
    leave.forEach(function(l) {
      for (var d = (l.startDate > startIso ? l.startDate : startIso);
           d <= (l.endDate < end ? l.endDate : end); d = addDays_(d, 1)) {
        if (isWorkday(d)) hrs += CONFIG.PAID_HRS_PER_DAY;   // half-days ignored (v1)
      }
    });
    return hrs;
  }

  function bucketRow(label, startIso, endIso) {
    var produced = 0, soldHrs = 0, svc = 0, dispatchedProduct = 0, jobsOut = 0;
    events.forEach(function(ev) {
      if (ev.day >= startIso && ev.day <= endIso) { produced += ev.val; soldHrs += ev.hrs; }
    });
    dispatchEvents.forEach(function(ev) {
      if (ev.day >= startIso && ev.day <= endIso) { svc += ev.svc; dispatchedProduct += ev.product; jobsOut++; }
    });
    var wd = workdaysBetween(startIso, endIso);
    var paidWs = Math.max(0, CONFIG.WORKSHOP_TEAM.length * CONFIG.PAID_HRS_PER_DAY * wd - leaveHrs(startIso, endIso));
    var paidComb = paidWs + (CONFIG.INSTALL_DAY.paidManHrsPerWeek / 5) * wd;
    var combined = produced + svc;   // dispatch £ joins production at reporting (Dan)
    return {
      label: label, start: startIso, end: endIso,
      produced: Math.round(produced), dispatchSvc: Math.round(svc),
      combined: Math.round(combined),
      dispatchedProduct: Math.round(dispatchedProduct), jobsOut: jobsOut,
      soldHrs: Math.round(soldHrs * 10) / 10,
      paidWs: Math.round(paidWs), paidComb: Math.round(paidComb),
      revSoldHr: soldHrs ? Math.round(produced / soldHrs) : null,
      revPaidWs: paidWs ? Math.round(produced / paidWs) : null,
      revPaidComb: paidComb ? Math.round(combined / paidComb) : null,
      utilisation: paidWs ? Math.round(soldHrs / paidWs * 100) : null
    };
  }

  var days = [];
  for (var i = 13; i >= 0; i--) {
    var d = addDays_(todayIso, -i);
    if (!isWorkday(d)) continue;
    days.push(bucketRow(d, d, d));
  }
  var weeks = [];
  var mon = mondayOf(todayIso);
  for (var w = 7; w >= 0; w--) {
    var ws = addDays_(mon, -7 * w);
    weeks.push(bucketRow('w/c ' + ws, ws, addDays_(ws, 6)));
  }
  var months = [];
  for (var m = 5; m >= 0; m--) {
    var ref = new Date(today.getFullYear(), today.getMonth() - m, 15);
    var mm = Utilities.formatDate(ref, CONFIG.TIMEZONE, 'yyyy-MM');
    var lastDay = Utilities.formatDate(new Date(ref.getFullYear(), ref.getMonth() + 1, 0), CONFIG.TIMEZONE, 'yyyy-MM-dd');
    months.push(bucketRow(mm, mm + '-01', lastDay));
  }

  // ── Per-person, last 28 days ────────────────────────────────
  var since = addDays_(todayIso, -28);
  var byWorker = {};
  events.forEach(function(ev) {
    if (ev.day < since || !ev.who) return;
    var b = byWorker[ev.who] = byWorker[ev.who] || { stages: 0, val: 0, hrs: 0 };
    b.stages++; b.val += ev.val; b.hrs += ev.hrs;
  });
  var perWorker = Object.keys(byWorker).map(function(n) {
    return { name: n, stages: byWorker[n].stages,
             val: Math.round(byWorker[n].val), hrs: Math.round(byWorker[n].hrs * 10) / 10 };
  }).sort(function(a, b) { return b.val - a.val; });

  return {
    thisWeek: weeks[weeks.length - 1],
    days: days, weeks: weeks, months: months,
    perWorker: perWorker,
    coverage: {
      liveJobs: live.sheds.length,
      missingValue: missingValue.length,
      missingValueSample: missingValue.slice(0, 8),
      multiShedReview: multiShedReview.slice(0, 8),
      noHours: noHours.length,
      noHoursSample: noHours.slice(0, 8),
      lineItemsOk: live.lineItemsOk !== false,
      lineItemsError: live.lineItemsError || ''
    },
    targets: CONFIG.TARGETS,
    weightsDraft: true,
    config: getClientConfig(),
    timestamp: live.timestamp
  };
}
