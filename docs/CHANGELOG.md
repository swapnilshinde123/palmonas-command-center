# Changelog

## 2026-11-14 — Feedback PDF "command center 3", Phase 1 + core of Phases 3–5

Defaults chosen for the audit's open questions are marked (Q#).

- Invitations: Google sign-in now marks the matching invitation Accepted and records `lastSignInAt`; User management shows Active.
- Requests: one pending removal per task; same-date extension blocked, different dates allowed; deciding one extension (or removal) closes the other pending ones (Q10: approve or reject); one pending transfer at a time; duplicate waivers blocked.
- Task panel: ⋯ menu removed; star, flag, copy ID, edit and bin are direct icons. Single status dropdown: To do, In progress, On hold, For review, Completed. Existing Dropped tasks stay read-only (Q4).
- For review: owner picks a reviewer (defaults to creator, team leader, project leader); reviewer accepts, sends back or passes it on; credit dated to the first submission; full review log kept.
- Subtasks (one level), cross-owner subtasks shown as dependencies on Pending From and clear when done.
- Projects: required project leader with team-leader rights on that project's tasks; status set aligned to tasks; pending-approval and escalation badges.
- Personal stars for everyone + Starred view with "Starred by" filter for Admin/Leadership/team leaders.
- Output link and Leadership comments on tasks.
- Ageing column (calendar hours, Q22); pending-request badges on every task row.
- Navigation: Recurring right below My Tasks in all portals; Leadership/Team toggle; Admin portal moved to the user menu; Recycle Bin for everyone (own tasks).
- Bin: owners bin and restore their own tasks; permanent delete needs Admin approval and writes a tombstone with pre-delete KPI snapshot.
- Overview: "Your work" and "Team" sections with identical tiles. Due Soon: overdue/today/tomorrow/this week (Mon–Sun IST, Q23)/this month tiles plus full list by due date.
- Escalation owners card in Settings; clearer error.
- Pending From: Internal picks a team member; new WB/External POCs reviewed by Admin or team leader with duplicate check, fix-and-approve or map-to-existing.
- KPI: Delivery 80 + Discipline 20 (normalised); recurring and parent-with-subtasks excluded; credit to owner at completion; late-completion waivers; policy editable by Admin with validation, preview, confirmation and version history; members see metrics but no points (UI only — server enforcement is Phase 2); month-on-month table with CSV export; channel scorecard.
- Recurring: members create their own series; frequency-dependent fields; Flexible cadence (next date = follow-up entered when done); tick-to-complete; dashboard for Admin/Leadership.
- Email: review requested / accepted / sent back.

Not yet done (Phase 2 server enforcement): server-side permission checks, server timestamps, backend KPI point hiding, purge rollback UI, historical recalculation snapshots.

## 2026-11-14 — Second pass on the same PDF: server enforcement and the remaining items

- Server (`web/policy.js`): every task write is checked against the same roles and permissions the page uses. Members only receive the tasks they may see; deadlines change only through an approved extension; ownership only through an accepted transfer or Assign permission; requests can't be self-approved, edited or deleted; duplicates are refused; history is append-only (a stale write gets a 409); stars are personal; comments are append-only and limited to Admin/Leadership/team leaders/project leaders; all times (created, decided, completed, reviewed, escalation raised/resolved) are stamped by the server.
- KPI points are stripped on the server for anyone without "See KPI points" (config policy, closed-month rows, deduction records).
- Permanent delete: Admin only, task must be in the Bin, server keeps a tombstone; "Bring back" restores it and rolls back the recalculation it caused. Closed KPI months touched by a purge are recalculated with the old numbers kept.
- KPI policy: missed-recurring deduction (default 0), custom discipline categories recorded by Admin per person and month, optional historical recalculation with preview, reason, double confirmation and rollback.
- Recurring occurrences are created by a server job every 15 minutes (same IDs as the page).
- Analytics page for Admin/Leadership/team leaders: delivery trend, owner scorecard, pending dependencies and their ageing, dependency-related delays, repeated blockers, cross-owner subtasks, team bottlenecks, channel patterns, escalations. Admin chooses which sections show.
- Pending From can be changed by anyone involved in the task. KPI dependency counts include cross-owner subtasks (reporting only).
- A newly created task now opens straight after saving.
