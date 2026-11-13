# Decision Register — implementation defaults

Status vocabulary follows spec §20.1. Every item below is **Implemented** with a default chosen for the first build; none is **Verified** until the operations owner signs it off. "Config" means an admin can change it at runtime in *Admin → Settings* without a deploy.

| ID | Question | Default implemented | Where / how to change | Status |
|---|---|---|---|---|
| DEC-001 | Live headers and column mappings | The app owns its schema (Postgres). The CSV importer maps Sheet headers by name, prints the mapping in a dry run and accepts `--mapping` overrides. Nothing is written until `--commit`. | `scripts/import-task-tracker.ts`, `src/domain/importer.ts` | Implemented |
| DEC-002 | Initial task status | `NOT_STARTED`. | `prisma/schema.prisma` default | Implemented |
| DEC-003 | Channel mandatory for every task? | Yes. `General` exists for work that has no marketplace. | `tasks.ts › validateCreate` | Implemented |
| DEC-004 | Deadline manual or policy-derived? | Always entered manually. The SLA policy is resolved and stored for traceability but does not set the deadline. | `task-core.ts › resolveSlaPolicy` | Implemented |
| DEC-005 | SLA policy registry and resolution | `SlaPolicy` table, ranked. First active policy whose priority/channel filters match wins. Seeded with `SLA-P0`, `SLA-P1P2`, `SLA-STD`. | `SlaPolicy` rows | Implemented |
| DEC-006 | Timezone, working hours, holidays, cutoff | Business TZ `Asia/Kolkata` (`BUSINESS_TZ`). Dates are compared as IST calendar dates with no intra-day cutoff. Weekends plus the `Holiday` table define working days. | env `BUSINESS_TZ`, Admin → Lists → Holidays | Implemented |
| DEC-007 | Reopened, dropped, paused, soft-deleted in KPIs | Dropped and soft-deleted tasks are excluded from all KPI cards. On-hold tasks are active and keep aging. A reopened task loses its completion credit until it is completed again; the earlier completion stays in the audit log. A task completed on its deadline counts as on time. Completed tasks are never "Overdue"; they are "Completed Late". | `sla.ts`, `metrics.ts` | Implemented |
| DEC-008 | Extension/waiver column references | Stored as `Task.extensionsCount` and `Task.waivedExtensionsCount`, reconciled against `ExtensionRequest`/`WaiverRequest` rows by the integrity report. There are no lettered columns. | Admin → Integrity | Implemented |
| DEC-009 | Authoritative audit store | `AuditEvent` table, written in the same transaction as each change. A DB trigger blocks `UPDATE`/`DELETE`. | migration `init` | Implemented |
| DEC-010 | Identity and authorization | Google OAuth (verified email, optional domain restriction). Users must be pre-provisioned and active. Role and active flag are re-read on every API call, and every operation checks the RBAC matrix on the server. | `lib/auth.ts`, `domain/rbac.ts` | Implemented |
| DEC-011 | Hard-delete retention and dependency rules | Admin only. The task must already be in the bin, the user must type its ID, give a reason and a backup reference, and nothing may still reference it (subtasks, transfers, extensions, waivers, escalations, open notifications, recurring successors, closed scorecard period). No automatic purge ever runs; `retention` config is informational. | `deletion.ts` | Implemented |
| DEC-012 | Multiple collaborators and workload | Workload counts the task owner only. Subtask owners see the parent task but are not counted. | config `workload` | Implemented |
| DEC-013 | Project/subtask lifecycle and permissions | Projects: Active → On Hold → Completed → Archived, managed by the owner or Admin/Leadership. Subtasks use the task status set; the parent owner manages them, and a subtask owner can update status and evidence only. | `projects.ts`, `subtasks.ts` | Implemented |
| DEC-014 | Audit or derived-field failure | Fail closed. The audit write is in the same transaction, so a failed audit rolls back the action. Derived fields are computed rather than stored, so they cannot fail to inherit. | `audit.ts` | Implemented |
| DEC-015 | Can Leadership perform every approval? | Yes for extensions, waivers, cancellations, transfer acceptance (override), escalation resolution and restore. No for hard delete, deadline override, admin transfer override, scorecard overrides and period close. | `rbac.ts` MATRIX | Implemented |
| DEC-016 | Escalation clock | Calendar hours. `BUSINESS` counts only hours on working days. | config `escalation.clock` | Implemented |
| DEC-017 | What counts as an L1 response | An explicit "Post update" by the task owner, a subtask owner or Admin/Leadership. L1 → L2 after 24h with no response. L2 → L3 48h after the trigger if still unresolved. | config `escalation.l2AfterHours/l3AfterHours` | Implemented |
| DEC-018 | Revenue-critical → immediate L3 | Yes, when Admin or Leadership designates it. Members cannot. | config `escalation.revenueCriticalToL3` | Implemented |
| DEC-019 | Can Leadership clear every tier? | Yes. Admin and Leadership can resolve L1–L3; members cannot. | `rbac.ts` | Implemented |
| DEC-020 | Authoritative dependency evidence | A subtask with status `COMPLETED`, a dependency type, and `completedBy`/`completedAt` recorded. An evidence link is optional. | `scorecard.ts` | Implemented |
| DEC-021 | Dependency bonus vs the 25-point category | Bonus per verified dependency is I +2, WB +3.5, E +5, capped at 25 per member per month. | `ScorePolicy` v1 | **Needs confirmation** |
| DEC-022 | 30-minute email queue | Replaced by a worker that polls every 60s (`QUEUE_POLL_SECONDS`). Apps Script is not used. | env | Implemented |
| DEC-023 | Retry and dead-letter policy | 5 attempts with backoff of 5/15/60/180 min. Invalid recipients go straight to DEAD. Admin can requeue from the queue screen. | config `notifications` | Implemented |
| DEC-024 | Secure transfer deep links | Email links only open `/tasks/:id`. The app re-authenticates, re-checks visibility, and every decision happens in-app with RBAC. | `templates.ts` | Implemented |
| DEC-025 | QA/test prefix matching | Case-insensitive on the trimmed name: `qa` or `test` followed by a separator or the end of the name (so "Testimonials" and "Quality audit" are **not** excluded). | config `exclusionGate.pattern` | Implemented |
| DEC-026 | Delivery subcomponents of "40/20" | Interpreted as +4 per on-time completion and +2 per late completion, uncapped. Discipline starts at 15, −2 per unwaived extension and −2 per inherited (pre-transfer) delay, floor 0. Under this policy a member with no activity scores 15, which matches the stated Suraj = 15.0 baseline. | `ScorePolicy` v1 | **Needs confirmation** |
| DEC-027 | Who owns Column N (Escalation Req) | System-managed. It is set by Escalate and cleared by Resolve, and is never directly editable. | `escalation.ts` | Implemented |
| DEC-028 | Metadata schema versioning | There is no free-form JSON blob: state is relational. `Task.extra` keeps imported legacy metadata verbatim. The admin "raw metadata" view emits a Column-L-shaped object with `schemaVersion: 1`. | `task-core.ts › legacyMetadataView` | Implemented |
| DEC-029 | Recurrence anchor | Set per series: original schedule (default) or completion of the previous occurrence (completion-driven only). | Series form | Implemented |
| DEC-030 | Missed-cycle policy | Set per series. The default generates only the latest cycle and records the skipped cycles as an exception. | Series form | Implemented |
| DEC-031 | Separate series record? | Yes, `RecurringSeries`. Each occurrence is a full task with `seriesId`, `occurrenceNumber`, `scheduledDate` and `clonedFromId`. | schema | Implemented |
| DEC-032 | Project completion with open tasks | Blocked by default. The owner or Admin can override with a reason. Linked tasks are never auto-completed. | config `projects` | Implemented |
| DEC-033 | Project registry location | `Project` table with IDs `PRJ-NNNN`. | schema | Implemented |
| DEC-034 | Member code registry for task IDs | `User.code` (3 letters), immutable once set. IDs use the **creator's** code: `MMM-YYMMDD-NNN`. | Admin → Team | Implemented |
| DEC-035 | Sequence counter store | `IdCounter` row per namespace and day, incremented with a row-locking upsert inside the create transaction. A rollback never burns an ID. | `ids.ts` | Implemented |
| DEC-036 | Deep-link base and resolver | `${APP_BASE_URL}/tasks/:id` redirects to the dashboard drawer, resolved by ID with a permission check. | `app/(app)/tasks/[id]` | Implemented |
| DEC-037 | Independent subtask owners and deadlines | Yes. Subtask owners are notified, can see the parent, and can edit only status and evidence. | `subtasks.ts` | Implemented |
| DEC-038 | Parent completion vs subtasks | All *required* subtasks must be complete or cancelled. Admin/Leadership can override with a reason. The parent is never auto-completed; it shows "Ready for completion" instead. | config `subtasks` | Implemented |
| DEC-039 | Restoration into a closed scorecard period | The frozen snapshot is never rewritten. Restore returns a warning, and an admin posts a `CORRECTION` adjustment, which is shown separately. | `deletion.ts`, `scorecard.ts` | Implemented |
| DEC-040 | Notification snapshot architecture | A transactional outbox replaces snapshot diffing: events are inserted in the same transaction as the change, with dedup key `EVENT:task:transitionId`. | `notifications/enqueue.ts` | Implemented |
| DEC-041 | ScriptProperties/email quotas | Not applicable (no Apps Script). SMTP provider limits apply; quota errors are classified `QUOTA` and retried. | — | Implemented |
| DEC-042 | First-run baseline and cache reset | Not needed with an outbox. Imports deliberately emit no events. | — | Implemented |
| DEC-043 | Retry, backoff and dead-letter | See DEC-023. | config | Implemented |
| DEC-044 | Digest content standard | Personal digest sections: overdue, due today, next 7 days, blocked, transfers awaiting response, approvals (privileged users only). Members with no relevant tasks get **no email**. Executive digest has the 6 sections from §39.9 and a data-as-of timestamp. Both are sent at 09:00 IST. | config `notifications.digestTime/sendEmptyPersonalDigest` | Implemented |
| DEC-045 | Legacy Sheet1 references | Out of scope for the app. The importer handles a `Sheet1` export like any other CSV; rows without metadata get new IDs, and `legacyId = ROW-n:<name>`. | importer | Open (ops audit) |
| DEC-046 | Backup location and restore authority | Postgres backups via `pg_dump` or managed snapshots; see `docs/RUNBOOK.md`. Location to be chosen by DevOps. | runbook | Open |
| DEC-047 | Who authorises production rollback | Proposed: Harsh (Admin), with Dilip Sir informed. | runbook | Open |
| DEC-048 | Reconciling post-backup updates after rollback | Audit-log replay: every change since the snapshot is in `AuditEvent` (ordered by `seq`). See runbook §Rollback. | runbook | Open |

## Other defaults not in the spec's register

- **Member creates for a peer**: the creator owns the task and a transfer request goes to the peer (§26.1, no silent assignment).
- **Members cannot drop or delete**: they file a cancellation request (drop or remove), and Admin/Leadership decide it.
- **Admin direct deadline override** needs a reason, is audited as `ADMIN_OVERRIDE_DEADLINE`, keeps `originalDeadline` and does **not** count as an extension.
- **Nobody approves their own extension or waiver**, Admin included.
- **Extensions after completion** are not allowed; reopen the task first.
- **Pre-transfer delay** (§26.2): if a task was overdue when a transfer was requested, the sender takes an "inherited delay" (−2 discipline) in the month the transfer is accepted. The recipient's delivery credit is judged against the operative deadline.
- **Status transitions** (§10.2): Not started → In progress / On hold / Completed / Dropped; In progress → On hold / Completed / Dropped; On hold → In progress / Completed / Dropped; Completed → In progress (reopen, needs a reason); Dropped → Not started / In progress (reopen, Admin/Leadership, needs a reason).
