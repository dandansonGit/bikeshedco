# The Bike Shed Company — internal apps

Index of the Google Apps Script apps, what each one is, and which spreadsheet
it writes. **Start here before changing anything** — several apps have similar
names and two of them are production trackers, which is a genuine trap.

Last verified: 2026-08-27. Every ID below was read from the live project or
spreadsheet on that date, not from memory.

---

## The two live production apps

These overlap. Both are production trackers. **They share no state** — a tick
in one is invisible to the other.

### 1. BSC Live Jobs Tracker — REVCAP-fed
The one Dan and Steve use daily.

| | |
|---|---|
| Script ID | `1a7lIjP7wbANshiHihuj0GSt3PIC8tnd17a4y2L4U7nWRBel_2Ifr1dn5` |
| Live URL | `.../s/AKfycbxeSb1NB7JKxqbNw4KUAMlwhLpu8xmXbrPa_36oik4C-1FEurCei73V3CGKbp8D7dIV/exec` |
| HEAD URL | `.../s/AKfycbzhmQ2UCi_4wXSEA160hERZX0HQ6bVY7mHEEtor-0Y/exec` (testing) |
| Files | `Code.gs`, `Index.html` (this repo) |
| State sheet | **BSC_JobTracker_State** — `1ckWXJkStag_M_6jQ8kBtDiDJBS0QDT-POQNUzH307WQ` |
| Data source | REVCAP `.xlsm`, dropped in by hand |
| Stages | 8 — Cut, Framed, Sprayed, Lid, Assembled, Ready, Dispatched (+ odd jobs) |
| Users | Dan, Steve |

Tabs in its spreadsheet:

| Tab | Contents |
|---|---|
| `BSC_JobTracker_State` | Job ID, State JSON, Last Updated, **Updated By** — the ticks |
| `BSC_JobTracker_Snapshot` | Job-list snapshot, used for change detection |
| `Sheet1` | Empty, ignore |

**The job list is not persistent.** `allJobs` is only populated by dropping the
REVCAP file (or the unused HubSpot loader). Until then the page reads
"Fetching live projects from HubSpot" — a misleading placeholder, not a hang —
and there is no job list and no toolbar, so nothing can be ticked.

### 2. BSC Production Hub — HubSpot-fed
Six views in one project, routed by `?view=`.

| | |
|---|---|
| Script ID | `1QocduDGGpH__j0UF7sSCO_fwRlVhmSxigOnglEouqvLK1QCwRrNfgoXS` |
| Views | `?view=` `tracker` (default), `scheduler`, `dispatch`, `installer`, `reports`, `daysheets` |
| State sheet | **BSC_ProdTracker_State** — `18lzIOtecDi4HlOSnq05Oi9BTFUaNF07sGoZZVsD6tDQ` |
| Data source | HubSpot — Sheds custom object `0-162`, per shed |
| Stages | 10 — Cut, Framed, Component Prep, QC1, Spray Prep, Sprayed, QC2, Assembled, QC3, Dispatched |
| Backups | Nightly copies, `BSC_ProdTracker_State backup YYYY-MM-DD` |

One deployment per audience; each URL just carries a different `view` param.
Its `HANDOVER.html` holds further architecture notes.

---

## Supporting apps

| App | Script ID | Notes |
|---|---|---|
| BSC Bespoke Calculator | `1sxwX0DjRWifsqsqO6S4CE-pA-TQmVPAv69pSajCb-aWmXS_gfs9vvFko` | Data in `BSC Bespoke Calculator Data` (`1ph6OHXPryp2n-8tJ6c-Dj4yQyTe1SqRWaGxDAaAjXvk`) |
| Route Planner | `1U4s0dzg0kc5Rjj6kMW33gjeiLRqafwclkhGA63BV4DOUsdSGRprQ-6Xl` | `.../s/AKfycbx-qWV7LRm05eHZosUlc7s2JwOtXXOK0Cw887ko_OG52C6JmU3V-vQGGwkT8icXg5Bz/exec`. The Live Jobs Tracker links to it and syncs jobs |

## Probably superseded — verify before deleting

Both predate the Production Hub (created 2026-07-13) and both write
`BSC_ProdTracker_State`, so the Hub cannot be distinguished from them by
looking at the sheet. Confirm nobody still opens them first.

| App | Script ID | Last modified | Superseded by |
|---|---|---|---|
| BSC Production Scheduler | `1hyGoLLeKDJDuJ2wh9C8QHLgQdKhuwMJtHbgmAl9e5QpHDtmXz4p6Kvui` | 2026-07-06 | Hub `?view=scheduler` |
| HS_Tracker | `1NcvmmXrNQWj3Wm1G7Ns0PT00uFz--XasF4qbCVqNxuil2mvAF_taRMH_` (unverified) | 2026-06-26 | Hub `?view=tracker` |

---

## Deploying

**Pushing alone changes nothing for users.** Each live URL is pinned to a
version and keeps serving the old code until you redeploy.

```
clasp push -f
clasp redeploy <deploymentId> -d "vN - what changed"
```

Or in the editor: **Deploy → Manage deployments → pencil → Version: New
version → Deploy**. Use the *pencil on the existing deployment* — creating a
new deployment mints a different URL and leaves everyone on the old code.

Bump the version in the `<footer>` of `Index.html` in the same change.

---

## Things that have already caught us

**Two trackers, two sheets.** "Is the ticking being recorded?" has two
different answers depending on which app the person uses. Establish that
first. `Code.gs` in each project carries a header block naming its own script
ID and state sheet, so whichever file you have open tells you where you are.

**Reading a big sheet through an API truncates it.** A read of
`BSC_JobTracker_State` returned 831 of 968 rows with no error. Rows are stored
in insertion order, so the truncation silently removed the *newest* ticks and
made a working app look dead for three weeks. Always cross-check the row count
against `getLastRow()`; export as `.xlsx` and parse that when you need all of it.

**The sheet is not in timestamp order.** Rows sit where the job was first
created and are updated in place, so the newest tick is rarely at the bottom.
Sort by `Last Updated` before concluding anything.

**`Updated By` is last-writer-wins.** One value per row: whoever saved it most
recently. If two people tick the same job, the second overwrites the first —
by design, not a fault. It answers "who touched this last", not "everyone who
ever touched it". An append-only log would be needed for real history.

**A version number in the UI settles "is he on old code?" in seconds.**
Diagnosing that by inference took most of an afternoon.

**Apps Script scopes.** `Session.getActiveUser()` throws outright without the
`userinfo.email` scope, so anything calling it must be guarded or it takes the
whole save down with it. Adding such a call needs a re-authorisation (run any
function in the editor, accept the prompt) *before* redeploying.

**Docs going stale costs real time.** A `CLAUDE.md` section describing the
Production Tracker as a standalone script — true once, wrong after it moved
into the Hub — sent a whole investigation down the wrong path. When a fact
here changes, change it in the same commit as the code.
