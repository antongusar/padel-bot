# Racket Events Monitor

Cloudflare Worker that checks configured Racket ID groups on a runtime schedule, joins events, and sends Telegram notifications.

The Worker uses the same Firestore query that the Racket group page uses for its activity list, so it does not spend Cloudflare Browser Run minutes for normal checks.

## Setup

```sh
npm install
npm run deploy
```

The cron fires every minute; the actual run window (which weekdays and what time,
in Europe/Lisbon) is configured at runtime on the `/players` page and stored in KV
(`schedule`). If `pausedUntil` is present, the page shows the pause deadline and
affected groups, with a button that resumes monitoring immediately. If no weekday
is enabled, the Worker does nothing.

The same page stores `monitored_groups`, an ordered list of Racket group IDs and
their enabled state. It accepts either IDs or full group URLs. A group can be
disabled without deleting it; disabled groups are skipped by `/check` and the
cron. The reset button beside a group clears the active event's Durable Object
state, so the next cron can repeat a test registration for the same event ID.
Environments without saved settings may provide `GROUP_ID` as an initial fallback;
production uses the saved list only.

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
- `last_has_events:<groupId>`: previous event availability for each group, so the bot sends only on `false -> true`.
- `active_join_event:<groupId>`: event whose Durable Object state is current.
- `monitored_groups`: ordered list of groups and their enabled state.

The Worker reads each group's state during scheduled checks, but writes it only when the state changes.

## Auto Join

When a scheduled check finds an upcoming (non-doubles) event in a monitored group,
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

## Live Status

The protected `/players` page includes an on-demand application status panel.
It calls `GET /status` and shows the current Lisbon schedule state, live
Firestore checks for every enabled group, the current event capacity, each
enabled player's actual `registered` / `reserve` / `not_joined` status, and
Browser Run limits plus recent sessions. Refreshing this panel does not launch
a browser and does not write heartbeat or history records to KV.

Cron checks and join batches also emit structured JSON logs with
`type: "racket-monitor"`. Important actions include `cron_started`,
`group_check_finished`, `cron_finished`, `cron_failed`, and
`join_batch_finished`.

Team-signup / "Doubles" events are skipped automatically (they need a partner in
the Registration Checkout, which the join flow does not handle).

## Manual Join

Two endpoints trigger a real join:

- `/join-test` — joins the first event of the test group (`IenuPng40UmpsU`).
- `/join` — joins the first event of the first monitored group.
- `/join?group=<groupId>` — manually selects a specific group.

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

The staging player and credentials are managed through the protected `/players`
page and stored in the staging KV roster. Production secrets are not inherited
by Wrangler environments.
