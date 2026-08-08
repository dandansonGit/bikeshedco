// ============================================================
// BSC Production Hub — Install-day planner
// Builds suggested INSTALL DAYS (not just geographic groups):
// van capacity, drive times, day length, weekly rhythm and the
// customer's target window all constrain each suggested day.
//
// Model (Dan, 2026-07-14):
//   • Van: 4 "small shed" slots (slots per SKU prefix in Config —
//     estimates awaiting Dan's numbers). Max 4 sheds/day, and 4 sheds
//     only if spread over ≤2 customers (≤3 customers otherwise).
//   • Day: leave Bristol, load 30min, install ~1h45/shed (2nd shed at
//     the same address +1h), 10min buffer/stop, return to Bristol.
//     Target ≤10h door-to-door, 12h max (13–14h = manual exception).
//   • Legs between customer addresses ≤60min. No cap on the first leg.
//   • Rhythm: Tue/Wed/Thu London installs; Mon local-only (never
//     London); Fri is courier day — not offered for installs.
//   • Dates must sit within each member's target ±window.
//   • single_day-flagged orders (large/high-value) get their own day.
// ============================================================

function suggestInstallDays() {
  var D    = CONFIG.INSTALL_DAY;
  var data = getDispatchData(false);

  var candidates = data.jobs.filter(function(d) {
    return d.geoEligible && !d.onHold &&
           (d.status === '' || d.status === 'draft') &&
           d.targetDispatchDate && d.coords;
  }).sort(function(a, b) { return a.targetDispatchDate.localeCompare(b.targetDispatchDate); });

  var skipped = {
    noPostcode: data.jobs.filter(function(d) {
      return d.geoEligible && !d.onHold && (d.status === '' || d.status === 'draft') &&
             d.targetDispatchDate && !d.coords;
    }).map(function(d) { return d.name; }),
    noTarget: data.jobs.filter(function(d) {
      return d.geoEligible && !d.onHold && (d.status === '' || d.status === 'draft') && !d.targetDispatchDate;
    }).map(function(d) { return d.name; })
  };
  if (!candidates.length) return { plans: [], skipped: skipped };

  // Drive-time matrix: index 0 = workshop, 1..n = candidates
  var workshop = geocodePostcodes_([D.WORKSHOP_POSTCODE])[normalizePostcode_(D.WORKSHOP_POSTCODE)] ||
                 { lat: 51.4545, lng: -2.5879 }; // Bristol centre fallback
  var points = [workshop].concat(candidates.map(function(c) { return c.coords; }));
  var matrix = driveTimeMatrix_(points);
  var idxOf  = {};
  candidates.forEach(function(c, i) { idxOf[c.id] = i + 1; });
  function legMins(fromDeal, toDeal) {
    return matrix[fromDeal ? idxOf[fromDeal.id] : 0][toDeal ? idxOf[toDeal.id] : 0];
  }

  var geoAmendments = (data.amendments || []).filter(function(a) { return a.coords; });

  var assigned = {}, plans = [];

  // ── Join suggestions: drafts added onto already-agreed days ──
  // Every future proposed/confirmed day with spare van capacity is an
  // anchor; nearby unplanned/draft jobs whose ±window covers that date can
  // ride along. Joins are computed FIRST (filling an agreed trip beats
  // opening a fresh day) and consume candidates before the clustering
  // below. Anchor legs use the speed model (anchors aren't in the OSRM
  // matrix); capacity/day-length rules are the same as for fresh days.
  var todayStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  var anchorsByDay = {};
  data.jobs.forEach(function(d) {
    if (!d.proposedDate || d.proposedDate <= todayStr) return;
    if (d.status !== 'proposed' && d.status !== 'confirmed') return;
    if (!d.geoEligible || d.onHold || d.singleDay) return;
    (anchorsByDay[d.proposedDate] = anchorsByDay[d.proposedDate] || []).push(d);
  });

  function anchorLegMins(fromJob, toJob) {
    var a = fromJob ? fromJob.coords : workshop;
    var b = toJob ? toJob.coords : workshop;
    if (!a || !b) return 0;   // no-postcode anchor: treat as colocated
    return estimateDriveMins_(a, b);
  }

  Object.keys(anchorsByDay).sort().forEach(function(day) {
    var anchorJobs = anchorsByDay[day];
    var members = anchorJobs.slice();
    var added = [];
    var isMonday = parseIsoDate_(day).getUTCDay() === 1;
    var targetHrs = isMonday ? D.mondayTargetHrs : D.dayTargetHrs;
    var W = CONFIG.DISPATCH_WINDOW_DAYS;

    var last = members[members.length - 1];
    while (true) {
      var totalSheds = sumSheds_(members);
      var totalSlots = sumSlots_(members);
      if (totalSheds >= D.maxSheds || members.length >= D.maxCustomers) break;

      var best = null, bestLeg = Infinity;
      candidates.forEach(function(c) {
        if (assigned[c.id] || c.singleDay || !c.coords) return;
        if (day < addDays_(c.targetDispatchDate, -W) || day > addDays_(c.targetDispatchDate, W)) return;
        var newSheds = totalSheds + c.numSheds;
        if (newSheds > D.maxSheds) return;
        if (newSheds >= D.maxSheds && members.length + 1 > D.maxCustomersAtMaxSheds) return;
        if (totalSlots + slotsFor_(c) > D.vanSlots) return;
        var leg = anchorLegMins(last, c);
        if (leg > D.maxLegMins) return;
        if (dayDurationMins_(members.concat([c]), anchorLegMins) > targetHrs * 60) return;
        if (leg < bestLeg) { best = c; bestLeg = leg; }
      });
      if (!best) break;
      members.push(best);
      added.push(best);
      assigned[best.id] = true;
      last = best;
    }
    if (!added.length) return;

    var durMins = dayDurationMins_(members, anchorLegMins);
    var legs = routeLegs_(members, anchorLegMins);
    var warnings = [];
    if (durMins > targetHrs * 60) warnings.push('long day — over the ' + targetHrs + 'h ' + (isMonday ? 'Monday ' : '') + 'target');
    if (durMins > D.dayMaxHrs * 60) warnings.push('OVER ' + D.dayMaxHrs + 'h max');
    if (added.some(function(m) { return m.missingFinish; })) warnings.push('colour missing on some sheds');

    plans.push({
      joinsExisting: true,
      existingCount: anchorJobs.length,
      existingStatus: anchorJobs.some(function(m) { return m.status === 'confirmed'; }) ? 'confirmed' : 'proposed',
      shedIds: added.map(function(m) { return m.id; }),   // applyPlan places ONLY the new sheds
      stops: members.map(function(m, i) {
        return { name: m.name, area: m.area, sheds: 1,
                 finishes: m.finish ? [m.finish] : [], legMins: legs[i],
                 singleDay: !!m.singleDay, existing: added.indexOf(m) === -1 };
      }),
      returnLegMins: legs[legs.length - 1],
      suggestedDate: day,
      windowStart: day,
      windowEnd: day,
      totalSheds: sumSheds_(members),
      vanSlots: Math.round(sumSlots_(members) * 10) / 10,
      vanSlotsMax: D.vanSlots,
      estHours: Math.round(durMins / 60 * 10) / 10,
      targetHours: targetHrs,
      isLondon: members.some(function(m) { return isLondonPostcode_(m.postCode); }),
      warnings: warnings,
      nearbyVisits: []
    });
  });

  candidates.forEach(function(seed) {
    if (assigned[seed.id]) return;
    var members = [seed];
    assigned[seed.id] = true;

    if (!seed.singleDay) {
      // Greedily extend the day with the nearest compatible next stop
      var last = seed;
      while (true) {
        var totalSheds = sumSheds_(members);
        var totalSlots = sumSlots_(members);
        if (totalSheds >= D.maxSheds || members.length >= D.maxCustomers) break;

        var best = null, bestLeg = Infinity;
        candidates.forEach(function(c) {
          if (assigned[c.id] || c.singleDay) return;
          if (Math.abs(dateDiffDays_(seed.targetDispatchDate, c.targetDispatchDate)) > 2 * CONFIG.DISPATCH_WINDOW_DAYS) return;
          var newSheds = totalSheds + c.numSheds;
          if (newSheds > D.maxSheds) return;
          if (newSheds >= D.maxSheds && members.length + 1 > D.maxCustomersAtMaxSheds) return;
          if (totalSlots + slotsFor_(c) > D.vanSlots) return;
          var leg = legMins(last, c);
          if (leg > D.maxLegMins) return;
          // Would the day still fit inside the target hours?
          var trial = members.concat([c]);
          if (dayDurationMins_(trial, legMins) > D.dayTargetHrs * 60) return;
          if (leg < bestLeg) { best = c; bestLeg = leg; }
        });
        if (!best) break;
        members.push(best);
        assigned[best.id] = true;
        last = best;
      }
    }

    // Window intersection & suggested date snapped to the weekly rhythm
    var W = CONFIG.DISPATCH_WINDOW_DAYS;
    var maxStart = null, minEnd = null;
    members.forEach(function(m) {
      var s = addDays_(m.targetDispatchDate, -W), e = addDays_(m.targetDispatchDate, W);
      if (maxStart === null || s > maxStart) maxStart = s;
      if (minEnd === null || e < minEnd) minEnd = e;
    });
    var isLondon = members.some(function(m) { return isLondonPostcode_(m.postCode); });
    var allowedDays = isLondon ? D.londonDays : D.localDays;
    var snap = snapToAllowedDay_(seed.targetDispatchDate, maxStart, minEnd, allowedDays);

    var durMins = dayDurationMins_(members, legMins);
    var legs = routeLegs_(members, legMins);

    var warnings = [];
    if (durMins > D.dayTargetHrs * 60) warnings.push('long day — over ' + D.dayTargetHrs + 'h target');
    if (durMins > D.dayMaxHrs * 60) warnings.push('OVER ' + D.dayMaxHrs + 'h max');
    // Mondays are the crew's short (8h) day — flag a plan that overruns it
    if (snap.date && parseIsoDate_(snap.date).getUTCDay() === 1 &&
        durMins > D.mondayTargetHrs * 60) {
      warnings.push('Monday is an ' + D.mondayTargetHrs + 'h day — this plan needs ' +
        Math.round(durMins / 60 * 10) / 10 + 'h');
    }
    if (snap.warning) warnings.push(snap.warning);
    if (members.some(function(m) { return m.missingFinish; })) warnings.push('colour missing on some sheds');

    // Nearby open visits (surveys/amendments) the trip could absorb
    var extras = geoAmendments.map(function(a) {
      var minKm = Infinity;
      members.forEach(function(m) { minKm = Math.min(minKm, distanceKm_(m.coords, a.coords)); });
      return { subject: a.subject, type: a.type, date: a.date || '', km: Math.round(minKm) };
    }).filter(function(a) { return a.km <= 15; })
      .sort(function(x, y) { return x.km - y.km; })
      .slice(0, 3);

    plans.push({
      shedIds:    members.map(function(m) { return m.id; }),
      stops: members.map(function(m, i) {
        return { name: m.name, area: m.area, sheds: 1,
                 finishes: m.finish ? [m.finish] : [], legMins: legs[i], singleDay: !!m.singleDay };
      }),
      returnLegMins: legs[legs.length - 1],
      suggestedDate: snap.date,
      windowStart: maxStart,
      windowEnd: minEnd,
      totalSheds: sumSheds_(members),
      vanSlots: Math.round(sumSlots_(members) * 10) / 10,
      vanSlotsMax: D.vanSlots,
      estHours: Math.round(durMins / 60 * 10) / 10,
      targetHours: D.dayTargetHrs,
      isLondon: isLondon,
      warnings: warnings,
      nearbyVisits: extras
    });
  });

  // Joins onto agreed days first, then fullest/tightest fresh days
  plans.sort(function(a, b) {
    if (!!b.joinsExisting !== !!a.joinsExisting) return (b.joinsExisting ? 1 : 0) - (a.joinsExisting ? 1 : 0);
    if (b.stops.length !== a.stops.length) return b.stops.length - a.stops.length;
    return a.estHours - b.estHours;
  });
  return { plans: plans, skipped: skipped };
}

// ── helpers ──────────────────────────────────────────────────

function sumSheds_(members) {
  return members.reduce(function(s, m) { return s + m.numSheds; }, 0);
}

function sumSlots_(members) {
  return members.reduce(function(s, m) { return s + slotsFor_(m); }, 0);
}

// Van slots for one shed, from its SKU prefix (defaultSlots if unknown).
function slotsFor_(shed) {
  return slotsForType_(shed.shedType);
}

function slotsForType_(shedType) {
  var D = CONFIG.INSTALL_DAY;
  var t = String(shedType || '').toUpperCase();
  var keys = Object.keys(D.slotsByPrefix);
  for (var i = 0; i < keys.length; i++) {
    if (t.indexOf(keys[i]) === 0) return D.slotsByPrefix[keys[i]];
  }
  return D.defaultSlots;
}

// Door-to-door minutes: load + legs + installs + buffers + return
function dayDurationMins_(members, legMins) {
  var D = CONFIG.INSTALL_DAY;
  var mins = D.loadMins;
  var prev = null;
  members.forEach(function(m) {
    mins += legMins(prev, m);                                   // drive in
    mins += D.installMinsPerShed;                               // first shed
    mins += Math.max(0, m.numSheds - 1) * D.extraShedSameCustomerMins;
    mins += D.bufferPerStopMins;
    prev = m;
  });
  mins += legMins(prev, null);                                  // return to base
  return mins;
}

// Leg times in stop order + the return leg appended
function routeLegs_(members, legMins) {
  var legs = [], prev = null;
  members.forEach(function(m) { legs.push(legMins(prev, m)); prev = m; });
  legs.push(legMins(prev, null));
  return legs;
}

var LONDON_AREAS_ = { E:1, EC:1, N:1, NW:1, SE:1, SW:1, W:1, WC:1,
  BR:1, CR:1, DA:1, EN:1, HA:1, IG:1, KT:1, RM:1, SM:1, TW:1, UB:1, WD:1 };
function isLondonPostcode_(pc) {
  var m = normalizePostcode_(pc).match(/^[A-Z]{1,2}/);
  return !!(m && LONDON_AREAS_[m[0]]);
}

// Earliest allowed weekday ≥ tomorrow, inside [start,end], preferring the
// day closest to `target`. Falls outside the window only with a warning.
// UK public holidays are never suggested (Dan, 2026-07-16 — "we never work
// on them but get caught out when planning").
function snapToAllowedDay_(target, start, end, allowedDays) {
  var holidays = getBankHolidays_();
  var today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  var from = (start > today) ? start : addDays_(today, 1);
  var best = null, bestGap = Infinity;
  for (var d = from; d <= end; d = addDays_(d, 1)) {
    var dow = parseIsoDate_(d).getUTCDay();
    if (allowedDays.indexOf(dow) === -1 || holidays[d]) continue;
    var gap = Math.abs(dateDiffDays_(target, d));
    if (gap < bestGap) { best = d; bestGap = gap; }
  }
  if (best) return { date: best };
  // Nothing allowed inside the window — take next allowed day after it
  for (var d2 = (end > today ? end : addDays_(today, 1)), i = 0; i < 21; d2 = addDays_(d2, 1), i++) {
    if (allowedDays.indexOf(parseIsoDate_(d2).getUTCDay()) > -1 && !holidays[d2]) {
      return { date: d2, warning: 'no rhythm day fits the target window — suggested outside it' };
    }
  }
  return { date: target, warning: 'could not snap to an allowed weekday' };
}

// Estimated crew day for the sheds PLACED on one board date: nearest-
// neighbour route from the workshop using the cheap speed model (no OSRM —
// a board render would need dozens of tiny matrix calls), plus the same
// load/install/buffer minutes the suggestion engine uses. Good enough for
// the £/hour guestimate the board shows; the suggestion panel stays OSRM.
function estimatePlacedDayHours_(sheds, workshop) {
  var D = CONFIG.INSTALL_DAY;
  var routed  = sheds.filter(function(s) { return s.coords; });
  var unrouted = sheds.length - routed.length;

  var mins = D.loadMins, prev = workshop;
  var remaining = routed.slice();
  while (remaining.length) {
    var bestI = 0, bestMins = Infinity;
    remaining.forEach(function(s, i) {
      var m = estimateDriveMins_(prev, s.coords);
      if (m < bestMins) { bestMins = m; bestI = i; }
    });
    var stop = remaining.splice(bestI, 1)[0];
    mins += bestMins + D.installMinsPerShed + D.bufferPerStopMins;
    prev = stop.coords;
  }
  if (routed.length) mins += estimateDriveMins_(prev, workshop);   // return leg
  mins += unrouted * (D.installMinsPerShed + D.bufferPerStopMins); // no-postcode sheds: install time only

  var clockHrs = Math.round(mins / 60 * 10) / 10;
  return {
    clockHrs: clockHrs,
    manHrs:   Math.round(clockHrs * D.crewSize * 10) / 10
  };
}
