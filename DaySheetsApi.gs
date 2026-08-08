// ============================================================
// BSC Production Hub — Day sheets backend (Dan, 2026-07-17)
// Paper-first per-STATION planning: each station's daily queue is
// DERIVED from planned dates (no manual allocation needed to start),
// printed as one A4 page per station with pen columns, and the numbers
// come back in via the day-close grid → WorkLog + DayTasks tabs — the
// raw actuals that will refine build times and the bespoke calculator.
// ============================================================

function getDaySheetData(dayIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayIso || ''))) {
    throw new Error('getDaySheetData: bad day "' + dayIso + '"');
  }
  var live = fetchLiveData(false);
  var jobsState = {};
  storeReadLatest(CONFIG.TABS.jobs, 'shed_id').forEach(function(r) {
    if (r.shed_id) jobsState[String(r.shed_id).trim()] = r;
  });
  var dispatchState = {};
  storeReadLatest(CONFIG.TABS.dispatch, 'shed_id').forEach(function(r) {
    if (r.shed_id) dispatchState[String(r.shed_id).trim()] = r;
  });
  var worklog = {};
  storeReadLatest(CONFIG.TABS.worklog, 'entry_key').forEach(function(r) {
    if (r.entry_key) worklog[r.entry_key] = r;
  });
  var dayTasks = storeReadLatest(CONFIG.TABS.dayTasks, 'task_key')
    .filter(function(r) { return r.day === dayIso; });

  var W = CONFIG.STAGE_HOUR_WEIGHTS;
  var leadFrame = CONFIG.LEAD_DAYS.frameToSpray;

  // A job appears at a station on the day its stage-work is due:
  //   spray booth + prep → planned spray date; cut/framing → spray minus
  //   the frame lead; assembly → planned assembly date; lid → the day
  //   before assembly; base prep → assembly minus the frame lead.
  // Overdue = due earlier but the stage still isn't ticked.
  function stationDue_(stationKey, s) {
    var spray = s.planned_spray_date || '';
    var asm   = s.planned_assembly_date || '';
    switch (stationKey) {
      case 'cut': case 'framing':
        return spray ? addWorkingDaysIso_(spray, -leadFrame) : '';
      case 'prep':  return spray;
      case 'spray': return spray;
      case 'assembly': return asm;
      case 'lid':   return asm ? addWorkingDaysIso_(asm, -1) : '';
      case 'base':  return asm ? addWorkingDaysIso_(asm, -leadFrame) : '';
    }
    return '';
  }

  function stationDone_(station, s) {
    if (station.key === 'lid') return s.lid_complete === 'TRUE';
    if (station.key === 'base') return s.d_complete !== '' && s.d_complete !== undefined && s.d_complete !== 'FALSE' && !!s.d_complete;
    return station.stages.every(function(k) { return s['stage_' + k] === 'TRUE'; });
  }

  function stationEstHrs_(station, job, s) {
    // Build-time precedence (one rule app-wide since 2026-08-07): explicit
    // app override > HubSpot estimated_build_hours > standard BUILD_DAYS
    var overrideDays = s.override_build_days ? parseFloat(s.override_build_days) : null;
    var hours = overrideDays ? overrideDays * CONFIG.PRODUCTIVE_HRS_PER_DAY
              : job.estBuildHours ? job.estBuildHours
              : (estimateBuildDays_(job.shedType) || 0) * CONFIG.PRODUCTIVE_HRS_PER_DAY;
    if (!hours) return null;
    var frac = 0;
    if (station.key === 'lid' || station.key === 'base') frac = 0.05;   // rough until timed
    else station.stages.forEach(function(k) { frac += W[k] || 0; });
    return Math.round(hours * frac * 10) / 10;
  }

  var stations = CONFIG.STATIONS.map(function(st) {
    var rows = [];
    live.sheds.forEach(function(j) {
      var s = jobsState[j.id] || {};
      if (j.onHold || stationDone_(st, s)) return;
      var due = stationDue_(st.key, s);
      if (!due || due > dayIso) return;               // not planned, or later
      var key = dayIso + '|' + j.id + '|' + st.key;
      var wl = worklog[key] || {};
      rows.push({
        id: j.id, name: j.jobRef, shedType: j.shedTypeCustomer || j.shedType,
        finish: j.finish, drawingNo: j.drawingNo,
        isBespoke: /besp/i.test(j.shedType || ''),
        due: due, overdue: due < dayIso,
        estHrs: stationEstHrs_(st, j, s),
        notes: s.notes || '',
        entryKey: key,
        actualHrs: wl.actual_hrs || '', doneBy: wl.done_by || '',
        done: wl.done === 'TRUE', closeNotes: wl.notes || ''
      });
    });
    rows.sort(function(a, b) { return (a.due || '').localeCompare(b.due || ''); });
    return {
      key: st.key, label: st.label, jobs: rows,
      tasks: dayTasks.filter(function(t) { return t.station === st.key; })
    };
  });

  return {
    day: dayIso,
    stations: stations,
    nonSoldTasks: CONFIG.NON_SOLD_TASKS,
    workshopTeam: CONFIG.WORKSHOP_TEAM,
    bankHoliday: getBankHolidays_()[dayIso] || '',
    timestamp: live.timestamp
  };
}

// Plan a non-sold task onto a day/station.
function addDayTask(dayIso, station, task, estHrs) {
  var key = dayIso + '|' + station + '|' + String(task).replace(/\|/g, '') +
            '|' + Math.floor(Math.random() * 100000);
  return storeUpsert(CONFIG.TABS.dayTasks, 'task_key', key, {
    day: dayIso, station: station, task: task, est_hrs: estHrs || ''
  });
}

// Day-close: key the paper numbers in. entries = [{entryKey|taskKey,
// shedId, shedName, station, estHrs, actualHrs, doneBy, done, notes}].
function saveDayClose(dayIso, entries) {
  (entries || []).forEach(function(en) {
    if (en.taskKey) {
      storeUpsert(CONFIG.TABS.dayTasks, 'task_key', en.taskKey, {
        actual_hrs: en.actualHrs || null,
        done_by:    en.doneBy || null,
        done:       en.done ? 'TRUE' : 'FALSE',
        notes:      en.notes || null
      });
    } else if (en.entryKey) {
      storeUpsert(CONFIG.TABS.worklog, 'entry_key', en.entryKey, {
        day: dayIso, shed_id: en.shedId, shed_name: en.shedName,
        station: en.station,
        est_hrs:    en.estHrs === null || en.estHrs === undefined ? '' : en.estHrs,
        actual_hrs: en.actualHrs || null,
        done_by:    en.doneBy || null,
        done:       en.done ? 'TRUE' : 'FALSE',
        notes:      en.notes || null
      });
    }
  });
  return { ok: true, count: (entries || []).length };
}

// Working-day date maths (server-side twin of App.addWorkingDaysIso)
function addWorkingDaysIso_(iso, n) {
  var d = parseIsoDate_(iso);
  var step = n < 0 ? -1 : 1, left = Math.abs(n);
  while (left > 0) {
    d = new Date(d.getTime() + step * 86400000);
    var dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}
