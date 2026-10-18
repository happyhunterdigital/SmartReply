# Stack

Everything SmartReply needs to run, in one place: the application libraries, the
runtime processes, and the specific (free) services this instance is deployed on.
For the step-by-step setup, see [setup.md](setup.md).

## Application

| Layer | Tool |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack) + React 19 |
| Language | TypeScript 5 |
| ORM / DB | Prisma 7 with the `@prisma/adapter-pg` driver, PostgreSQL |
| Queue | BullMQ 5 on Redis, via `ioredis` |
| Auth | Auth.js / NextAuth 5 (email magic links) |
| Email | Resend (login links) |
| Validation | Zod 4 |
| Charts | Recharts 3 |
| Styling | Tailwind CSS 4 |
| Tests | Vitest 4 |
| Worker runtime | `tsx` (runs `worker/dm-worker.ts`) |
| Instagram | Official Meta Graph API (Instagram Login) |

## Runtime — two processes, two datastores

- **Web app + API** (`npm run dev` / `npm start`): Next.js. Serves the dashboard,
  the OAuth callback, and the incoming webhook. Runs on Firebase App Hosting (`apphosting.yaml`).
- **Worker** (`npm run worker`): a long-running Node process. Consumes the send
  queue, sends the DMs, runs the polling reconciler, and performs the follow-gate
  `is_user_follow_business` checks. **Must stay always-on with CPU allocated**, so it
  runs on Cloud Run (`Dockerfile.worker`), not on a serverless web host.
- **PostgreSQL**: campaigns, DM logs, accounts, sessions, tracked links, click events.
- **Redis**: the BullMQ send queue and the per-account rate limiter. Must speak the
  native Redis protocol over TCP (an HTTP-only Redis will not work with BullMQ).

The web app and the worker must share the same `DATABASE_URL`, `REDIS_URL`, and
`ENCRYPTION_KEY`. The web app stores the encrypted Instagram token; the worker
decrypts it to send. Different keys mean every send fails to decrypt.

## Reference deployment

The canonical deployment (Firebase App Hosting + Cloud Run) is documented step by
step in [setup.md](setup.md).

| Piece | Service | Notes |
| --- | --- | --- |
| Web app | Firebase App Hosting | `apphosting.yaml`, runtime `nodejs22`, `minInstances: 1` |
| Worker | Cloud Run | `Dockerfile.worker`, always-on (`--min-instances 1 --cpu-boost`) |
| PostgreSQL | Any managed Postgres (Neon, Supabase, Cloud SQL) | — |
| Redis | Any managed Redis (Redis Cloud, Upstash, Memorystore) | must speak native TCP |
| Cron | Cloud Scheduler | hits the `/api/cron/*` endpoints with `CRON_SECRET` |
| Login email | Resend | Free (3k emails/mo) |
| Instagram API | Meta app with Instagram Login | Free |

The always-on worker means this path carries a small monthly cost (one Cloud Run
instance plus Postgres and Redis). For a genuinely zero-cost stack, the upstream
Vercel + Neon + Redis Cloud + Oracle "Always Free" VM layout still works; it is
described in the git history and `vercel.json` remains in the repo for it.

## Environment variables

Names only — values live in `.env` (gitignored) or the host's env settings, never
in the repo. Full descriptions are in [setup.md](setup.md#environment-variables).

`NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`,
`REDIS_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `META_GRAPH_API_VERSION`,
`INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`,
`WEBHOOK_VERIFY_TOKEN`.
