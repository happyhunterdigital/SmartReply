# Setup

Everything you need to get SmartReply running end to end, in one place: hosting, the domain, environment variables, and the Meta app. Read it in order. The code deploys in minutes. The Meta side is the part that takes real time, so budget an afternoon the first time.

If you would rather have an AI assistant drive most of this, skip to [Set it up with an AI assistant](#set-it-up-with-an-ai-assistant) at the end and come back here when it asks for specifics.

## How it is built

SmartReply is two processes and two datastores.

- Web app and API: Next.js. Serves the dashboard, the OAuth callback, and the incoming webhook. Runs on Firebase App Hosting (see `apphosting.yaml`).
- Worker: a long-running Node process (`npm run worker`) that consumes the send queue and runs the polling reconciler. It has to stay always-on with CPU allocated, so it runs on Cloud Run (see `Dockerfile.worker`), not on a serverless web host.
- PostgreSQL: campaigns, logs, accounts, sessions.
- Redis: the BullMQ send queue and the per-account rate limiter.

The web app and the worker must share the same `DATABASE_URL`, the same `REDIS_URL`, and the same `ENCRYPTION_KEY`. The web app writes an encrypted Instagram token; the worker decrypts it to send. Different keys mean every send fails to decrypt.

## What you need first

- A Facebook account. Meta developer registration is built on it. There is no Instagram-only path.
- An Instagram Business or Creator account. A personal account cannot be connected. Switch it in the Instagram app under Settings, Account type, if needed.
- A [Resend](https://resend.com) account for login emails, with a verified sender domain. Login is email magic links only, so without this nobody can sign in.
- A Google Cloud project with the Firebase App Hosting and Cloud Run APIs enabled, to host the web app and the worker.
- A managed PostgreSQL and a managed Redis (any provider; see Step 1).
- The Firebase CLI and the `gcloud` CLI installed locally.

## Hosting and your domain

This fork is configured for `https://smartreply.happyhunterdigital.com` (set as `NEXTAUTH_URL` in `apphosting.yaml`), and everything else points at it: the Meta OAuth redirect and the Meta webhook callback must use this same domain. On first deploy, Firebase App Hosting also assigns its own default URL; you can use that instead, but then update all three values (`NEXTAUTH_URL`, the Meta OAuth redirect, and the Meta webhook callback) to match.

Recommended split:

- Web app: Firebase App Hosting.
- Worker: Cloud Run.
- PostgreSQL + Redis: any managed provider. `docker-compose.yml` runs both locally for development.

Do the datastores first, because both processes need their connection URLs.

### Step 1: PostgreSQL and Redis

Create a managed Postgres and a managed Redis, and note one connection string for each. Both processes use the same URLs, so there is no internal/public split to worry about as long as the datastore is reachable from Google Cloud (or you allow the public endpoint).

- Redis must speak the native Redis protocol over TCP. An HTTP-only Redis (some serverless Redis HTTP gateways) will not work with BullMQ.

### Step 2: Migrate the production database

Run once from your machine, using the production Postgres URL:

```bash
DATABASE_URL="postgresql://..." npm run db:migrate
```

### Step 3: Firebase App Hosting (web app, and your domain)

1. Install and sign in to the Firebase CLI: `firebase login`.
2. Review `apphosting.yaml` (already in the repo). It pins `runtime: nodejs22`, `minInstances: 1` (so the Meta webhook answers fast), and declares the non-secret env vars: `NEXTAUTH_URL`, `META_GRAPH_API_VERSION`, `EMAIL_FROM`.
3. After the first deploy, set `NEXTAUTH_URL` in `apphosting.yaml` to your App Hosting domain (or custom domain).
4. Create every secret with the Firebase CLI. They are stored in Secret Manager and injected as env vars at runtime, never committed:

   ```bash
   firebase apphosting:secrets:set NEXTAUTH_SECRET
   firebase apphosting:secrets:set CRON_SECRET
   firebase apphosting:secrets:set ENCRYPTION_KEY
   firebase apphosting:secrets:set DATABASE_URL
   firebase apphosting:secrets:set REDIS_URL
   firebase apphosting:secrets:set RESEND_API_KEY
   firebase apphosting:secrets:set INSTAGRAM_APP_ID
   firebase apphosting:secrets:set INSTAGRAM_APP_SECRET
   firebase apphosting:secrets:set FACEBOOK_APP_SECRET
   firebase apphosting:secrets:set WEBHOOK_VERIFY_TOKEN
   ```

   `ENCRYPTION_KEY` must be exactly the same value you use on the worker.
5. Deploy: `firebase deploy --only hosting`. The build runs `npm run build`, which is `prisma generate && next build`.
6. `EMAIL_FROM` must be a sender on a domain you verified in Resend.

### Step 4: Cloud Run (worker)

Deploy the always-on worker from `Dockerfile.worker`:

```bash
gcloud run deploy smartreply-worker \
  --source . \
  --no-allow-unauthenticated \
  --min-instances 1 \
  --cpu 1 \
  --memory 1Gi \
  --cpu-boost \
  --set-env-vars REDIS_URL=...,DATABASE_URL=...,NEXTAUTH_URL=https://<domain> \
  --set-secrets ENCRYPTION_KEY=smartreply-encryption-key:latest
```

Keep `--min-instances 1` and `--cpu-boost` (CPU always allocated) or the BullMQ consumer stalls and no DM sends. The worker needs the same `DATABASE_URL`, `REDIS_URL`, and `ENCRYPTION_KEY` as the web app.

### Step 5: Scheduled jobs (crons)

Firebase App Hosting has no built-in cron. The app exposes three endpoints, each of which requires the header `Authorization: Bearer <CRON_SECRET>`:

| Endpoint | Schedule | Purpose |
| --- | --- | --- |
| `/api/cron/refresh-tokens` | daily 05:00 UTC | Refresh Instagram long-lived tokens nearing expiry. Essential. |
| `/api/cron/attach-next-reel` | daily 06:00 UTC | Attach the "next reel" automation target. |
| `/api/cron/snapshot-followers` | daily 07:00 UTC | Snapshot follower counts for the history chart. |

Drive them with Cloud Scheduler:

```bash
gcloud scheduler jobs create http refresh-tokens \
  --schedule "0 5 * * *" \
  --uri "https://<domain>/api/cron/refresh-tokens" \
  --http-method GET \
  --headers "Authorization=Bearer <CRON_SECRET>"
```

Repeat for the other two. The token-refresh job is the one that matters; if it never runs, Instagram connections eventually expire and sends start failing.

### Alternative: Vercel + Railway

The upstream setup (Vercel for the web app, Railway for the worker plus Postgres and Redis) still works, and `vercel.json` remains in the repo for it. Vercel runs the three crons natively, so that path has no Step 5. If you prefer it, use the Vercel/Railway steps from an earlier revision of this file; everything from [The Meta app](#the-meta-app) onward is identical either way.

## Environment variables

Copy `.env.example` to `.env` for local work. In production, non-secret values live in `apphosting.yaml`; secrets live in Secret Manager (App Hosting) and Cloud Run secrets.

| Variable | What it is |
| --- | --- |
| `NEXTAUTH_URL` | Your public URL. Your App Hosting domain in production, your tunnel URL locally. |
| `NEXTAUTH_SECRET` | Random secret. `openssl rand -base64 32` |
| `CRON_SECRET` | Random secret protecting the cron endpoints. |
| `ENCRYPTION_KEY` | 32-byte hex. `openssl rand -hex 32`. Encrypts Instagram tokens. Identical across web and worker. |
| `DATABASE_URL` | PostgreSQL connection string. Same value on web and worker. |
| `REDIS_URL` | Redis connection string. Must support blocking commands, so an HTTP-only Redis will not work with BullMQ. |
| `RESEND_API_KEY` | Resend key. Login is email magic links only, so without this nobody can sign in. |
| `EMAIL_FROM` | A sender on a domain you verified in Resend. The placeholder will not deliver. |
| `META_GRAPH_API_VERSION` | Graph API version, for example `v25.0`. |
| `INSTAGRAM_APP_ID` | From the Meta app, see Step 7. |
| `INSTAGRAM_APP_SECRET` | From the Meta app. |
| `FACEBOOK_APP_SECRET` | From the Meta app. |
| `WEBHOOK_VERIFY_TOKEN` | Any random string. You paste the same value into Meta's webhook config. |

`ENCRYPTION_KEY` must be exactly 64 hex characters or the app throws on boot.

Optional, for tuning the polling reconciler (defaults are fine to start):

| Variable | Default | What it does |
| --- | --- | --- |
| `COMMENT_POLL_INTERVAL_MS` | `300000` | How often the worker sweeps for missed comments (5 min). |
| `COMMENT_POLL_MAX_PER_SWEEP` | `30` | Max new comments each campaign acts on per sweep. Keep it conservative; higher gets closer to Instagram's rate limits. |
| `COMMENT_POLL_LOOKBACK_HOURS` | `72` | How far back a sweep considers comments. |

## The Meta app

This is the slow part. The code works out of the box; getting Meta to send you comment events is where people lose an afternoon. Every step here exists because skipping it breaks something later. Have your domain from Step 3 ready, you will paste it in a few times.

### Step 6: Create the Meta app

Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and create an app.

- App type: Business.
- Contact email: one you actually check.

When it asks you to add a use case, filter to All, then choose Manage messaging and content on Instagram. Do not pick "Create and manage ads with Marketing API", and do not pick "Authenticate with Facebook Login". SmartReply uses Instagram Login. Picking the Facebook Login variant makes the OAuth flow fail later with a mismatched client error.

If you accidentally added the Marketing API use case, remove it. It has its own heavy review requirements and can block publishing.

### Step 7: Collect the three secrets

There are two app secrets and two app IDs, which is confusing. Here is what maps to what.

| Environment variable | Where it lives |
| --- | --- |
| `INSTAGRAM_APP_ID` | Instagram, API setup with Instagram login. A number like `2036...` |
| `INSTAGRAM_APP_SECRET` | Same page, click Show |
| `FACEBOOK_APP_SECRET` | App settings, Basic, App secret, click Show |

The Instagram app ID is not the same number as the Facebook App ID shown on the Basic settings page. Use the one under the Instagram product.

SmartReply verifies webhook signatures against both `FACEBOOK_APP_SECRET` and `INSTAGRAM_APP_SECRET`, so you do not have to guess which one Meta signs with. Set both.

### Step 8: Add your Instagram account as a tester, and accept the invite

This is the step people miss, and it produces the error "Insufficient Developer Role" on the Instagram login screen. In development, only accounts that have a role on your app can connect. Even your own account has to be added and accept.

There are two halves. Both are required.

Half one, on the Meta side. In the app dashboard, open App roles, then Roles (in the newer console this is also reachable from the Instagram product under "Generate access tokens"). Find the section for Instagram testers, click add, and enter the exact Instagram username of the account you want to connect. Send the invite.

Half two, on the Instagram side. This is the part that gets skipped. Open Instagram as that account (the phone app is easiest):

1. Go to your profile, then the menu, then Settings and activity.
2. Open Apps and websites (older versions: Website permissions, then Apps and websites).
3. Open Tester invites.
4. Accept the invite from your app.

Until you accept here, the account is not really a tester and the login will keep failing. If you do not see the invite, double-check you sent it to the exact username and that the account is a Business or Creator account.

### Step 9: Register the OAuth redirect

In the Instagram product, open Set up Instagram business login, then Business login settings. In the OAuth redirect URIs field, add exactly, using your domain:

```
https://smartreply.happyhunterdigital.com/api/instagram/callback
```

No trailing slash. If this is missing or wrong, connecting an account fails with a redirect_uri mismatch. You can register more than one, which is useful if you change domains later; keep the old and new both listed.

You do not need the "Embed URL" that Meta shows here. SmartReply builds its own login URL. Users connect by opening your app, going to Settings, and clicking Connect Instagram.

### Step 10: Configure the webhook

Still in the Instagram product, find the Configure webhooks step.

- Callback URL: `https://smartreply.happyhunterdigital.com/api/webhook`
- Verify token: the value of `WEBHOOK_VERIFY_TOKEN` from your environment
- Click Verify and save. It should succeed immediately, because the app answers Meta's verification challenge. If the button is greyed out, click into the verify-token field and paste the token again; editing the callback URL often clears it.
- Subscribe to the `comments` field.

To test delivery without a real comment, click Test next to `comments`, then click Send to My Server. This is a two-step control. Clicking Test only previews the sample payload; the second button is what actually POSTs it to your endpoint. After sending, a row should appear in your `WebhookEvent` table.

If your primary domain ever changes, update this callback URL to the new domain. A non-primary domain will 307-redirect the POST, and Meta does not reliably follow redirects, so webhooks silently stop.

### Step 11: Publish the app

Real comment webhooks are only delivered when the app is in Live state. In Development mode, only the console Test button delivers events. This is the single most common reason for "I set everything up and nothing happens."

Go to the Publish item in the left sidebar. Set the privacy policy, terms of service, and data deletion URLs first, or it will not let you publish. SmartReply ships these pages, on your domain:

```
https://smartreply.happyhunterdigital.com/privacy
https://smartreply.happyhunterdigital.com/data-deletion
https://smartreply.happyhunterdigital.com/terms
```

Then publish. Depending on your access level, Meta may let you go live for your own tester accounts immediately, or it may require App Review first (see the last section).

### The account ID trap (informational)

You do not have to do anything here; SmartReply handles it. It is worth understanding because it is invisible when it goes wrong.

Meta's `/me` returns two IDs. The `id` field is app-scoped. The `user_id` field is the Instagram professional account ID. Webhooks put `user_id` in `entry.id`, and the messaging API keys off `user_id` too. SmartReply stores `user_id`, so a fresh connection matches correctly. If you upgraded from a very old build and an account was stored with the wrong ID, disconnect and reconnect it once.

## Test it end to end

1. Make sure the account is a tester and has accepted the invite (Step 8), and the app is published (Step 11).
2. Connect it in the app: Settings, Connect Instagram. You should reach Instagram's consent screen, not the "Insufficient Developer Role" error.
3. Create a campaign on one of your posts with a keyword like `TEST`.
4. From a different Instagram account, comment `TEST` on that post. It must be a different account, because SmartReply ignores your own comments on purpose.
5. Watch for the DM. If nothing arrives, check the DM Logs page and `/api/health`.

Hit `/api/health` any time. It reports the database, Redis, queue, and worker heartbeat. If `worker.healthy` is false, the worker is not running or cannot reach Redis, and no DM will send even though webhooks are being received.

If you want to inspect where a comment stopped, the Postgres tables tell you: `WebhookEvent` for delivery, `DmLog` for send status and errors, `OperationalEvent` for worker crashes and the polling reconciler's sweep logs.

## Local development

You need Postgres and Redis. The included `docker-compose.yml` starts both:

```bash
docker-compose up -d
npm run db:generate
npm run db:migrate
```

Or install them natively (macOS):

```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
createdb smartreply
```

Then set `DATABASE_URL` to match your local user, for example `postgresql://YOUR_USER@localhost:5432/smartreply`.

Run the two processes in separate terminals:

```bash
npm run dev
npm run worker
```

For Meta to reach your local webhook, run a tunnel and point `NEXTAUTH_URL` and the Meta webhook and redirect URLs at the tunnel:

```bash
ngrok http 3000
```

## Set it up with an AI assistant

If you run an AI coding assistant like Claude Code or Cursor, it can drive most of this for you. Open a clone of this repo inside your assistant and paste the prompt below. Give it your keys as it asks for them.

A word of caution: the assistant will need real secrets to finish (Meta app secrets, a Resend key, database URLs). Only paste those into a tool and environment you trust, and rotate them afterward if you are unsure.

```
You are helping me self-host SmartReply, an open source Instagram comment-to-DM
automation tool, in this repository. Read README.md and docs/setup.md first, then
help me get it running end to end.

My goal: <describe it. For example: run it for my own Instagram account only,
or host it for other people to sign up.>

Work through this in order and stop to ask me whenever you need a value or an
action only I can do:

1. Local or hosted. Ask me which I want. If hosted, we use Firebase App Hosting
   for the web app (its domain becomes my public URL) and Cloud Run for the
   worker, plus a managed Postgres and Redis. If local, we use docker-compose
   and a tunnel.

2. Datastores. Help me get a Postgres and a Redis running, then run the Prisma
   migration against them.

3. Environment. Generate NEXTAUTH_SECRET, CRON_SECRET, ENCRYPTION_KEY, and
   WEBHOOK_VERIFY_TOKEN for me. Ask me for my Resend API key and a verified
   sender address, and for the three Meta secrets once I create the app. Make
   sure ENCRYPTION_KEY is identical on the web app and the worker.

4. Deploy both processes (App Hosting and Cloud Run), wire the three crons with
   Cloud Scheduler, and confirm /api/health returns ok with the worker healthy.

5. Meta app. Walk me through the Meta app section of docs/setup.md one step at a
   time. This is the slow part. Tell me exactly what to click and what to paste,
   using my domain for the OAuth redirect and webhook. Remember the account ID
   trap (store user_id, not id) and that the app must be published for real
   webhooks to arrive.

6. Test. Have me create a campaign and comment a keyword from a second account,
   then confirm the DM sent by checking the DmLog table and the DM Logs page.

Rules for you:
- Never invent Meta dashboard steps. If a screen does not match the guide, ask
  me to screenshot it.
- Diagnose failures by querying the Postgres tables directly: WebhookEvent for
  delivery, DmLog for send status, OperationalEvent for worker errors. This is
  faster than logs.
- Remind me to rotate any secret I paste to you before real use.

Start by reading the docs, then ask me question 1.
```

By the end, `/api/health` returns `status: ok` with `worker.healthy: true`, and a comment with your keyword from a second account produces a `SENT` row in the DM logs. If you get there, you are done.

## Letting other people use your instance

Everything above is enough to run SmartReply for your own accounts, or a handful of accounts you add as testers. No App Review needed.

For a stranger to connect their own Instagram to your hosted instance, Meta requires App Review granting Advanced Access on the messaging and comments permissions. That means:

- A screencast of the full flow working, recorded on real accounts in one take.
- A written justification for each permission. Drafts are in [../META_APP_REVIEW.md](../META_APP_REVIEW.md).
- Business verification, which asks for a document proving a legal business entity: a business registration or license, articles of incorporation, a business tax document, or a business bank statement.

Meta scrutinizes automated-DM apps and often rejects the first submission, so budget for a resubmit. If you do not have a registered business, most self-hosters skip this entirely by running their own instance for their own account, which never needs review.

## Security notes

- `.env` is gitignored. Keep it that way.
- Rotate any secret that has been pasted anywhere it could be logged, including a chat with an AI assistant.
- Instagram tokens are encrypted at rest with `ENCRYPTION_KEY`. Losing or changing it means every connected account has to reconnect.
