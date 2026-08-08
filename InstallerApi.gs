// ============================================================
// BSC Production Hub — Installer view backend (Dan, 2026-07-17)
// The dispatch team's phone/tablet view: weekly + daily schedule showing
// EVERYTHING going out (installs, team deliveries, Andy, courier,
// collections) plus survey/amendment visits. The route (drive order +
// legs) covers Install + Del Team stops only — the crew's own drive;
// other types are listed as context (installers can hide them). Stops
// can be manually reordered (route_order on the Dispatch tab) and the
// client recomputes legs live. The REQUIRED job report carries QC4;
// a rework flag emails the office immediately.
// Installers need @thebikeshedcompany.com Google accounts.
// ============================================================

// Route = the crew's own vehicle: installs + team deliveries.
function isCrewRouteType_(type) {
  var t = String(type || '').toLowerCase();
  return t.indexOf('install') > -1 || t.indexOf('team') > -1;
}

function getInstallerData(forceRefresh) {
  return cachedPayload_('payload_installer', forceRefresh, function() {
    return buildInstallerData_(forceRefresh);
  });
}

function buildInstallerData_(forceRefresh) {
  var live = fetchLiveData(forceRefresh);
  var dispatchState = {};
  storeReadLatest(CONFIG.TABS.dispatch, 'shed_id').forEach(function(r) {
    if (r.shed_id) dispatchState[String(r.shed_id).trim()] = r;
  });
  var reports = {};
  storeReadLatest(CONFIG.TABS.reports, 'shed_id').forEach(function(r) {
    if (r.shed_id) reports[String(r.shed_id).trim()] = r;
  });

  // Everything going out with an agreed/offered date (drafts stay office-only)
  var jobs = live.sheds.map(function(j) {
    var plan = resolvePlanningInfo_(j, dispatchState[j.id] || {});
    return Object.assign({}, j, plan, {
      routeOrder: parseInt((dispatchState[j.id] || {}).route_order, 10)
    });
  }).filter(function(j) {
    return !j.onHold && j.planningDate &&
      (j.dispatchStatus === 'confirmed' || j.dispatchStatus === 'proposed');
  });

  // One geocode pass covers the jobs AND the workshop (perf)
  var coords = geocodePostcodes_(
    jobs.map(function(j) { return j.postCode; })
        .concat([CONFIG.INSTALL_DAY.WORKSHOP_POSTCODE]));
  var workshop = coords[normalizePostcode_(CONFIG.INSTALL_DAY.WORKSHOP_POSTCODE)] ||
                 { lat: 51.4545, lng: -2.5879 };

  var byDay = {};
  jobs.forEach(function(j) {
    j.coords = coords[normalizePostcode_(j.postCode)] || null;
    j.isCrewRoute = isCrewRouteType_(j.dispatchType);
    j.mapsUrl = 'https://www.google.com/maps/dir/?api=1&destination=' +
      encodeURIComponent(j.address || j.postCode || '');
    var r = reports[j.id];
    j.report = r ? {
      reportDate:     r.report_date || '',
      arrivalTime:    r.arrival_time || '',
      timeTakenHrs:   r.time_taken_hrs || '',
      qc4Pass:        r.qc4_pass === 'TRUE',
      qc4Faults:      r.qc4_faults || '',
      reworkRequired: r.rework_required === 'TRUE',
      reworkDetails:  r.rework_details || '',
      notes:          r.notes || '',
      submittedBy:    r.submitted_by || '',
      submittedAt:    r.submitted_at || ''
    } : null;
    (byDay[j.planningDate] = byDay[j.planningDate] || []).push(j);
  });

  Object.keys(byDay).forEach(function(day) {
    byDay[day] = orderDayJobs_(byDay[day], workshop);
  });

  // Survey/amendment visits on their agreed dates (the crew does these too)
  var visits = {};
  (live.amendments || []).forEach(function(a) {
    if (!a.date) return;
    (visits[a.date] = visits[a.date] || []).push({
      id: a.id, subject: a.subject, type: a.type, stageLabel: a.stageLabel,
      postCode: a.postCode, dealName: a.dealName,
      originalDispatchDate: a.originalDispatchDate,
      mapsUrl: a.postCode
        ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(a.postCode)
        : ''
    });
  });

  var D = CONFIG.INSTALL_DAY;
  return {
    days: byDay,
    visits: visits,
    // Client recomputes legs when stops are manually reordered
    routeParams: {
      workshop: workshop,
      speedKmhLong: D.speedKmhLong, speedKmhMid: D.speedKmhMid,
      speedKmhShort: D.speedKmhShort, routeFactor: D.routeFactor
    },
    config: getClientConfig(),
    timestamp: live.timestamp
  };
}

// Crew-route stops first — manual route_order when set, else nearest-
// neighbour from the workshop — with same-order legs; then a fix-up so a
// customer's 1/2, 2/2 sheds sit together in number order; non-route jobs
// (courier / Andy / collection) appended without legs.
function orderDayJobs_(dayJobs, workshop) {
  var route = dayJobs.filter(function(j) { return j.isCrewRoute; });
  var rest  = dayJobs.filter(function(j) { return !j.isCrewRoute; });

  var hasManual = route.length && route.every(function(j) { return !isNaN(j.routeOrder); });
  var ordered;
  if (hasManual) {
    ordered = route.sort(function(a, b) { return a.routeOrder - b.routeOrder; });
  } else {
    var remaining = route.slice();
    ordered = [];
    var prev = workshop;
    while (remaining.length) {
      var bestI = 0, bestMins = Infinity;
      remaining.forEach(function(j, i) {
        var m = j.coords ? estimateDriveMins_(prev, j.coords) : 9999;
        if (m < bestMins) { bestMins = m; bestI = i; }
      });
      var stop = remaining.splice(bestI, 1)[0];
      ordered.push(stop);
      if (stop.coords) prev = stop.coords;
    }
  }

  // Same customer's sheds adjacent, in multiple-number order (1/2 then 2/2)
  var fixed = [], seenDeal = {};
  ordered.forEach(function(j) {
    if (seenDeal[j.dealId]) return;
    seenDeal[j.dealId] = true;
    var group = ordered.filter(function(x) { return x.dealId === j.dealId; });
    group.sort(function(a, b) {
      return String(a.multipleNumber || '').localeCompare(String(b.multipleNumber || ''));
    });
    fixed = fixed.concat(group);
  });

  // Legs for the final order
  var prev2 = workshop;
  fixed.forEach(function(j) {
    j.legMins = j.coords ? estimateDriveMins_(prev2, j.coords) : null;
    if (j.coords) prev2 = j.coords;
  });
  if (fixed.length && fixed[fixed.length - 1].coords) {
    fixed[fixed.length - 1].returnLegMins = estimateDriveMins_(fixed[fixed.length - 1].coords, workshop);
  }
  rest.forEach(function(j) { j.legMins = null; });
  return fixed.concat(rest);
}

// Persist the installer's manual stop order for one day.
function saveRouteOrder(orderedShedIds) {
  (orderedShedIds || []).forEach(function(id, i) {
    storeUpsert(CONFIG.TABS.dispatch, 'shed_id', id, { route_order: i });
  });
  return { ok: true, count: (orderedShedIds || []).length };
}

// Save (or update) the on-site job report. Rework flagged → email the
// office immediately (CONFIG.INSTALLER.REWORK_EMAIL) so it can't be
// missed. The submitting installer is stamped from their Google session.
function saveInstallReport(shedId, report) {
  report = report || {};
  var who = '';
  try { who = Session.getActiveUser().getEmail() || ''; } catch (e) {}
  var now = new Date().toISOString();

  var fields = {
    shed_name:       report.shedName || '',
    report_date:     report.reportDate || Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd'),
    arrival_time:    report.arrivalTime || null,
    time_taken_hrs:  report.timeTakenHrs || null,
    qc4_pass:        report.qc4Pass ? 'TRUE' : 'FALSE',
    qc4_faults:      report.qc4Faults || null,
    rework_required: report.reworkRequired ? 'TRUE' : 'FALSE',
    rework_details:  report.reworkDetails || null,
    notes:           report.notes || null,
    submitted_by:    who,
    submitted_at:    now
  };
  var result = storeUpsert(CONFIG.TABS.reports, 'shed_id', shedId, fields);

  if (report.reworkRequired) {
    try {
      MailApp.sendEmail(CONFIG.INSTALLER.REWORK_EMAIL,
        '🔧 REWORK required — ' + (report.shedName || ('Shed ' + shedId)),
        'An install report has flagged rework:\n\n' +
        'Job:        ' + (report.shedName || shedId) + '\n' +
        'Reported:   ' + fields.report_date + (who ? ' by ' + who : '') + '\n' +
        'QC4:        ' + (report.qc4Pass ? 'pass' : 'ISSUES — ' + (report.qc4Faults || 'see report')) + '\n\n' +
        'Rework needed:\n' + (report.reworkDetails || '(no details given)') + '\n\n' +
        (report.notes ? 'Other notes:\n' + report.notes + '\n\n' : '') +
        'Full report: open the app → Installer view → that job.');
    } catch (e) { Logger.log('rework email failed: ' + e.message); }
  }
  return result;
}
