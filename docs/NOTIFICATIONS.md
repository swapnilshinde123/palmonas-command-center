# Notifications: proposal for approval

Brief §14 and Addendum A. **Status: implemented behind a switch.** Email delivery is **OFF** until this page is approved, and an Admin turns it on in *Settings → Notifications*. Bell (in-app) notifications are always on.

## 1. What the Apps Script iterations taught us

- **Earlier versions:** `Palmonas_Real_Time_Action_Alerts.gs` sent one email per action (escalation, incoming transfer, waiver request, decision). It used ScriptProperties to avoid duplicates.
- **Later version:** the consolidated polling engine (`email triggers.txt`) diffed a 30-minute sheet snapshot to catch priority, deadline and owner changes. It set a first-run baseline so history wasn't mass-mailed, and normalised owner names so `RITESH`/`Ritesh` and `Prathamesh`/`Pratham` matched.
- **Personal digests:** a daily focus email per person with urgent, upcoming and pending sections, and no email when there's nothing to say.

**What we kept:**

- Clear subjects.
- Before/after values.
- Who acted, and a link back to the task.
- No duplicates.
- No first-run flood.
- Normalised identity.
- An "empty means no email" rule for digests.

**What we did not carry over:**

- The 30-minute polling.
- ScriptProperties.
- Sheet URLs.
- Display-name identity.
- Fixed Harsh/Dilip escalation recipients.
- The combined extension + waiver decision.

## 2. Event → channel matrix (proposed)

| Event | Bell | Email | Recipients | Action needed |
|---|:-:|:-:|---|---|
| Task assigned to someone else at creation | ✔ | ✔ | New owner | Start work |
| Owner changed (transfer accepted or Admin override) | ✔ | ✔ | New owner. Previous owner and requester get the bell entry "Transfer decided" | Start work |
| Transfer requested | ✔ | ✔ | Proposed new owner | Accept/reject in Approvals |
| Priority changed | ✔ | ✔ | Task owner, plus Admin + Leadership (copy) | Re-plan |
| Deadline changed (approved extension or Admin correction only) | ✔ | ✔ | Task owner | — |
| Extension requested | ✔ | ✔ | Admin + Leadership (approvers) | Decide |
| Extension decided | ✔ | ✔ | Requester + owner | — |
| Waiver requested (separate event) | ✔ | ✔ | Admin + Leadership | Decide |
| Waiver decided (separate event) | ✔ | ✔ | Requester + owner | — |
| Escalation raised | ✔ | ✔ | The chosen L1/L2/L3 owner + task owner | Intervene |
| Escalation reassigned | ✔ | ✔ | New level owner, previous assignee, task owner | Intervene |
| Escalation resolved | ✔ | — | Task owner + raiser | — |
| Status changed by someone else | ✔ | — | Task owner | — |
| Pending From / follow-up date changed by someone else | ✔ | — | Task owner | — |
| Task starred / unstarred | ✔ | — | Admin + Leadership only | — |
| Moved to Bin / restored | ✔ | — | Task owner | — |
| Custom POC sent for registry approval | ✔ | — | L1 | Approve with the non-duplicate tick |
| POC approval decided | ✔ | — | Requester | — |
| Drop/remove request | ✔ | — | Admin + Leadership | Decide |
| Recurring series exception | ✔ | — | Admins | Fix the series |
| Daily focus digest (09:00 IST) | — | ✔ (separate switch, off) | Each person, own work only | — |

**Rules that apply to every row:**

- **The actor is never notified of their own action.**
- **Recipients are re-checked against task access before anything is created.** Someone who can't open the task gets nothing.
- **The bell re-checks access when it's read.** If access was revoked later, the entry loses its link and title.

## 3. Sample emails

The subject carries the event and task ID only. Task titles and remarks never appear in subjects or previews, so they don't show on lock screens or in shared inboxes.

```
Subject: [Palmonas] Priority changed · HSH-261113-004
Body:    Priority P2 → P1: Myntra size-chart corrections (42 styles)
         by Harsh · reason: Festive launch moved up
         [Open HSH-261113-004]   (link re-checks sign-in and access)

Subject: [Palmonas] Escalation raised · YOG-261113-001
Body:    [L2] Escalated by Yogesh: Resolve suppressed hero SKUs on Amazon
         Assigned to Harsh · P0 · due 12 Nov
         Reason: Amazon hasn't responded to the suppression case for 3 days

Subject: [Palmonas] Extension request · RIY-261113-004
Body:    Current 11 Nov → requested 17 Nov (+6d), by Riya
         Reason: Waiting on revised size data from brand team
         KPI impact if approved: −2 discipline points unless a waiver is approved
         (A waiver request was raised too; it's decided separately.)
```

## 4. Engineering

- **Outbox:** `NotificationEvent` rows are written in the same database transaction as the change, so an email exists only if the change committed.
- **Idempotency:** a unique key on `(dedupKey = EVENT:task:transitionId, recipient)` means retries and double clicks can't create a second email.
- **Worker:** the worker claims rows with `FOR UPDATE SKIP LOCKED`. It retries up to 5 times, with backoff of 5, 15, 60 and 180 minutes.
  - Permanent failures, such as a bad address, go to `DEAD`.
  - One failure never blocks the rest of the batch.
  - Failed and dead emails are listed in *Settings → Notifications* with a retry button.
- **Delivery switch:** while email delivery is OFF, events are stored as `SKIPPED (EMAIL_OFF)`. Turning email on later sends only new events: no backlog and no first-run flood. Every on/off change is audited.
- **Identity:** recipients are resolved server-side from user IDs. Email addresses never reach the browser except on the Team page, for people allowed to see it.
- **Timing:** this is not "real-time email". The worker runs inside the web process every 60 seconds (`QUEUE_POLL_SECONDS`).
- **Bell and screens:** these are pushed live. Postgres `NOTIFY` feeds a server-sent-events stream, and browsers refresh within about a second.

## 5. Decisions needed

1. Approve the matrix above, especially whether priority changes should copy Admin + Leadership.
2. Should escalation emails also copy L3 (Dilip) when L1 or L2 is chosen? Currently they don't.
3. Turn on the daily focus digest? It's built, and off.
4. The sender address and the Workspace account for SMTP.
