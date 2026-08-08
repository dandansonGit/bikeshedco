// ============================================================
// BSC Production Hub — HubSpot client
// The ONE place that talks to HubSpot. Returns a merged snapshot:
//   { sheds: [...], deals: [...], timestamp }
// Sheds = live custom objects (order_complete = no, deal at stage Sale).
// Deals = the unique parent deals of those sheds, with dispatch-planning
// fields (post_code, dispatch_date target, closedate) and aggregates.
// ============================================================

function fetchLiveData(forceRefresh) {
  if (!forceRefresh) {
    var cached = cacheGetJson_(CONFIG.CACHE_KEY);
    if (cached) return cached;
  }

  var token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_API_KEY');
  if (!token) throw new Error('HUBSPOT_API_KEY not set in Script Properties.');

  var sheds = hsSearchAll_(token, CONFIG.HS_SHED_TYPE, {
    filterGroups: [{ filters: [{ propertyName: 'order_complete', operator: 'EQ', value: 'no' }] }],
    properties: CONFIG.SHED_PROPS,
    sorts: [{ propertyName: 'install_date', direction: 'ASCENDING' }]
  });

  var snapshot = { sheds: [], deals: [], timestamp: new Date().getTime() };
  if (!sheds.length) { cachePutJson_(CONFIG.CACHE_KEY, snapshot, CONFIG.CACHE_TTL); return snapshot; }

  // Associations shed → deal, then batch-read the deals
  var shedToDeals = hsBatchAssocV4_(token, CONFIG.HS_SHED_TYPE, 'deals', sheds.map(function(s) { return s.id; }));
  var dealIds = hsDedupe_(Object.keys(shedToDeals).reduce(function(acc, k) {
    return acc.concat(shedToDeals[k] || []);
  }, []));

  var dealMap = {};
  if (dealIds.length) {
    hsBatchRead_(token, 'deals', dealIds, CONFIG.DEAL_PROPS)
      .forEach(function(d) { dealMap[d.id] = d; });
  }

  // Keep only sheds whose deal is at stage Sale
  sheds = sheds.filter(function(s) {
    var dealId = (shedToDeals[s.id] || [])[0];
    return dealId && dealMap[dealId] &&
      (dealMap[dealId].properties.dealstage || '') === CONFIG.DEAL_STAGE_SALE;
  });

  // ── Build shed jobs ─────────────────────────────────────────
  var dealAgg = {}; // dealId → aggregation while we walk sheds
  snapshot.sheds = sheds.map(function(s) {
    var p      = s.properties;
    var dealId = (shedToDeals[s.id] || [])[0];
    var dp     = (dealMap[dealId] && dealMap[dealId].properties) || {};
    var num    = Math.max(1, parseInt(dp.num_associated_sheds || '1', 10) || 1);
    var disp   = parseFloat(dp.dispatch_value || '0') || 0;

    var job = {
      id:                 s.id,
      dealId:             dealId || '',
      // ⚠ NAMING TRAP: the Shed's dispatch date is stored in the field whose
      // HubSpot internal name is `install_date`. There is NO `dispatch_date`
      // on the Shed. The dispatch date is ALWAYS the shed's install_date and
      // NEVER the deal's dispatch_date (Dan, 2026-07-16). Getting this wrong
      // was the root of the "Hutton" bug — the app fell back to the deal's
      // stale date. Keep both names pointing at install_date for clarity.
      installDate:        normalizeHsDate_(p.install_date),
      targetDispatchDate: normalizeHsDate_(p.install_date),
      // Planned / Proposed / Confirmed / On Hold — set by sales in HubSpot on the shed
      hsDispatchStatus:   normalizeHsStatus_(p.dispatch_status),
      onHold:             normalizeHsStatus_(p.dispatch_status) === 'on_hold',
      postCode:           ((p.post_code || dp.post_code) || '').trim(),
      dispatchType:       p.dispatch_type || '',
      shedType:           p.shed_type || '',
      shedTypeCustomer:   p.shed_type_customer_facing || '',
      finish:             p.finish || '',
      multipleNumber:     p.multiple_shed_number || '',
      drawingNo:          p.drawing_no || '',
      shedDealNumber:     p.shed_deal_number || '',
      // The shed's own name (auto-formatted "job# - Name - shed type - #/#")
      // is THE display name for the job everywhere (Dan, 2026-07-16). Deal
      // name is only a fallback for a shed with no name set. Single sheds
      // have an empty #/# part, leaving a dangling " - " — trim it.
      jobRef:             cleanShedName_(p.hs_name) || dp.dealname || ('Shed ' + s.id),
      shedName:           cleanShedName_(p.hs_name),
      shedValue:          parseFloat(p.shed_value || '0') || 0,
      estBuildHours:      parseFloat(p.estimated_build_hours || '0') || 0,
      estInstallHours:    parseFloat(p.estimated_install_hours || '0') || 0,
      // ⚠ NAMING TRAP #2: install_value's label is "dispatch value" —
      // the shed's own £ (like install_date, the install_* name is the
      // dispatch-facing field).
      installValue:       parseFloat(p.install_value || '0') || 0,
      perShedValue:       Math.round((disp / num) * 100) / 100,
      // Per-shed (was per-deal): this shed's own dispatch eligibility/finish
      geoEligible:        isGeoDispatchType_(p.dispatch_type || ''),
      missingFinish:      !p.finish,
      // Installer view: address / client contact / OneDrive folder come
      // from flat DEAL fields; site conditions prefer the shed's copy.
      address:            [dp.street, dp['city__county__state'],
                           ((p.post_code || dp.post_code) || '')]
                            .filter(Boolean).join(', '),
      contactName:        dp.contact_last_name || '',
      contactEmail:       dp.contact_email || '',
      contactPhone:       dp.phone_number || '',
      siteContactPhone:   dp.site_contact_phone || '',
      projectFolder:      dp.project_folder || '',
      site: {
        parking:     p['parking_arrangements__shed_'] || '',
        level:       p['is_the_site_level___shed_'] || dp['is_the_site_level_'] || '',
        accessNotes: p['site_access_or_leveling_notes__shed_'] || dp.site_access_or_leveling_notes || '',
        supplyType:  p['supply_type__shed_'] || ''
      },
      extras: {
        securityPack:    p['security_pack__shed_']              === 'true',
        biFolds:         p['bi_folds__shed_']                   === 'true',
        // Both green-roof names exist in HubSpot history — read either
        greenRoof:       p['green_roof'] === 'true' || p['green_roof__shed_'] === 'true',
        joiningPanel:    p['joining_panel__shed_']              === 'true',
        storageHooks:    p['storage_hooks__shed_']              === 'true',
        endShelves:      p['end_shelves__shed_']                === 'true',
        recyclingShelf:  p['recycling_shelf__shed_']            === 'true',
        steadyracks:     p['steadyracks__shed_']                === 'true',
        additionalStorage: p['additional_storage'] || '',
        additionalNotes: p['additional_product_requirements__shed_'] || ''
      }
    };

    if (dealId) {
      var agg = dealAgg[dealId] || (dealAgg[dealId] = {
        shedIds: [], finishes: {}, dispatchTypes: {}, missingFinish: false,
        shedTargets: [], hsStatuses: {}, postCodes: []
      });
      agg.shedIds.push(s.id);
      if (job.finish) agg.finishes[job.finish] = true; else agg.missingFinish = true;
      if (job.dispatchType) agg.dispatchTypes[job.dispatchType] = true;
      if (job.targetDispatchDate) agg.shedTargets.push(job.targetDispatchDate);
      if (job.hsDispatchStatus) agg.hsStatuses[job.hsDispatchStatus] = true;
      if (job.postCode) agg.postCodes.push(job.postCode);
      if (job.onHold) agg.anyOnHold = true;
      (agg.shedTypes = agg.shedTypes || []).push(job.shedType);
    }
    return job;
  });

  // ── Derived product value from deal LINE ITEMS (Dan, 2026-07-17) ──
  // shed value = all line items net of VAT EXCLUDING dispatch services
  // (SKU/name matching CONFIG.DISPATCH_LINE_ITEM — e.g. "ST-I-Z2-1",
  // "Install Z2-1 shed"). Attribution is exact for single-shed deals;
  // multi-shed deals are ambiguous → flagged for review, not guessed.
  // READ-ONLY as always; fail-soft if the token lacks the line-items
  // scope (grant crm.objects.line_items.read in the Private App).
  var dealLines = {};        // dealId → [{sku, name, amount}] (dispatch excluded)
  var dealProductTotals = {};
  try {
    var liAssoc = hsBatchAssocV4_(token, 'deals', 'line_items', dealIds);
    var liIds = hsDedupe_(Object.keys(liAssoc).reduce(function(acc, k) {
      return acc.concat(liAssoc[k] || []);
    }, []));
    var liById = {};
    if (liIds.length) {
      hsBatchRead_(token, 'line_items', liIds, ['name', 'amount', 'hs_sku'])
        .forEach(function(li) { liById[li.id] = li.properties || {}; });
    }
    Object.keys(liAssoc).forEach(function(dealId) {
      var lines = [], total = 0;
      (liAssoc[dealId] || []).forEach(function(liId) {
        var li = liById[liId] || {};
        if (CONFIG.DISPATCH_LINE_ITEM.test(String(li.hs_sku || '')) ||
            CONFIG.DISPATCH_LINE_ITEM.test(String(li.name || ''))) return;
        var amt = parseFloat(li.amount || '0') || 0;
        lines.push({ sku: String(li.hs_sku || ''), name: String(li.name || ''), amount: amt });
        total += amt;
      });
      dealLines[dealId] = lines;
      dealProductTotals[dealId] = Math.round(total * 100) / 100;
    });
    snapshot.lineItemsOk = true;
  } catch (eLi) {
    snapshot.lineItemsOk = false;
    snapshot.lineItemsError = eLi.message;
    Logger.log('line items: ' + eLi.message);
  }

  // Product value per shed: HubSpot shed_value wins; else derived from
  // line items — whole total for single-shed deals, SKU↔shed-type + add-on
  // flag allocation for multi-shed deals (Dan, 2026-07-17; verified on
  // 1530 Bunn: "BS-besp" £1550 ↔ BS-besp shed, "BSPK" £1350 ↔ Bespoke
  // shed, Joining Panel line ↔ the flagged shed). Anything that doesn't
  // allocate CLEANLY stays flagged for review — never guessed.
  var dealShedMap = {};
  snapshot.sheds.forEach(function(j) {
    if (j.dealId) (dealShedMap[j.dealId] = dealShedMap[j.dealId] || []).push(j);
  });
  Object.keys(dealShedMap).forEach(function(dealId) {
    var sheds = dealShedMap[dealId];
    var lines = dealLines[dealId];
    var total = dealProductTotals[dealId] || 0;
    var alloc = null;
    if (lines && lines.length && sheds.length > 1) {
      alloc = allocateLinesToSheds_(lines, sheds);
    }
    sheds.forEach(function(job) {
      job.dealProductTotal = total;
      if (job.shedValue) {
        job.productValue = job.shedValue;
        job.valueSource = 'shed_value';
      } else if (total && sheds.length === 1) {
        job.productValue = total;
        job.valueSource = 'line_items';
      } else if (alloc && alloc.ok) {
        job.productValue = Math.round((alloc.byShed[job.id] || 0) * 100) / 100;
        job.valueSource = 'line_items_split';
      } else {
        job.productValue = 0;
        job.valueSource = total ? 'multi_shed_review' : '';
        if (alloc && !alloc.ok) {
          job.valueReviewWhy = 'could not place: ' + alloc.unallocated.join(', ');
        }
      }
    });
  });

  // Per-shed dispatch value (Dan, 2026-07-16): the shed field install_value
  // (label "dispatch value" — NAMING TRAP #2) holds the ORDER's dispatch £,
  // stamped identically on each of the order's sheds (verified live: all
  // three Bate sheds carry 160, both Chapman sheds 315). Divide it across
  // the units so a day/week total isn't multiple-counted. The deal's own
  // dispatch_value is empty in practice — kept only as a fallback.
  snapshot.sheds.forEach(function(job) {
    var dp    = (job.dealId && dealMap[job.dealId] && dealMap[job.dealId].properties) || {};
    var units = parseInt(dp.num_associated_sheds || '0', 10) ||
                (job.dealId && dealAgg[job.dealId] ? dealAgg[job.dealId].shedIds.length : 1) || 1;
    var orderValue = job.installValue || parseFloat(dp.dispatch_value || '0') || 0;
    job.perShedValue = Math.round((orderValue / units) * 100) / 100;
  });

  // ── Build deal cards (one per parent deal) ──────────────────
  snapshot.deals = Object.keys(dealAgg).map(function(dealId) {
    var dp  = dealMap[dealId].properties || {};
    var agg = dealAgg[dealId];
    var dispatchTypes = Object.keys(agg.dispatchTypes);
    // Deal-level dispatch date = earliest of its sheds' dispatch dates.
    // Sheds are the SOLE source — never the deal's own dispatch_date, which
    // can be stale (Dan, 2026-07-16). No fallback: no shed date = no date.
    var shedTarget = agg.shedTargets.length ? agg.shedTargets.sort()[0] : null;
    // Most advanced shed status wins for the order
    var hsStatus = agg.hsStatuses.confirmed ? 'confirmed'
                 : agg.hsStatuses.proposed  ? 'proposed'
                 : agg.hsStatuses.planned   ? 'planned' : '';
    return {
      id:                 dealId,
      name:               dp.dealname || ('Deal ' + dealId),
      postCode:           (agg.postCodes[0] || dp.post_code || '').trim(),
      hsDispatchStatus:   hsStatus,
      targetDispatchDate: shedTarget,
      closeDate:          normalizeHsDate_(dp.closedate),
      dispatchValue:      parseFloat(dp.dispatch_value || '0') || 0,
      shedIds:            agg.shedIds,
      shedTypes:          agg.shedTypes || [],
      numSheds:           agg.shedIds.length,
      finishes:           Object.keys(agg.finishes),
      missingFinish:      agg.missingFinish,
      dispatchTypes:      dispatchTypes,
      geoEligible:        dispatchTypes.some(isGeoDispatchType_),
      // Any shed on hold takes the whole order out of auto-scheduling —
      // a partial dispatch isn't useful (Dan, 2026-07-15).
      onHold:             !!agg.anyOnHold
    };
  });

  // Amendments pipeline tickets (fail-soft: the board still works without them)
  try {
    snapshot.amendments = fetchAmendments_(token);
  } catch (e) {
    snapshot.amendments = [];
    snapshot.amendmentsError = e.message;
    Logger.log('fetchAmendments_: ' + e.message);
  }

  cachePutJson_(CONFIG.CACHE_KEY, snapshot, CONFIG.CACHE_TTL);
  return snapshot;
}

// ── Amendments (tickets) ─────────────────────────────────────
// Live (non-Complete) tickets in the Amendments pipeline, cross-referenced
// to their deal and the deal's sheds for the ORIGINAL dispatch date.
// Type: hs_ticket_category ("Site Survey", "Amendment", …) with a
// stage/subject heuristic while categories are being back-filled.
// Planning date: survey → agreed_survey_date___time;
//                amendment → final_resolution_date, else repair_scheduled_date.

function fetchAmendments_(token) {
  var A = CONFIG.AMENDMENTS;
  var tickets = hsSearchAll_(token, 'tickets', {
    filterGroups: [{
      filters: [
        { propertyName: 'hs_pipeline', operator: 'EQ', value: A.PIPELINE },
        { propertyName: 'hs_pipeline_stage', operator: 'NEQ', value: A.COMPLETE_STAGE }
      ]
    }],
    properties: A.TICKET_PROPS
  });
  if (!tickets.length) return [];

  var tickToDeals = hsBatchAssocV4_(token, 'tickets', 'deals', tickets.map(function(t) { return t.id; }));
  var dealIds = hsDedupe_(Object.keys(tickToDeals).reduce(function(acc, k) {
    return acc.concat(tickToDeals[k] || []);
  }, []));

  var dealMap = {};
  var dealShedTarget = {}; // dealId → earliest shed dispatch_date (original dispatch)
  if (dealIds.length) {
    hsBatchRead_(token, 'deals', dealIds, ['dealname', 'post_code', 'dispatch_date'])
      .forEach(function(d) { dealMap[d.id] = d; });
    var dealToSheds = hsBatchAssocV4_(token, 'deals', CONFIG.HS_SHED_TYPE, dealIds);
    var shedIds = hsDedupe_(Object.keys(dealToSheds).reduce(function(acc, k) {
      return acc.concat(dealToSheds[k] || []);
    }, []));
    var shedDates = {};
    if (shedIds.length) {
      hsBatchRead_(token, CONFIG.HS_SHED_TYPE, shedIds, ['dispatch_date'])
        .forEach(function(s) { shedDates[s.id] = normalizeHsDate_(s.properties.dispatch_date); });
    }
    Object.keys(dealToSheds).forEach(function(dealId) {
      var dates = (dealToSheds[dealId] || [])
        .map(function(id) { return shedDates[id]; })
        .filter(Boolean)
        .sort();
      if (dates.length) dealShedTarget[dealId] = dates[0];
    });
  }

  return tickets.map(function(t) {
    var p      = t.properties;
    var dealId = (tickToDeals[t.id] || [])[0] || '';
    var dp     = (dealMap[dealId] && dealMap[dealId].properties) || {};

    var category = p.hs_ticket_category || '';
    var subj     = (p.subject || '').toLowerCase();
    var isSurvey = /survey/i.test(category) ||
      (!category && (p.hs_pipeline_stage === '1089435420' ||
        subj.indexOf('survey') > -1 || subj.indexOf('site visit') > -1));

    var agreedSurvey = normalizeHsDate_(p['agreed_survey_date___time']);
    var finalRes     = normalizeHsDate_(p.final_resolution_date);
    var repairSched  = normalizeHsDate_(p.repair_scheduled_date);

    return {
      id:              t.id,
      subject:         p.subject || ('Ticket ' + t.id),
      stage:           p.hs_pipeline_stage || '',
      stageLabel:      A.STAGE_LABELS[p.hs_pipeline_stage] || '',
      category:        category,
      type:            isSurvey ? 'survey' : 'amendment',
      // The date this visit is planned for (board placement)
      date:            isSurvey ? agreedSurvey : (finalRes || repairSched),
      agreedSurveyDate:    agreedSurvey,
      finalResolutionDate: finalRes,
      repairScheduledDate: repairSched,
      postCode:        (p.site_postcode || dp.post_code || '').trim(),
      dealId:          dealId,
      dealName:        dp.dealname || '',
      // Shed dispatch_date is the truth for when the order originally went out
      originalDispatchDate: dealShedTarget[dealId] || normalizeHsDate_(dp.dispatch_date),
      created:         normalizeHsDate_(p.createdate),
      url: 'https://app.hubspot.com/contacts/' + CONFIG.HS_PORTAL_ID + '/record/0-5/' + t.id
    };
  });
}

// ── Line-item → shed allocation (multi-shed deals) ───────────
// Greedy rounds, strictest first; succeeds ONLY if every line lands:
//   A. exact SKU/type match ("BS-besp" line ↔ BS-besp shed)
//   B. prefix match ("V6" line ↔ V6-2424 shed)
//   C. bespoke class: remaining besp-ish line ↔ remaining besp shed (1:1 only)
//   D. add-on lines ↔ the ONE shed with that add-on flag (JPANEL ↔
//      joining_panel, STEADYRACK ↔ steadyracks, …)
//   E. variation lines ↔ the ONE bespoke shed on the deal
// Any leftover line → {ok:false} and the deal keeps its review flag.
var ADDON_LINE_FLAGS_ = [
  [/JPANEL|JOINING/i,          'joiningPanel'],
  [/STEADYRACK/i,              'steadyracks'],
  [/HOOK/i,                    'storageHooks'],
  [/RECYC/i,                   'recyclingShelf'],
  [/SHELF|SHELV/i,             'endShelves'],
  [/GREEN.?ROOF|SEDUM/i,       'greenRoof'],
  [/SECURITY/i,                'securityPack'],
  [/BI.?FOLD/i,                'biFolds'],
  [/STORAGE/i,                 'additionalStorage']
];

function allocateLinesToSheds_(lines, sheds) {
  function norm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function isBespLine(l) { return /BESP|BSPK/i.test(l.sku) || /BESPOKE/i.test(l.name); }
  function isBespShed(j) { return /BESP/i.test(j.shedType || ''); }

  var byShed = {}, taken = {}, shedOfLine = {};
  sheds.forEach(function(j) { byShed[j.id] = 0; });
  function assign(i, shed) { shedOfLine[i] = shed.id; byShed[shed.id] += lines[i].amount; }

  // A + B: type matching (exact first, then prefix), unique candidate only
  [function(t, l) { return t && (norm(l.sku) === t || norm(l.name) === t); },
   function(t, l) {
     var s = norm(l.sku);
     return t && s && (t.indexOf(s) === 0 || s.indexOf(t) === 0);
   }].forEach(function(match) {
    lines.forEach(function(l, i) {
      if (shedOfLine[i] !== undefined) return;
      var cands = sheds.filter(function(j) { return !taken[j.id] && match(norm(j.shedType), l); });
      if (cands.length === 1) { assign(i, cands[0]); taken[cands[0].id] = true; }
    });
  });

  // C: one remaining bespoke line ↔ one remaining bespoke shed
  var bespLines = [], bespSheds = sheds.filter(function(j) { return !taken[j.id] && isBespShed(j); });
  lines.forEach(function(l, i) { if (shedOfLine[i] === undefined && isBespLine(l) && !/VARI/i.test(l.sku)) bespLines.push(i); });
  if (bespLines.length === 1 && bespSheds.length === 1) {
    assign(bespLines[0], bespSheds[0]); taken[bespSheds[0].id] = true;
  }

  // D: add-on lines to the shed(s) carrying that flag — split evenly when
  // several sheds share it (e.g. Sady: "Bi-fold door ×2" with bi-folds
  // flagged on both sheds → £185 each; the flags make it determinate)
  lines.forEach(function(l, i) {
    if (shedOfLine[i] !== undefined) return;
    ADDON_LINE_FLAGS_.forEach(function(rule) {
      if (shedOfLine[i] !== undefined) return;
      if (!rule[0].test(l.sku) && !rule[0].test(l.name)) return;
      var flagged = sheds.filter(function(j) { return j.extras && j.extras[rule[1]]; });
      if (!flagged.length) return;
      shedOfLine[i] = 'split';
      var share = l.amount / flagged.length;
      flagged.forEach(function(j) { byShed[j.id] += share; });
    });
  });

  // E: variation lines to the deal's single bespoke shed
  lines.forEach(function(l, i) {
    if (shedOfLine[i] !== undefined) return;
    if (!/VARI/i.test(l.sku) && !/VARIATION/i.test(l.name)) return;
    var besp = sheds.filter(isBespShed);
    if (besp.length === 1) assign(i, besp[0]);
  });

  // F: a SMALL leftover (≤20% of the deal — e.g. an accessory line whose
  // add-on flag isn't ticked on any shed) spreads evenly rather than
  // sinking the whole allocation; big leftovers still flag for review.
  var unallocated = lines.filter(function(l, i) { return shedOfLine[i] === undefined; });
  var leftover = unallocated.reduce(function(t, l) { return t + l.amount; }, 0);
  var total = lines.reduce(function(t, l) { return t + l.amount; }, 0);
  if (leftover > 0 && total > 0 && leftover / total <= 0.2) {
    var share2 = leftover / sheds.length;
    sheds.forEach(function(j) { byShed[j.id] += share2; });
    return { ok: true, byShed: byShed, spread: unallocated.map(function(l) { return l.name; }) };
  }
  return { ok: unallocated.length === 0, byShed: byShed,
           unallocated: unallocated.map(function(l) { return l.name; }) };
}

// Strips the trailing separator hs_name carries when the multiple-shed
// number is empty ("1373 - Bate - BS3 - " → "1373 - Bate - BS3").
function cleanShedName_(name) {
  return String(name || '').replace(/[\s\-–]+$/, '');
}

// Normalises the shed's dispatch_status to 'planned' | 'proposed' |
// 'confirmed' | 'on_hold' | ''.
// ⚠ The HubSpot dropdown's stored VALUES are quirky (confirmed via the
// 2026-07-16 property export): Planned is stored as "true", Proposed as
// "false", Confirmed as "Confirmed". We map those explicitly AND accept the
// plain words, so this keeps working if Dan later cleans the values up.
function normalizeHsStatus_(val) {
  var s = String(val || '').trim().toLowerCase();
  if (s === 'true'  || s === 'planned')  return 'planned';
  if (s === 'false' || s === 'proposed') return 'proposed';
  if (s === 'confirmed') return 'confirmed';
  if (s === 'on hold' || s === 'on_hold' || s === 'on-hold') return 'on_hold';
  return '';
}

// The ONE place "what date are we working towards for this shed" is decided.
// Used by every view (Tracker, Scheduler, Dispatch) so they never disagree.
// Precedence: HubSpot Proposed/Confirmed status (the shed's dispatch date IS
// the agreed date) > the app's own draft/proposed/confirmed dispatch tab >
// the shed's dispatch date. The shed's dispatch date lives in the field
// named install_date (see the NAMING TRAP note above); job.targetDispatchDate
// and job.installDate are both that same value.
function resolvePlanningInfo_(job, dispatchRow) {
  var ds = dispatchRow || {};
  var hs = job.hsDispatchStatus || '';
  var fromHubspot = (hs === 'proposed' || hs === 'confirmed');
  var dispatchStatus = fromHubspot ? hs : (ds.dispatch_status || '');
  var planningDate =
    fromHubspot ? job.targetDispatchDate
    : (dispatchStatus === 'confirmed' || dispatchStatus === 'proposed') && ds.proposed_dispatch_date
      ? ds.proposed_dispatch_date
      : job.targetDispatchDate;

  return {
    planningDate:         planningDate || null,
    dispatchStatus:       dispatchStatus,
    statusSource:         fromHubspot ? 'hubspot' : (dispatchStatus ? 'app' : ''),
    proposedDispatchDate: ds.proposed_dispatch_date || ''
  };
}

function isGeoDispatchType_(type) {
  var t = String(type || '').toLowerCase();
  return CONFIG.GEO_DISPATCH_TYPES.some(function(k) { return t.indexOf(k) > -1; });
}

function invalidateLiveCache() {
  cacheRemoveJson_(CONFIG.CACHE_KEY);
  CacheService.getScriptCache().remove(CONFIG.TT_CACHE_KEY);
  bustViewPayloads_();
  return { ok: true };
}

// ── View-payload cache (perf pass 2, 2026-07-17) ─────────────
// Each view's get*Data() result is cached whole: requests serve in
// ~0.3s instead of rebuilding from sheet reads (2.5-5s). The 15-min
// warmer pre-builds all four; ANY state-sheet write busts them (see
// storeUpsert/storeBatchSetField), so edits appear immediately.
var PAYLOAD_KEYS_ = ['payload_tracker', 'payload_scheduler',
                     'payload_dispatch', 'payload_installer', 'payload_reports'];

function bustViewPayloads_() {
  PAYLOAD_KEYS_.forEach(function(k) { cacheRemoveJson_(k); });
}

function cachedPayload_(key, force, build) {
  if (!force) {
    var hit = cacheGetJson_(key);
    if (hit) return hit;
  }
  var payload = build();
  // TTL > warmer interval so the cache never expires between warm cycles
  cachePutJson_(key, payload, 1200);
  return payload;
}

// ── HTTP helpers ─────────────────────────────────────────────

function hsPost_(token, path, body) {
  var resp = UrlFetchApp.fetch(CONFIG.HS_BASE + path, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code >= 300) {
    throw new Error('HubSpot ' + path + ' → HTTP ' + code + ': ' + resp.getContentText().substring(0, 400));
  }
  return JSON.parse(resp.getContentText());
}

function hsSearchAll_(token, objectType, body) {
  var all = [], after = null;
  do {
    var req   = JSON.parse(JSON.stringify(body));
    req.limit = 100;
    if (after) req.after = after;
    var data  = hsPost_(token, '/crm/v3/objects/' + objectType + '/search', req);
    all       = all.concat(data.results || []);
    after     = (data.paging && data.paging.next) ? data.paging.next.after : null;
  } while (after);
  return all;
}

// v4 associations endpoint (required for custom objects)
function hsBatchAssocV4_(token, fromType, toType, ids) {
  var map = {};
  for (var i = 0; i < ids.length; i += 100) {
    var data = hsPost_(token, '/crm/v4/associations/' + fromType + '/' + toType + '/batch/read', {
      inputs: ids.slice(i, i + 100).map(function(id) { return { id: id }; })
    });
    (data.results || []).forEach(function(r) {
      map[r.from.id] = (r.to || []).map(function(x) { return x.toObjectId || x.id; });
    });
  }
  return map;
}

function hsBatchRead_(token, objectType, ids, properties) {
  var all = [];
  for (var i = 0; i < ids.length; i += 100) {
    var data = hsPost_(token, '/crm/v3/objects/' + objectType + '/batch/read', {
      inputs: ids.slice(i, i + 100).map(function(id) { return { id: id }; }),
      properties: properties
    });
    all = all.concat(data.results || []);
  }
  return all;
}

function hsDedupe_(arr) {
  var seen = {}, out = [];
  arr.forEach(function(v) { if (!seen[v]) { seen[v] = true; out.push(v); } });
  return out;
}

// HubSpot date properties arrive as YYYY-MM-DD strings — already the correct
// local date. Epoch-millis (datetime fields) formatted in Europe/London.
function normalizeHsDate_(val) {
  if (!val) return null;
  var s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  var n = Number(s);
  if (!isNaN(n) && n > 1e11) {
    return Utilities.formatDate(new Date(n), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  return null;
}

// ── Chunked cache for payloads > 100KB ───────────────────────
// CacheService caps values at ~100KB; we split the JSON string.

var CACHE_CHUNK_BYTES = 90000;

function cachePutJson_(key, obj, ttl) {
  try {
    var cache = CacheService.getScriptCache();
    var json  = JSON.stringify(obj);
    var chunks = Math.max(1, Math.ceil(json.length / CACHE_CHUNK_BYTES));
    var payload = { };
    payload[key + '_meta'] = JSON.stringify({ chunks: chunks });
    for (var i = 0; i < chunks; i++) {
      payload[key + '_' + i] = json.substr(i * CACHE_CHUNK_BYTES, CACHE_CHUNK_BYTES);
    }
    cache.putAll(payload, ttl);
  } catch (e) { Logger.log('cachePutJson_: ' + e.message); }
}

function cacheGetJson_(key) {
  try {
    var cache = CacheService.getScriptCache();
    var meta  = cache.get(key + '_meta');
    if (!meta) return null;
    var m = JSON.parse(meta), json = '';
    for (var i = 0; i < m.chunks; i++) {
      var chunk = cache.get(key + '_' + i);
      if (chunk === null) return null; // partial — treat as miss
      json += chunk;
    }
    return JSON.parse(json);
  } catch (e) { return null; }
}

function cacheRemoveJson_(key) {
  try {
    var cache = CacheService.getScriptCache();
    var meta  = cache.get(key + '_meta');
    if (meta) {
      var m = JSON.parse(meta);
      for (var i = 0; i < m.chunks; i++) cache.remove(key + '_' + i);
    }
    cache.remove(key + '_meta');
  } catch (e) {}
}
