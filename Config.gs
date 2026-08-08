// ============================================================
// BSC Production Hub — Config
// Single source of truth for every constant and schema.
// ============================================================

var CONFIG = {

  // ── HubSpot ────────────────────────────────────────────────
  HS_BASE: 'https://api.hubapi.com',
  HS_SHED_TYPE: '0-162',
  DEAL_STAGE_SALE: '1094492205',   // "Sale" in the Sales Pipeline

  // Shed property internal names, confirmed against the HubSpot export
  // (2026-07-16). NOTE: the shed's DISPATCH DATE is the field named
  // `install_date` (label "Dispatch date") — there is no `dispatch_date`
  // property on the Shed. See the NAMING TRAP note in HubSpot.gs.
  SHED_PROPS: [
    'hs_object_id', 'hs_name', 'install_date', 'dispatch_status', 'post_code',
    'dispatch_type', 'shed_type',
    'shed_type_customer_facing', 'finish', 'multiple_shed_number',
    'order_complete', 'drawing_no', 'shed_deal_number', 'shed_value',
    'install_value',   // ⚠ label is "dispatch value" — the shed's own £
    // Read defensively — Dan is adding these for the pricing feedback loop
    'estimated_build_hours', 'estimated_install_hours',

    'security_pack__shed_', 'bi_folds__shed_', 'green_roof', 'green_roof__shed_',
    'joining_panel__shed_', 'storage_hooks__shed_', 'end_shelves__shed_',
    'recycling_shelf__shed_', 'steadyracks__shed_',
    'additional_product_requirements__shed_',
    'additional_storage',  // "Additional Storage" dropdown (added ~Jul 2026)
    // Site conditions (installer view; deal-level copies exist as fallback)
    'parking_arrangements__shed_', 'is_the_site_level___shed_',
    'site_access_or_leveling_notes__shed_', 'supply_type__shed_'
  ],
  // Deal dispatch date is NOT used — dispatch date always comes from the
  // shed's install_date (Dan, 2026-07-16). Deal props are order metadata only.
  DEAL_PROPS: [
    'dealname', 'dealstage', 'dispatch_value', 'num_associated_sheds',
    'post_code', 'closedate',
    // Installer view (verified via HubSpot property search 2026-07-17):
    // full site address, client contact (flat fields on the deal — no
    // contact-association fetch needed), OneDrive project folder link,
    // deal-level copies of the site-condition fields.
    'street', 'city__county__state', 'contact_last_name', 'contact_email',
    'phone_number', 'site_contact_phone', 'project_folder',
    'is_the_site_level_', 'site_access_or_leveling_notes'
  ],

  // ── Amendments pipeline (HubSpot tickets) ──────────────────
  AMENDMENTS: {
    PIPELINE: '749379237',          // "Amendments" ticket pipeline
    COMPLETE_STAGE: '1092450596',   // its "Complete" stage — excluded
    STAGE_LABELS: {
      '1089435419': 'Triage',
      '1089435420': 'Survey',
      '1089435421': 'Fixing',
      '1089435422': 'Giving Advice'
    },
    TICKET_PROPS: [
      'subject', 'hs_pipeline_stage', 'hs_ticket_category',
      'agreed_survey_date___time', 'final_resolution_date',
      'repair_scheduled_date', 'site_postcode', 'createdate'
    ]
  },
  HS_PORTAL_ID: '48949961',

  // ── Caching ────────────────────────────────────────────────
  // ⚠ BUMP THE SUFFIX whenever fetchLiveData's output changes (new fields,
  // new mapping) — the cache outlives deploys, so without a bump the app
  // serves a snapshot built by the OLD code for up to 30 min after a
  // redeploy. This staged three separate "the fix didn't work" scares
  // (v10 names, v20 values, v29 project folders).
  CACHE_KEY: 'hub_live_v29',
  CACHE_TTL: 1800,                 // 30 min
  TT_CACHE_KEY: 'hub_leave_v1',
  TT_CACHE_TTL: 3600,

  // ── Workshop / capacity ────────────────────────────────────
  WORKSHOP_TEAM: [
    'Aidan Quinn', 'Alfie Turner', 'Darren Gurgul', 'Dean Nash',
    'Matt Dawkins', 'Matt McCarthy', 'Richard Smith', 'Steve Ellis', 'Yuri Kotliar'
  ],
  DAYS_PER_WEEK: 5,
  PRODUCTIVE_HRS_PER_DAY: 6.5,   // per person, per working day

  // Standard build times in working days, keyed by SKU prefix
  BUILD_DAYS: {
    'P3': 2.375, 'P5': 2.458, 'V5': 3.614, 'V6': 3.614,
    'BAY-bike': 2.623, 'BS3': 1.917, 'BS1': 1.533, 'BS2': 1.835,
    'R3': 3.724, 'R4': 3.745, 'R6': 3.755, 'TS': 3.256,
    'S3': 2.716, 'S4': 2.806, 'CS': 2.349, 'GS-std': 3.455
  },

  // Spray booth rules — the booth is the workshop's capacity meter.
  // Capacity 2–4 jobs/day; ideal pace 2.5–3 sprayed per day (Dan, 2026-07-14).
  SPRAY: {
    maxPerDay: 4,
    targetPerDayMin: 2.5,
    targetPerDayMax: 3,
    daysPerWeek: 5
  },

  // Production lead offsets (working days): frame 2 days before spray,
  // spray 2 days before assembly, assembly ≥1 day before dispatch (fluid).
  LEAD_DAYS: {
    frameToSpray: 2, sprayToAssembly: 2, assemblyToDispatchMin: 1,
    // Minimum working days between a spray date and the dispatch date before
    // we warn: 2 for assembly + 2 buffer before dispatch (Dan, 2026-07-15).
    sprayToDispatchMin: 4
  },

  // ── Production stages (10-stage model) ─────────────────────
  STAGES: [
    { key: 'cut',            label: 'Cut',        hasFaults: false },
    { key: 'framed',         label: 'Framed',     hasFaults: false },
    { key: 'component_prep', label: 'Comp. Prep', hasFaults: false },
    { key: 'qc1',            label: 'QC1',        hasFaults: true  },
    { key: 'spray_prep',     label: 'Spray Prep', hasFaults: false },
    { key: 'sprayed',        label: 'Sprayed',    hasFaults: false },
    { key: 'qc2',            label: 'QC2',        hasFaults: true  },
    { key: 'assembled',      label: 'Assembled',  hasFaults: false },
    { key: 'qc3',            label: 'QC3',        hasFaults: true  },
    { key: 'dispatched',     label: 'Dispatched', hasFaults: false }
  ],

  ODD_JOBS: [
    { key: 'b1_complete', label: 'Ply Prep',   sub: 'Base & Lid cutting, painting, chamfering' },
    { key: 'c_complete',  label: 'Lid Frame',  sub: 'Lid frame built, ply attached, rubber stapled' },
    { key: 'd_complete',  label: 'Base Frame', sub: 'Base frame cut & assembled' }
  ],

  // ── Dispatch planning ──────────────────────────────────────
  DISPATCH_WINDOW_DAYS: 14,        // proposed date must sit within target ± this
  DISPATCH_STATUSES: ['draft', 'proposed', 'confirmed'],
  // dispatch_type values (lowercased, substring match) that involve our crew travelling
  GEO_DISPATCH_TYPES: ['install', 'team', 'andy'],

  GEO: {
    clusterKm: 40,                 // max distance from group seed
    maxGroup: 5,                   // max jobs per suggested group
    postcodesApi: 'https://api.postcodes.io',
    osrmApi: 'https://router.project-osrm.org'   // free public routing (adopted from Dan's route-planner prototype)
  },

  // ── Install-day planning model (Dan, 2026-07-14) ───────────
  INSTALL_DAY: {
    WORKSHOP_POSTCODE: 'BS3 2UN',  // The Bike Shed Co workshop, Bristol
    vanSlots: 4,                   // panel van capacity in "small shed" units
    // Rough van slots per SKU prefix — ESTIMATES for Dan to correct.
    // Small standards (P3, bin/cushion stores) = 1 slot → 4 fit.
    slotsByPrefix: {
      'P3': 1, 'BS': 1, 'CS': 1,
      'P5': 1.5, 'S3': 1.5, 'S4': 1.5, 'BAY': 1.5,
      'R3': 2, 'R4': 2, 'R6': 2, 'TS': 2, 'V5': 2, 'V6': 2,
      'GS': 2.5
    },
    defaultSlots: 2,               // unknown/bespoke types
    maxSheds: 4,                   // never more than 4 sheds out
    maxCustomersAtMaxSheds: 2,     // 4 sheds only if spread over ≤2 customers
    maxCustomers: 3,
    loadMins: 30,                  // loading at the workshop
    installMinsPerShed: 105,       // 1.5–2h → 1.75h
    extraShedSameCustomerMins: 60, // 2nd shed at the same address is quicker
    surveyMins: 45,
    bufferPerStopMins: 10,
    maxLegMins: 60,                // max drive between customer addresses
    dayTargetHrs: 11,              // aim ≤11h door-to-door (Tue–Thu ideal days)
    mondayTargetHrs: 8,            // Mondays are the short local day
    dayMaxHrs: 12,                 // hard-ish cap (13–14 only in exceptional cases, manual)
    // Install crew economics (Dan, 2026-07-16): 2-man team; ideal week =
    // Mon 8h + Tue–Thu 3×11h = 41h each (40 paid + 1 OT) → 82 team
    // man-hours/week. Estimated man-hours = door-to-door day duration ×
    // crewSize; rev/hr = day value ÷ man-hours.
    crewSize: 2,
    paidManHrsPerWeek: 82,
    // Weekly rhythm: Tue/Wed/Thu = London installs; Mon = occasional
    // Bristol/local only (never London); Fri = courier deliveries.
    londonDays: [2, 3, 4],         // Tue, Wed, Thu (JS getDay)
    localDays: [1, 2, 3, 4],       // Mon–Thu for non-London
    // Fallback speeds when OSRM is unavailable (DfT-derived, van-adjusted)
    speedKmhLong: 75,              // >50km legs (motorway-dominated, ~47mph avg)
    speedKmhMid: 50,               // 15–50km legs
    speedKmhShort: 24,             // <15km legs (urban)
    routeFactor: 1.25              // straight-line → road distance multiplier
  },
  PENALTY_WINDOW_DAYS: 14,         // moving a confirmed date within 14 days = penalty

  // ── UK public holidays (England & Wales) ───────────────────
  // Fetched from the free gov.uk feed, cached 24h; the fallback list keeps
  // the calendars honest if the fetch ever fails. We never work these days.
  HOLIDAYS: {
    API: 'https://www.gov.uk/bank-holidays.json',
    DIVISION: 'england-and-wales',
    FALLBACK: {
      '2026-01-01': "New Year's Day", '2026-04-03': 'Good Friday',
      '2026-04-06': 'Easter Monday', '2026-05-04': 'Early May bank holiday',
      '2026-05-25': 'Spring bank holiday', '2026-08-31': 'Summer bank holiday',
      '2026-12-25': 'Christmas Day', '2026-12-28': 'Boxing Day (substitute)',
      '2027-01-01': "New Year's Day", '2027-03-26': 'Good Friday',
      '2027-03-29': 'Easter Monday', '2027-05-03': 'Early May bank holiday',
      '2027-05-31': 'Spring bank holiday', '2027-08-30': 'Summer bank holiday',
      '2027-12-27': 'Christmas Day (substitute)', '2027-12-28': 'Boxing Day (substitute)'
    }
  },

  // ── Efficiency reporting (Dan, 2026-07-17) ─────────────────
  // DRAFT hour-share per stage (fraction of a job's build hours) — powers
  // earned £ AND earned hours. Steve + Dan to review; change HERE only.
  STAGE_HOUR_WEIGHTS: {
    cut: 0.10, framed: 0.22, component_prep: 0.15, qc1: 0.03,
    spray_prep: 0.05, sprayed: 0.15, qc2: 0.03, assembled: 0.22,
    qc3: 0.03, dispatched: 0.02
  },
  TARGETS: {
    workshopPerHr: 80,   // £ per paid workshop hour
    combinedPerHr: 75    // £ per paid hour incl. install crew — TBD by Dan
  },
  PAID_HRS_PER_DAY: 8,   // paid (not productive) workshop hours per person/day
  // Line items whose SKU/name mark them as dispatch services, EXCLUDED from
  // derived shed value (Dan: shed value = everything except dispatch, net VAT)
  DISPATCH_LINE_ITEM: /^ST-I|install|deliver|courier/i,
  // Non-sold time categories — PLACEHOLDERS until Dan's list arrives
  NON_SOLD_TASKS: ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6'],

  // Workstations for day sheets (per-STATION, Dan 2026-07-17). Each
  // station's daily queue is DERIVED: its stages' target dates land on the
  // day (spray = planned spray date; cut/framing/prep = spray − lead;
  // assembly = planned assembly date; lid = due before assembly).
  STATIONS: [
    { key: 'cut',      label: 'Cut',                    stages: ['cut'] },
    { key: 'framing',  label: 'Framing',                stages: ['framed'] },
    { key: 'prep',     label: 'Component & Spray Prep', stages: ['component_prep', 'spray_prep'] },
    { key: 'spray',    label: 'Spray Booth',            stages: ['sprayed'] },
    { key: 'assembly', label: 'Assembly',               stages: ['assembled'] },
    { key: 'lid',      label: 'Lid Station',            stages: ['lid'] },
    { key: 'base',     label: 'Base Prep',              stages: [] }
  ],

  // Planned non-sold tasks per day/station (+ their day-close actuals)
  DAY_TASKS_HEADERS: ['task_key', 'day', 'station', 'task', 'est_hrs',
                      'done', 'actual_hrs', 'done_by', 'notes', 'last_updated'],
  // Day-close actuals per job/station — the raw material for refining
  // build times and the bespoke calculator
  WORKLOG_HEADERS: ['entry_key', 'day', 'shed_id', 'shed_name', 'station',
                    'est_hrs', 'actual_hrs', 'done_by', 'done', 'notes', 'last_updated'],

  // ── Backups (Dan, 2026-07-17) ──────────────────────────────
  // Nightly server-side snapshot of the state spreadsheet — runs on
  // Google's servers via a time-driven trigger (laptop-independent).
  // Alerts BY EMAIL ONLY ON FAILURE (approved by Dan). See Backup.gs.
  BACKUP: {
    FOLDER_NAME: 'BSC Hub Backups',
    HOUR: 2,                    // 02:00 Europe/London nightly
    DAILY_KEEP: 30,             // rolling daily snapshots
    MONTHLY_KEEP_DAYS: 730,     // 1st-of-month snapshots kept ~2 years
    ALERT_EMAIL: 'dan@thebikeshedcompany.com'
  },

  // ── State spreadsheet ──────────────────────────────────────
  STATE_SHEET_NAME: 'BSC_ProdTracker_State',
  TABS: { jobs: 'Jobs', dispatch: 'Dispatch', geo: 'Geo', dayNotes: 'DispatchDayNotes', archive: 'Archive', reports: 'InstallReports',
          dayTasks: 'DayTasks', worklog: 'WorkLog', feedback: 'AppFeedback' },

  // Jobs tab: the legacy 39 columns IN ORDER (old apps still read
  // positionally while they remain live) + stage_qc3_faults appended.
  JOBS_HEADERS: [
    'shed_id', 'job_ref', 'shed_type', 'finish', 'install_date',
    'stage_cut', 'stage_cut_date',
    'stage_framed', 'stage_framed_date',
    'stage_component_prep', 'stage_component_prep_date',
    'stage_qc1', 'stage_qc1_date', 'stage_qc1_faults',
    'stage_spray_prep', 'stage_spray_prep_date',
    'stage_sprayed', 'stage_sprayed_date',
    'stage_qc2', 'stage_qc2_date', 'stage_qc2_faults',
    'stage_assembled', 'stage_assembled_date',
    'stage_qc3', 'stage_qc3_date',
    'stage_dispatched', 'stage_dispatched_date',
    'planned_spray_date', 'planned_assembly_date', 'planned_week',
    'notes', 'last_updated',
    'override_build_days', 'week_locked', 'spray_batch_id', 'planned_day',
    'b1_complete', 'c_complete', 'd_complete',
    'stage_qc3_faults',
    // Appended 2026-07-16 (invariant #3 — only ever append):
    // structured QC issue categories + drawing/buying gates
    'stage_qc1_fault_cats', 'stage_qc2_fault_cats', 'stage_qc3_fault_cats',
    'skp_done', 'skp_done_date', 'lyt_done', 'lyt_done_date',
    'sedum_ordered',
    // Lid station (Dan, 2026-07-16): lid construction is a full workstation
    // equal to panel framing — one checkpoint, parallel to the stage track.
    // Often built DURING assembly, so it warns (never blocks) at Assembled.
    'lid_complete', 'lid_complete_date',
    // Who did each stage (Steve name-taps on tick — one person per stage)
    'stage_cut_by', 'stage_framed_by', 'stage_component_prep_by',
    'stage_qc1_by', 'stage_spray_prep_by', 'stage_sprayed_by',
    'stage_qc2_by', 'stage_assembled_by', 'stage_qc3_by',
    'stage_dispatched_by', 'lid_complete_by'
  ],

  // ── Installer view (Dan, 2026-07-17) ───────────────────────
  INSTALLER: {
    // Rework alerts land here so a forgotten shelf / damaged panel is
    // never missed. Change to a shared office inbox when there is one.
    REWORK_EMAIL: 'dan@thebikeshedcompany.com'
  },

  // One row per completed install visit (keyed shed_id; QC4 lives here —
  // the on-site quality check, distinct from the workshop's QC1-3).
  INSTALL_REPORT_HEADERS: [
    'shed_id', 'shed_name', 'report_date', 'arrival_time', 'time_taken_hrs',
    'qc4_pass', 'qc4_faults', 'rework_required', 'rework_details',
    'notes', 'submitted_by', 'submitted_at', 'last_updated'
  ],

  // Structured QC issue categories (Dan, 2026-07-16) — ticked alongside the
  // free-text fault note so workshop mistakes can be analysed later.
  QC_ISSUE_CATEGORIES: [
    'Timber quality', 'Drawing issue', 'SOP not followed', 'Machining error',
    'Spray defect', 'Handling damage', 'Hardware/fittings', 'Other'
  ],

  // Snapshot of a job the moment it's marked Dispatched — the permanent
  // record of when each stage happened (Jobs rows stay too; this is the
  // browsable history). restored=TRUE rows have been un-archived.
  ARCHIVE_HEADERS: [
    'shed_id', 'shed_name', 'shed_type', 'finish', 'deal_id', 'post_code',
    'dispatch_value', 'planned_week', 'planned_spray_date', 'planned_assembly_date',
    'stage_cut_date', 'stage_framed_date', 'stage_component_prep_date',
    'stage_qc1_date', 'stage_qc1_faults', 'stage_qc1_fault_cats',
    'stage_spray_prep_date', 'stage_sprayed_date',
    'stage_qc2_date', 'stage_qc2_faults', 'stage_qc2_fault_cats',
    'stage_assembled_date',
    'stage_qc3_date', 'stage_qc3_faults', 'stage_qc3_fault_cats',
    'stage_dispatched_date', 'notes', 'archived_at', 'restored', 'last_updated',
    'lid_complete_date',
    // Reporting needs the product value + who did each stage, forever
    'product_value',
    'stage_cut_by', 'stage_framed_by', 'stage_component_prep_by',
    'stage_qc1_by', 'stage_spray_prep_by', 'stage_sprayed_by',
    'stage_qc2_by', 'stage_assembled_by', 'stage_qc3_by',
    'stage_dispatched_by', 'lid_complete_by'
  ],

  // Dispatch planning is now per SHED (was per deal). shed_id/shed_name are
  // appended (never rename the old deal_id/deal_name cols — invariant #3);
  // the app keys dispatch rows on shed_id. Old deal-keyed rows are ignored.
  DISPATCH_HEADERS: [
    'deal_id', 'deal_name', 'post_code', 'lat', 'lng',
    'target_dispatch_date', 'proposed_dispatch_date', 'dispatch_status',
    'dispatch_group', 'notes', 'last_updated', 'single_day',
    'shed_id', 'shed_name',
    'route_order'   // installer's manual stop order within a day (v30)
  ],

  GEO_HEADERS: ['postcode', 'lat', 'lng', 'fetched_at'],

  // Free-text note per dispatch day (shown in the expanded week view)
  DAY_NOTES_HEADERS: ['day', 'notes', 'last_updated'],

  // Dan's in-app test notes (🗒 Notes header button, every view) — issues
  // recorded while testing, fed back to Claude for fixing
  FEEDBACK_HEADERS: ['note_key', 'created_at', 'view', 'note', 'status', 'last_updated'],

  TIMEZONE: 'Europe/London'
};

// Subset of config the frontends need. Keeps business rules single-sourced:
// the client never hardcodes team size, spray rules or stage lists.
function getClientConfig() {
  return {
    teamCount: CONFIG.WORKSHOP_TEAM.length,
    daysPerWeek: CONFIG.DAYS_PER_WEEK,
    productiveHrsPerDay: CONFIG.PRODUCTIVE_HRS_PER_DAY,
    spray: CONFIG.SPRAY,
    leadDays: CONFIG.LEAD_DAYS,
    stages: CONFIG.STAGES,
    oddJobs: CONFIG.ODD_JOBS,
    dispatchWindowDays: CONFIG.DISPATCH_WINDOW_DAYS,
    dispatchStatuses: CONFIG.DISPATCH_STATUSES,
    penaltyWindowDays: CONFIG.PENALTY_WINDOW_DAYS,
    qcIssueCategories: CONFIG.QC_ISSUE_CATEGORIES,
    workshopTeam: CONFIG.WORKSHOP_TEAM,
    stageHourWeights: CONFIG.STAGE_HOUR_WEIGHTS,
    targets: CONFIG.TARGETS,
    installDay: {
      vanSlots: CONFIG.INSTALL_DAY.vanSlots,
      dayTargetHrs: CONFIG.INSTALL_DAY.dayTargetHrs,
      dayMaxHrs: CONFIG.INSTALL_DAY.dayMaxHrs,
      crewSize: CONFIG.INSTALL_DAY.crewSize,
      paidManHrsPerWeek: CONFIG.INSTALL_DAY.paidManHrsPerWeek
    },
    bankHolidays: getBankHolidays_()
  };
}
