# Palmonas Command Center

Marketplace operations task tracker for the Palmonas team. It tracks task status, ownership, deadlines, Pending From (POC dependencies), escalations, extension and waiver approvals, recurring work, projects, channels and a KPI scoreboard. It also covers team management, Google sign-in and invitations.

It is multi-user: everyone signs in with their own account from their own device, and changes appear on everyone's screen within about a second.

**Stack:**

- Next.js 15 (App Router, TypeScript) and Tailwind.
- Postgres 16 via Prisma.
- Auth.js with Google sign-in, plus optional password login.
- Server-sent events driven by Postgres `LISTEN/NOTIFY` for live updates.
- Nodemailer outbox for email.

## Run it on a Mac

```bash
./run-local.sh
```

No Homebrew or admin password is needed. The script downloads Node 22 and a self-contained Postgres 16 into `.local`, then loads demo data and opens http://localhost:3000.

| Sign in as | Password | Role |
|---|---|---|
| owner@example.com | ChangeMe123 | Owner |
| harsh@example.com | Password123 | Admin, L2 escalation owner |
| dilip@example.com | Password123 | Leadership, L3 escalation owner |
| ritesh@example.com | Password123 | Team member, L1 escalation owner |
| pragati@ · pratham@ · riya@ · suraj@ · yogesh@example.com | Password123 | Team members |

Try two browsers side by side, for example Dilip and Pragati, to see live updates.

## Put it online for the team

See **[docs/DEPLOY.md](docs/DEPLOY.md)**: Render (always-on web service) + Neon (free Postgres) + Google sign-in. No domain needed; you get a `*.onrender.com` address.

## What's where

| Page | For |
|---|---|
| Command Center | Everyone. Your counters, then team counts by Owner → Channel → Priority. Admin/Leadership can click through to the tasks. |
| My Tasks | Your tasks by default. *Shared with me* shows tasks you're involved in; *All team* is for Admin/Leadership. Row menu: Open, Flag, Move to Bin, Star. |
| Add Task | A dedicated create page. Pending From appears only when ticked; then POC Type and POC Name are required. |
| Due Soon | Approaching deadlines and follow-up dates, with the reason shown. Overdue tasks stay listed. Includes recurring skip/pause follow-ups. |
| Pending From | Internal / Within Brand / External: who we're waiting on. L1 approves custom POCs into the saved list here. |
| Escalations | Active L1/L2/L3 escalations, kept separate from Pending From. Owners reassign and resolve them here. |
| Approvals | Transfers, extension requests, waiver requests (each decided on its own) and drop/remove requests. |
| Projects, Channels | Grouping views. Counts cover the team; lists show only tasks you can open. |
| Recurring | Repeating tasks. Skip and Pause require a follow-up date. |
| KPI Scoreboard | Monthly scores from approved extensions and waivers. Close a month to freeze it. |
| Recycle Bin | Admin/Leadership. Restore inline; Purge is Admin only, with a typed confirmation. |
| Team, Invitations, Roles, Settings, Activity, Email outbox | Administration. |

## Security model (enforced on the server)

- **Who sees which tasks:** Admin and Leadership see every task. Team members see tasks they own, plus tasks they have a recorded, per-task relationship with: creator, previous owner, transfer, extension/waiver requester, escalation, subtask owner, or shared by the owner.
  - That relationship never reveals the owner's other tasks, and it can be revoked.
  - Lists, search, task URLs, the bell, emails and the live stream all apply the same rule.
- **Counts:** Command Center shows team counts to everyone, but never task content. Drill-down needs Admin or Leadership.
- **Role changes:** role, tier and active status are re-read on every request, so a change applies immediately.
- **Restricted actions:**
  - Deadlines change only through an approved extension. An Admin can make an audited correction.
  - Only Admin/Leadership can star tasks. Only Admin can purge.
  - Every change is written to an append-only audit trail in the same transaction.

More detail:

- [docs/CHANGE-REQUEST-V2.md](docs/CHANGE-REQUEST-V2.md): audit, gap matrix, threat review, test results and decision log.
- [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md): email proposal. Email is off until it's approved.
- [docs/DECISIONS-master-v3.md](docs/DECISIONS-master-v3.md): earlier decisions from the master spec. Superseded items are listed in the change-request doc.

## Development

```bash
cp .env.example .env            # point DATABASE_URL / DIRECT_URL at a local Postgres
npm ci
npx prisma migrate deploy
SEED_SAMPLE=true npm run db:seed
npm run dev

createdb palmonas_test && npm test    # 101 integration tests, including UI-001 to UI-034
npm run e2e                           # 15 browser checks against a running app with demo data
npm run import:sheet -- --file tracker.csv [--commit]   # Google Sheet export → tasks (dry run first)
```
