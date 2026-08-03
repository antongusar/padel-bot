# Racket Events Monitor

Cloudflare Worker that checks a Racket ID group on Mondays and sends Telegram notifications when events appear.

The Worker uses the same Firestore query that the Racket group page uses for its activity list, so it does not spend Cloudflare Browser Run minutes for normal checks.

## Setup

```sh
npm install
npm run deploy
```

The cron fires every minute; the actual run window (which weekdays and what time,
in Europe/Lisbon) is configured at runtime on the `/players` page and stored in KV
(`schedule`). If no weekday is enabled, the Worker does nothing.

```jsonc
"triggers": {
  "crons": ["* * * * *"]
}
```

Cron trigger changes can take several minutes to propagate after deploy. Each
minute outside the window is a single KV read and an immediate return.

## Manual Check

Run locally:

```sh
npm run dev
curl "http://localhost:8787/check"
```

After deploy, open:

```text
https://racket-events-monitor.<your-subdomain>.workers.dev/check
```

The Worker returns the rendered-page decision as JSON and logs the same result with `console.log`.

## Telegram

The bot token is stored as a Cloudflare secret named `TELEGRAM_BOT_TOKEN`.

The Worker exposes `/telegram` as a Telegram webhook. When you send any message to the bot, the Worker stores that chat ID in KV and uses it for future notifications. Notifications are sent only when the state changes from no events to events available.

KV is used only for small monitor state:

- `telegram_chat_id`: where to send Telegram notifications.
- `last_has_events`: previous event availability state, so the bot sends only on `false -> true`.

The Worker reads `last_has_events` during scheduled checks, but writes it only when the state changes.

## Auto Join

When the Monday check finds an upcoming (non-doubles) event in the real group,
the Worker joins every enabled person from the roster (see `/players`) through
Racket's authenticated Firestore API. Players are joined in the order shown on
`/players`: the top enabled player is always attempted first.
Use the up/down controls in the priority column to change that order, then save.

One Durable Object is created per event id. It grants a renewable lease to only
one cron/manual invocation, so competing every-minute ticks return immediately.
Each successful player is checkpointed immediately
before the next player starts. Retries receive only the remaining ids, and each
person has an independent 10-attempt budget. The event is finalized (`done`) once
all enabled people are joined. Success and failures are reported to Telegram.

The direct API path mirrors Racket's own registration transaction: it writes the
player into the event's `users` or `reserves`, removes the invitation, and then
verifies the result with an authenticated read. Paid, club, custom-field, and
team registrations are deliberately excluded from this path and retain the
browser fallback.

The protected `/join-state?event=<eventId>` endpoint exposes the coordinator's
read-only state for diagnostics.

Team-signup / "Doubles" events are skipped automatically (they need a partner in
the Registration Checkout, which the join flow does not handle).

## Manual Join

Two endpoints trigger a real join:

- `/join-test` — joins the first event of the test group (`IenuPng40UmpsU`).
- `/join` — joins the first event of the real group (`GROUP_URL`).

Both prefer the authenticated API and are protected by `JOIN_SECRET` (pass it
as `x-join-secret` or `?secret=...`). The Cloudflare Browser Run binding named
`BROWSER` is used only as a fallback for registration types that the direct API
path intentionally does not support.

Fallback browser joins do not send step-by-step screenshots by default. Set the optional Worker variable
`JOIN_DEBUG_SCREENSHOTS=true` to enable them. Manual `/join` and `/join-test`
requests always keep debug screenshots enabled.

## Tests

```sh
npm test
```

The Cloudflare Workers Vitest suite runs inside `workerd` with real Durable
Object bindings. It simulates a sudden event release, twenty concurrent cron
ticks, partial success, lease recovery after a crash, and per-person retry
exhaustion. It also validates direct API patches for normal and reserve joins.

## Staging

`wrangler.jsonc` contains an isolated `staging` environment. It targets the test
group, has no cron trigger, and provisions separate KV and Durable Object
storage. The deployed staging URL is
`https://racket-events-monitor-staging.anton-gusar.workers.dev`.
Configure staging-specific secrets separately:

```sh
npx wrangler secret put JOIN_SECRET --env staging
npx wrangler secret put TELEGRAM_BOT_TOKEN --env staging
npm run deploy:staging
```

Racket credentials must also be added to staging before a real `/join-test`
smoke test. Production secrets are not inherited by Wrangler environments.

The Racket credentials are stored as Cloudflare secrets named `RACKET_EMAIL` and
`RACKET_PASSWORD`.
