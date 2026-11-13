# Put it online (no domain needed)

The result is a free web address like `https://palmonas-ops.onrender.com`. Every team member signs in with their own Google account, on any phone or laptop. Changes show up on everyone's screen within about a second.

| Piece | Service | Cost |
|---|---|---|
| Database | **Neon** Postgres (free plan) | $0 |
| App server, always on | **Render** web service, *Starter* plan | Small monthly fee (check render.com/pricing). The free plan sleeps after 15 min idle, which breaks live updates and background email. |
| Sign-in | Google OAuth | $0 |
| Email | Your Google Workspace / Gmail SMTP with an App Password | $0 |

You need about 30 minutes, the project in a GitHub repository, and your Google account.

## 1. Database: Neon

1. Sign up at **neon.tech** with Google. Create a project named `palmonas`. Pick region **Asia Pacific (Singapore)**.
2. On the project dashboard, click **Connect**. Copy two connection strings:
   - **Pooled connection**: the host contains `-pooler`. This becomes `DATABASE_URL`.
   - **Direct connection**: turn "Connection pooling" off. This becomes `DIRECT_URL`.

## 2. Google sign-in

1. Go to **console.cloud.google.com** and create a project called `Palmonas Ops`.
2. Open **APIs & Services → OAuth consent screen**. Choose **Internal** if you use Google Workspace; otherwise **External**, and add your team as test users. App name: Palmonas Ops.
3. Open **Credentials → Create credentials → OAuth client ID**:
   - Type: **Web application**.
   - Authorized redirect URI: `https://palmonas-ops.onrender.com/api/auth/callback/google`. Use your real Render address once you know it; you can edit this later.
4. Copy the **Client ID** and **Client secret**.

## 3. App: Render

1. Push this folder to a private GitHub repository.
2. At **render.com**, choose **New → Blueprint**. Pick the repository; Render reads `render.yaml`.
3. Fill in the values it asks for:
   - `DATABASE_URL`, `DIRECT_URL`: from Neon.
   - `NEXTAUTH_URL` and `APP_BASE_URL`: `https://palmonas-ops.onrender.com` (your service address).
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: from step 2.
   - `ALLOWED_EMAIL_DOMAINS`: your company domain (for example `palmonas.com`), or leave it empty.
   - `SEED_OWNER_EMAIL`: **your own Google email**. This becomes the first Owner.
   - `SEED_OWNER_NAME`: your name.
   - SMTP fields: leave empty for now.
4. Click **Apply**. The first deploy takes a few minutes. It creates the tables, roles, channels and your Owner account. It never adds demo data.
5. Open the address and click **Continue with Google**.

## 4. Set up the team

1. Go to **Team → Invitations** and invite each person's work email. Pick their role:
   - **Harsh**: Admin.
   - **Dilip**: Leadership.
   - **Everyone else**: Team member.
2. Each person opens the email link, or just goes to the site, and clicks **Continue with Google**. Only invited emails get in.
3. Go to **Team members → Edit** and set the escalation owners: **Ritesh = L1**, **Harsh = L2**, **Dilip = L3**. Only an Admin can set these.
4. **Optional:** import the current Google Sheet. Export it to CSV, then run `npm run import:sheet -- --file tracker.csv` (dry run). Run it again with `--commit` to write. Imports never send notifications.

## 5. Email (when the notification list is approved)

1. In your Google account, create an **App Password** (Security → 2-Step Verification → App passwords).
2. In Render, set these and redeploy:
   - `SMTP_HOST=smtp.gmail.com`
   - `SMTP_PORT=587`
   - `SMTP_USER=<the sending address>`
   - `SMTP_PASSWORD=<the app password>`
   - `SMTP_FROM="Palmonas Ops <that address>"`
3. In the app, go to **Settings → Notifications → Turn on email delivery**. Only new events are emailed.

## 6. Backups and rollback

- **Neon:** point-in-time restore is included for the free plan's history window. Before a risky change (such as a big import or a purge), create a **branch** in Neon. A branch is an instant copy.
- **Render:** to roll back, use **Rollback** on a previous deploy. Database migrations only add things; the first migration creates everything.

## Running locally

On a Mac, `./run-local.sh` downloads its own Node and Postgres into `.local` (no Homebrew needed). Then it opens `http://localhost:3000` with demo data:

- `owner@example.com` / `ChangeMe123`
- Demo team accounts such as `harsh@example.com` and `pragati@example.com`, all with password `Password123`

Local mode is for trying it out. Real multi-device use is the Render address.
