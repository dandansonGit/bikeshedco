// ============================================================
// BSC Production Hub — Geography
// Postcode geocoding (postcodes.io, free, no key) with a persistent
// cache in the Geo tab, plus the dispatch group suggestion engine.
// ============================================================

var GEO_CACHE_MEMO_ = null;   // Geo-tab rows, read at most once per execution

// Normalise "bs1  4dj" → "BS1 4DJ"
function normalizePostcode_(pc) {
  return String(pc || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function outwardCode_(pc) {
  var n = normalizePostcode_(pc);
  var parts = n.split(' ');
  return parts.length > 1 ? parts[0] : n.replace(/\d[A-Z]{2}$/, '');
}

// Returns { 'BS1 4DJ': {lat, lng}, ... }; postcodes that cannot be
// geocoded map to null. Cache-first, then bulk API, then outcode fallback.
function geocodePostcodes_(postcodes) {
  var unique = {};
  (postcodes || []).forEach(function(pc) {
    var n = normalizePostcode_(pc);
    if (n) unique[n] = true;
  });
  var wanted = Object.keys(unique);
  if (!wanted.length) return {};

  // 1. Persistent cache (Geo tab), memoised per execution — a request may
  //    geocode more than once and the tab only changes via us
  var result = {};
  if (!GEO_CACHE_MEMO_) {
    GEO_CACHE_MEMO_ = {};
    storeReadAll(CONFIG.TABS.geo).forEach(function(r) {
      if (r.postcode) GEO_CACHE_MEMO_[r.postcode] = r;
    });
  }
  var cached = GEO_CACHE_MEMO_;
  var misses = [];
  wanted.forEach(function(pc) {
    if (cached[pc] && cached[pc].lat !== '' && cached[pc].lng !== '') {
      result[pc] = { lat: Number(cached[pc].lat), lng: Number(cached[pc].lng) };
    } else {
      misses.push(pc);
    }
  });
  if (!misses.length) return result;

  // 2. Bulk lookup, 100 per request
  var fetched = {};
  for (var i = 0; i < misses.length; i += 100) {
    var batch = misses.slice(i, i + 100);
    try {
      var resp = UrlFetchApp.fetch(CONFIG.GEO.postcodesApi + '/postcodes', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ postcodes: batch }),
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() === 200) {
        (JSON.parse(resp.getContentText()).result || []).forEach(function(r) {
          var pc = normalizePostcode_(r.query);
          if (r.result && r.result.latitude != null) {
            fetched[pc] = { lat: r.result.latitude, lng: r.result.longitude };
          }
        });
      }
    } catch (e) { Logger.log('geocode bulk: ' + e.message); }
  }

  // 3. Outcode fallback for anything still missing (typo'd full postcodes
  //    often have a valid outward code)
  misses.forEach(function(pc) {
    if (fetched[pc]) return;
    var oc = outwardCode_(pc);
    if (!oc) return;
    try {
      var resp = UrlFetchApp.fetch(CONFIG.GEO.postcodesApi + '/outcodes/' + encodeURIComponent(oc), {
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() === 200) {
        var r = JSON.parse(resp.getContentText()).result;
        if (r && r.latitude != null) fetched[pc] = { lat: r.latitude, lng: r.longitude };
      }
    } catch (e) {}
  });

  // Persist new results and merge (memo updated so later calls this
  // execution see them without re-reading the tab)
  var now = new Date().toISOString();
  Object.keys(fetched).forEach(function(pc) {
    result[pc] = fetched[pc];
    GEO_CACHE_MEMO_[pc] = { postcode: pc, lat: fetched[pc].lat, lng: fetched[pc].lng };
    storeUpsert(CONFIG.TABS.geo, 'postcode', pc, {
      lat: fetched[pc].lat, lng: fetched[pc].lng, fetched_at: now
    });
  });
  misses.forEach(function(pc) { if (!(pc in result)) result[pc] = null; });
  return result;
}

// ── UK public holidays ───────────────────────────────────────
// {iso date → title} for England & Wales, from the free gov.uk feed.
// Cached 24h; falls back to the hardcoded list in Config on any failure.
function getBankHolidays_() {
  var cached = cacheGetJson_('bank_holidays');
  if (cached) return cached;
  var map = CONFIG.HOLIDAYS.FALLBACK;
  try {
    var resp = UrlFetchApp.fetch(CONFIG.HOLIDAYS.API, { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      var events = (JSON.parse(resp.getContentText())[CONFIG.HOLIDAYS.DIVISION] || {}).events || [];
      if (events.length) {
        map = {};
        events.forEach(function(ev) { map[ev.date] = ev.title; });
      }
    }
  } catch (e) { Logger.log('getBankHolidays_: ' + e.message); }
  cachePutJson_('bank_holidays', map, 86400);
  return map;
}

// ── Drive times ──────────────────────────────────────────────
// Real road durations from the free OSRM public router (adopted from Dan's
// route-planner prototype); one /table call returns the full matrix for a
// set of points. Falls back to a DfT-derived speed model. Cached 6h.

// points: [{lat, lng}] → matrix[i][j] = minutes (never null: fallback fills gaps)
function driveTimeMatrix_(points) {
  var key = 'osrm_' + points.map(function(p) {
    return p.lat.toFixed(3) + ',' + p.lng.toFixed(3);
  }).join(';');
  var cached = cacheGetJson_(key);
  if (cached) return cached;

  var matrix = null;
  try {
    var coords = points.map(function(p) { return p.lng + ',' + p.lat; }).join(';');
    var resp = UrlFetchApp.fetch(
      CONFIG.GEO.osrmApi + '/table/v1/driving/' + coords + '?annotations=duration',
      { muteHttpExceptions: true }
    );
    if (resp.getResponseCode() === 200) {
      var data = JSON.parse(resp.getContentText());
      if (data.durations) {
        matrix = data.durations.map(function(row) {
          return row.map(function(sec) { return sec == null ? null : Math.round(sec / 60); });
        });
      }
    }
  } catch (e) { Logger.log('OSRM table: ' + e.message); }

  // Fill gaps (or the whole matrix) with the speed-model estimate
  var out = [];
  for (var i = 0; i < points.length; i++) {
    out[i] = [];
    for (var j = 0; j < points.length; j++) {
      var osrm = matrix && matrix[i] ? matrix[i][j] : null;
      out[i][j] = (osrm != null) ? osrm : estimateDriveMins_(points[i], points[j]);
    }
  }
  cachePutJson_(key, out, 21600);
  return out;
}

// Fallback: straight-line × route factor, speed banded by leg length
// (long legs are motorway-dominated, short legs urban — DfT averages).
function estimateDriveMins_(a, b) {
  var straight = distanceKm_(a, b);
  if (straight < 0.05) return 0;
  var D = CONFIG.INSTALL_DAY;
  var speed = straight > 50 ? D.speedKmhLong : straight > 15 ? D.speedKmhMid : D.speedKmhShort;
  return Math.round((straight * D.routeFactor) / speed * 60);
}

function distanceKm_(a, b) {
  var R = 6371, rad = Math.PI / 180;
  var dLat = (b.lat - a.lat) * rad;
  var dLng = (b.lng - a.lng) * rad;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(a.lat * rad) * Math.cos(b.lat * rad) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Group suggestions were superseded by full install-day planning —
// see Planner.gs (suggestInstallDays).

// ── Local-date helpers (string maths, no timezone traps) ─────

function dateDiffDays_(a, b) {
  return Math.round((parseIsoDate_(b) - parseIsoDate_(a)) / 86400000);
}

function addDays_(iso, days) {
  var d = parseIsoDate_(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().substring(0, 10);
}

function parseIsoDate_(iso) {
  return new Date(iso + 'T00:00:00Z');
}
