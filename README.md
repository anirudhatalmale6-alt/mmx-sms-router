# MMX SMS Router

An external web portal that receives **MMX DirectTEXT** callbacks (MO messages
and Delivery Receipts) on a single inbound endpoint and forwards each one to the
correct customer endpoint — routed by **Sender ID** and/or **Keyword**, with
**DR fan-out** and a **multi-stage retry** engine.

Built to run **free** on Cloudflare Workers + D1 (always-on, no cold-start
"sleep" — important for a webhook receiver).

```
   MMX  ──POST──▶  /inbound/mo | /inbound/dr  ──▶  routing engine  ──▶  customer URL(s)
                                                        │
                                                        ├─ log every inbound + delivery
                                                        └─ retry failed forwards (cron)
```

## What it does (mapped to the MMX spec)

| Spec | Feature | Status |
|------|---------|--------|
| 9.2 | Route MO by Sender ID | ✅ |
| 9.2 | Route MO by Keyword | ✅ |
| 9.2 | Route MO by Sender ID **and** Keyword (most specific wins) | ✅ |
| 9.2 | Multiple Sender IDs → same URL / different URLs | ✅ |
| 9.3 | DR fan-out to multiple URLs | ✅ |
| 9.3 | DR URLs scoped to a specific Sender ID | ✅ |
| 9.4 | message_id format per customer (UUID / numeric ≤12 / ≤19 / passthrough) | ✅ |
| 9.5 | Retry on non-2xx, fixed interval | ✅ |
| 9.5 | Multi-stage retry policies (per-stage delay/duration) | ✅ |
| 9.5 | Different retry policies per Sender ID | ✅ |
| — | Admin dashboard (customers, routes, policies, live logs) | ✅ |

> **9.1 Prioritization of MT requests** is a setting arranged directly with
> MMX's provisioning team (it governs MMX→carrier traffic, not the inbound
> callbacks this portal handles), so it sits outside the router. A tracking
> screen for it can be added if useful.

## Routing rules

**MO** — the single most specific matching rule wins, in this order:

1. Sender ID **+** Keyword
2. Keyword only
3. Sender ID only
4. Catch-all (a rule with neither set)

Ties break on an explicit `priority` column, then newest rule.

**DR** — *fan-out*: every enabled rule for the account whose optional Sender ID
matches receives a copy of the receipt.

**Keyword matching** is configurable per rule: `first_word` (default SMS
shortcode convention), `contains`, or `exact` — all case-insensitive.

## Retry engine (spec 9.5)

A policy is a list of stages `[{ retryDelay, retryDuration }, ...]`. Each stage
allows `floor(retryDuration / retryDelay)` retries; when a stage is exhausted the
next begins, and when the last is exhausted the delivery is marked `failed`.
Example from the spec:

```json
[ { "retryDelay": 10, "retryDuration": 100 },   // 10 retries, 10s apart
  { "retryDelay": 30, "retryDuration": 300 } ]  // then 10 retries, 30s apart
```

A cron trigger (every minute, free on Workers) re-drives every due delivery.
Policies resolve in order: rule-attached → per-Sender-ID → customer default →
MMX default (retry every 60s for 48h).

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/inbound/mo` | MMX posts MO here |
| POST | `/inbound/dr` | MMX posts DR here |
| GET  | `/dashboard` | Admin console |
| GET/POST/PATCH/DELETE | `/admin/*` | JSON API (needs `X-Admin-Token`) |
| GET  | `/` | Health check |

The inbound parser accepts JSON, form-encoded, or query-string bodies and reads
the common field aliases for account / sender / message / message_id, so it works
regardless of MMX's exact naming — and the raw body is always logged.

## Deploy (free)

```bash
npm install
npx wrangler login
npx wrangler d1 create mmx_router          # paste database_id into wrangler.toml
npm run db:init:remote                      # create tables
npx wrangler secret put ADMIN_TOKEN         # set a strong admin token
npm run deploy
```

Then give MMX's provisioning team your two callback URLs:
`https://<your-worker>.workers.dev/inbound/mo` and `.../inbound/dr`.

## Local development

```bash
npm install
npm run db:init            # local D1
npm run dev                # wrangler dev on :8788
# open http://localhost:8788/dashboard  (token: dev-admin-token-change-me)
```

## Tests

```bash
npm test                   # unit tests: routing + retry logic
```

End-to-end (routing, DR fan-out, retry recovery, dashboard) is exercised by the
scripts under `test/`.
