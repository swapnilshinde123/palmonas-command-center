# Palmonas Command Center (web)

The same app as the claude.ai page, running on its own server: tasks, approvals, escalations, projects, recurring work, KPIs, three portals (Admin, Leadership, Team), roles and per-person permissions, and live updates for everyone.

## Deploy (Render)

1. Open `https://render.com/deploy?repo=https://github.com/swapnilshinde123/palmonas-command-center` and sign in to Render with GitHub.
2. Click **Apply**. Render creates the database and the web service from `render.yaml`.
3. When the deploy finishes, open the service address (`https://palmonas-command-center-xxxx.onrender.com`).
4. In Render, open the service, then **Environment**, and copy **SETUP_CODE**.
5. Sign in: pick your name, choose a PIN, and enter the setup code. Share the setup code privately with each teammate for their first sign-in.

Free plan limits: the web service sleeps after 15 minutes without visitors (the first visit then takes about a minute), and Render deletes free databases 30 days after creation unless you upgrade them. Upgrade the database to a paid plan before then to keep your data.

## Run locally

```bash
cd web
npm ci
SETUP_CODE=choose-a-code npm start   # http://localhost:3000, data in web/.data/store.json
```
With `DATABASE_URL` set, data goes to Postgres instead.

## How it's built

- `server.js`: Node HTTP server. Stores documents in Postgres, serves the page, sends live updates (server-sent events), and checks PINs.
- `public/index.html`: built by `node build.mjs` from `docs/online-version/palmonas-command-center.html` plus `shim.js`.
- `seed/initial-data.json`: loaded into an empty database on first start.

## Security

- PINs are hashed with scrypt on the server; sessions are HttpOnly, SameSite=Strict cookies that last 30 days.
- 5 wrong PINs lock that person out for 60 seconds.
- Creating a first PIN needs the workspace setup code.
- Roles, settings, invitations and KPI closing can only be changed by Admins; any signed-in person can update tasks, projects and recurring series.
- Who-sees-which-task is applied in the page. Every signed-in person's browser receives all task data, so don't store anything that must stay hidden from teammates.
