# Change Request v2: implementation report

Brief: *Palmonas Task Tracker – Claude Implementation Brief v1.0 (12 Nov 2026)*. Status words follow the brief:

- **Specified**: the brief or the master spec asks for it.
- **Implemented**: code exists.
- **Tested**: an automated test passes.

Nothing here is claimed to be deployed.

## 1. Current-state audit (before this change)

There were two codebases.

**`palmonas-ops`: the Palmonas domain.** This was the "existing application" the brief refers to.
- Next.js 15 with Postgres/Prisma.
- Google OAuth sign-in for pre-provisioned users.
- A fixed `Role` enum (ADMIN, LEADERSHIP, MEMBER) with an RBAC operation matrix.
- Tasks, subtasks, transfers, extensions, waivers (one-to-one with an extension), cancellations and escalations (L1→L2→L3 on timers).
- Recurrence, projects and the KPI scorecard.
- A transactional email outbox and an append-only `AuditEvent` table.
- 64 tests.

**`tennis-admin` (tennis-admin-2): the dashboard design the user chose.**
- User management, email invitations (hashed single-use tokens) and custom roles with permission keys.
- A responsive UI kit and activity log.

**Decision.** At the user's request, `tennis-admin-2` became the single app.
- Its account system, UI and invitation flow were kept.
- The Palmonas domain was moved in.
- Tennis screens, models and data were removed.
- Nothing was rebuilt from scratch: the domain modules, IDs, audit and outbox carried over unchanged unless the brief required otherwise.

**Data.** No production data existed in either app; the live data is still the Google Sheet. The importer (`npm run import:sheet`) migrates that data with a dry run first. A single fresh migration (`20261113090000_init`) creates the merged schema.

## 2. Gap matrix

| § | Requirement | Before | Now | Where | Tested |
|---|---|---|---|---|---|
| 1 | Command Center, Tasks, Add Task page, Pending From, Escalations, Due Soon, Projects, Channels, Recycle Bin, KPI | Partial (drawer UI, no Add Task page, Channels or Due Soon) | Implemented | `src/app/(app)/*` | e2e |
| 1 | No "My Transfers" page; history in the task | Implemented | Implemented (transfers in task history and Approvals) | `tasks/[id]` | e2e |
| 1 | One bell | Missing | Implemented (`InAppNotification` + live push) | `AppShell`, `domain/bell.ts` | UI-028, e2e |
| 2 | Individual auth, central registry | Implemented (Google) | Google + invitations; password login optional | `lib/auth.ts` | users-roles, invitations |
| 2 | Admin/Leadership see all and default to own | Partial (saw all by default) | Implemented: `view=mine` default; `team` view needs Admin/Leadership | `domain/tasks.ts › listTasks` | UI-003 |
| 2 | Contextual, per-task access | Partial (implicit: subtask owner, pending transfer) | Implemented: `TaskAccess` (creator, previous owner, transfer, extension, waiver, escalation, collaborator, subtask), revocable | `task-core.ts › visibleWhere/grantAccess` | UI-004, UI-005 |
| 2 | Server-side enforcement on every read/list/search/notification | Implemented | Implemented; bell and live stream also filtered | `visibleWhere`, `enqueue`, `/api/live` | UI-004, UI-032 |
| 3 | Owner → Channel → Priority aggregates; drill-down only for Admin/Leadership | Missing | Implemented | `domain/command.ts` | UI-001/002/003 |
| 4 | Flag distinct from escalation; Move to Bin after Flag | Missing (flag meant escalate) | Implemented | `setFlag`, Tasks row menu | UI-026, e2e |
| 4 | Star Admin/Leadership only, never widens access | Missing | Implemented; hidden from members in every payload | `setStar`, `toDTO(viewer)` | UI-026/027 |
| 5 | Due Soon / Follow-up Soon, both reasons, configurable windows, overdue kept | Missing | Implemented (defaults 3/2 days, editable in Settings) | `dueView`, `/due` | test + e2e |
| 6 | POC Type I/WB/E; Type+Name mandatory together when pending | Partial (free-text `pendingFrom`, optional tier) | Implemented + DB `CHECK` constraint | `poc.ts › resolvePending` | UI-006/007 |
| 6 | Saved POC registry; custom POC task-scoped; L1 promotion with non-duplicate tick | Missing | Implemented, with duplicate suggestions | `poc.ts`, Pending From › POC approvals | UI-008/009/010 |
| 7 | L0 default; raiser chooses L1/L2/L3; owners Ritesh/Harsh/Dilip; reassign with reason; resolve doesn't complete the task | Conflicting (auto timers, always started at L1) | Implemented; timers removed | `escalation.ts` | UI-011/012/013 |
| 8 | No direct deadline override; extension before or after completion; KPI impact audited | Partial (blocked after completion; Admin override counted as edit) | Implemented: Admin-only *correction* with reason; post-completion `KPI_ADJUSTMENT` event | `governance.ts` | UI-015/016/017/020 |
| 9 | Waiver separate, optional, later, independently decided | Conflicting (one waiver per extension; "approve with waiver") | Implemented: own record, optional extension link, own decision | `governance.ts`, Approvals | UI-018/019, QA-045 |
| 10 | Skip/Pause need a follow-up date; feeds Due Soon | Missing | Implemented | `recurrence.ts › seriesAction` | UI-021/022 |
| 11 | Channels page like Projects; permission-filtered lists | Missing | Implemented | `/channels` | UI-034 |
| 12 | Inline Restore/Purge; purge stricter; minimal audit kept | Partial (purge blocked by any dependency) | Implemented: Admin-only, typed ID, shows what's removed; denials audited | `deletion.ts`, `/bin` | UI-023/024/025 |
| 13 | Transfer changes owner only on acceptance | Implemented | Implemented (+ previous owner keeps history access) | `governance.ts` | QA-013 |
| 14 | Critical emails, outbox, idempotency, retries, dead-letter, baseline | Implemented (outbox) | Implemented + recipient access check, subject without task details, email switch (default OFF) | `notifications/*` | UI-028–031 |
| 16 | KPI is a tracker; never edits history | Implemented | Implemented | `/kpi` | QA-020/043 |
| 17 | Progressive disclosure, inline validation, confirmations | Partial | Implemented | Add Task, ActionModal | e2e |
| 19 | Concurrency: no silent last write | Implemented (version) | Implemented; edit modal keeps your input on conflict | `versionedUpdate` | UI-033 |
| — | Live updates for all users | Missing | Implemented: Postgres NOTIFY → server-sent events → refetch | `lib/live*.ts`, `/api/live` | e2e "Live updates" |

## 3. Security threat review

- **Guessing a task URL or ID.** Every task query goes through `visibleWhere`. A task outside your access returns 404, not 403, so its existence isn't confirmed. *Tested:* UI-004.
- **Search, filters, exports and counts.** Lists apply the same filter. Filtering by another owner is refused for members. Command Center returns counts only, never titles, POCs or IDs.
  - **Residual risk:** an owner with a single active task reveals that they have one task, which the brief accepts as aggregate data.
  - **Flagged for review:** the "Due soon" count per owner can reveal timing for someone with one task.
- **Live stream.** Signals carry IDs only. Members get a task ID only for tasks they can see, and an ID-less "stats" ping otherwise. The user is re-read on every signal, so deactivation also ends the stream.
- **Notifications.** Recipients are filtered by access when an event is created. When the bell is read, a now-inaccessible task's title and link are hidden. Email subjects never contain task content. *Tested:* UI-032.
- **Escalation owners.** L1/L2/L3 can open any task while it has an active escalation, because they're allowed to reassign any escalation. They lose sight of it when it's resolved unless the escalation was assigned to them. *Tested.*
- **Privilege escalation.**
  - Role tier and permissions are checked when a role is assigned or created.
  - Only Admins set escalation levels.
  - Users can't change their own role or status.
  - The last Owner is protected.
- **Sessions.** JWT cookie with a 12h maximum. The user is re-loaded on every API call, so suspensions apply on the next request.
- **Request forgery.** Cross-origin writes are rejected (Origin check).
- **Google sign-in.** Only verified emails, plus an optional domain allow-list. The person must already have an account or a live invitation.
- **Secrets.** Secrets live only in environment variables. Render generates `NEXTAUTH_SECRET`. No secrets are in the repository.
- **Fixed during this work.** The admin settings API returned full user rows, including password hashes. It now selects safe fields only.
- **Residual risks.**
  - The local launcher uses trust auth on a localhost-only Postgres. That's fine on one Mac, and is never used for deployment.
  - Members can see the full team roster (names only) in owner pickers.

## 4. Implementation plan as executed

1. **Schema and backend.** Merged schema; `TaskAccess`, `Poc` and `InAppNotification`; role tiers; user codes and escalation levels.
2. **Security.** Central `visibleWhere`, star/flag rules, recipient filtering, live-stream filtering.
3. **Workflow.** Escalation model, independent waivers, post-completion extensions, POC promotion, skip/pause follow-ups, purge.
4. **UI only.** All pages in the tennis design system.
5. **Deployment.** Google sign-in, in-process worker, Render blueprint, Neon URLs.

## 5. Data migration plan (Google Sheet → app)

1. **Backup.** Download the Sheet as `.xlsx` and `.csv`, and keep both. In Neon, create a branch named `pre-import`.
2. **Dry run.** `npm run import:sheet -- --file tracker.csv` prints the column mapping and every row's outcome. Nothing is written.
3. **Commit.** Run the same command with `--commit`.
   - Legacy IDs are kept where valid.
   - "Pending From" text without a POC type goes into Remarks, with a warning. The importer doesn't guess types.
   - Active escalations are assigned to the current level owner.
   - No notifications are sent.
4. **Validate.** *Settings → System → Run check* recounts KPIs with SQL and compares them to the app, and checks counters and flags.
5. **Rollback.** Reset the Neon branch to `pre-import`, or restore to a point in time.

## 6. Test results (13 Nov 2026)

- **`npm test`: 101 integration tests, all passing, against real Postgres.** This includes `tests/palmonas/brief-v2.test.ts`, which covers UI-001 to UI-034 at the API/domain layer, plus the carried-over master-spec suites (QA-xxx) and the account/invitation suites.
- **`npm run e2e`: 15 browser checks, all passing.** They cover:
  - member vs Leadership Command Center;
  - URL guessing;
  - Add Task pending validation;
  - live update across two signed-in users;
  - direct L3 escalation and L1 reassignment;
  - extension + waiver decided separately;
  - star and deadline-edit refusals;
  - Move to Bin from the list (Flag before Move to Bin) and inline restore;
  - purge refused for Leadership;
  - Due Soon reasons, and pause needing a date;
  - phone layout with no horizontal scroll.
- **Not tested here:**
  - real Google OAuth (needs your client ID);
  - real SMTP delivery;
  - Render/Neon in production;
  - the launcher on your Apple Silicon Mac. It was tested on Linux; the Mac build uses the same scripts with darwin-arm64 binaries.

## 7. Email

See [NOTIFICATIONS.md](NOTIFICATIONS.md): the matrix, recipients, sample emails, engineering and open questions. Email stays OFF until approved.

## 8. Deployment-readiness checklist

- [ ] Neon project created; `DATABASE_URL` and `DIRECT_URL` set.
- [ ] Google OAuth client created; redirect URI matches the Render address.
- [ ] Render service on an always-on plan; `SEED_OWNER_EMAIL` = your Google email.
- [ ] `PASSWORD_LOGIN=false` once Google works (the blueprint default).
- [ ] `ALLOWED_EMAIL_DOMAINS` set if everyone uses company email.
- [ ] Team invited; Harsh = Admin, Dilip = Leadership; L1/L2/L3 set.
- [ ] Notification matrix approved → SMTP set → email switched on.
- [ ] Due Soon windows confirmed (Settings → Workflow).
- [ ] KPI weights confirmed (DEC-021/026), including how post-completion extensions apply to closed months.
- [ ] Sheet imported via dry run, then commit; integrity check clean.
- [ ] Neon branch taken before go-live.

## 9. Decision log

### Assumptions made

| # | Assumption | Why | Change via |
|---|---|---|---|
| A1 | Harsh = Admin, Dilip = Leadership, Ritesh = Team member + L1 | Master spec + brief §2/§7 | Team page |
| A2 | Flag = a personal "needs attention" marker (owner, Admin or Leadership), separate from escalation. The old app used "flag" to mean escalate. | Brief §4 says keep them distinct if ambiguous | Confirm |
| A3 | Members can't bin, drop or purge. "Move to Bin" on their rows files a removal request for Admin/Leadership. | Brief §12 "keep governance"; master DEC | Confirm |
| A4 | Only Admin may *correct* a deadline (typo fix, with reason, audited as `DEADLINE_CORRECTED`, not an extension). Leadership can't. | Brief §8 allows an "authorized correction workflow" | Confirm |
| A5 | Escalation owners and Admin can reassign and resolve. Anyone involved can post an update. | Brief §7.5–7.6 | Confirm |
| A6 | Approvers for extensions and waivers: Admin + Leadership, never one's own request | Master DEC-015 | Confirm |
| A7 | A post-completion extension approval keeps status and completion time, moves the deadline, and logs a `KPI_ADJUSTMENT` (before/after timeliness). For a closed KPI month, the frozen score is untouched and an Admin posts a correction. | Brief §8 "auditable adjustment"; no formula invented | Confirm |
| A8 | A standalone waiver (no extension) is recorded and decided, but its score effect isn't defined in the current policy | Brief §9, §16: don't invent formulas | **Needs policy** |
| A9 | Due Soon: deadline within 3 days, follow-up within 2 days | Brief §5 asks for configurable windows | Settings |
| A10 | Pausing doesn't auto-resume on the resume date; the date appears in Due Soon | Brief §10 asks for a next-action date only | Confirm |
| A11 | Subtask owners get access to the parent task (scoped) | Master spec DEC-037 | — |
| A12 | Escalation owners can open escalated tasks while the escalation is active | Needed to reassign any escalation | Confirm |
| A13 | Hosting: Render (Starter) + Neon free + Google sign-in + Gmail SMTP | User choice, 13 Nov | — |

### Open questions (from brief §22 and §5)

1. Which emails should copy Admin/Leadership (NOTIFICATIONS.md §5)?
2. KPI formula for approved extensions and for standalone waivers (A7, A8).
3. Can members create tasks for others? Currently they create a transfer request the other person must accept (master spec §26.1).
4. Are multiple pending extension requests per task needed? Currently one at a time; history is kept.
5. Due Soon windows (A9).

### Superseded master-spec decisions

- **DEC-016, DEC-017, DEC-018** (automatic escalation timers; revenue-critical → L3): replaced by brief §7. Levels are chosen and reassigned by people.
- **DEC-019** (Leadership resolves every tier): now the escalation owners plus Admin.
- **DEC-010** (Google login for pre-provisioned users): extended with invitations, so Google sign-in also accepts a live invite.
