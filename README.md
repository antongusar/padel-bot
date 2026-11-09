# Racket Events Monitor

Cloudflare Worker that checks configured Racket ID groups on a runtime schedule, joins events, and sends Telegram notifications.

The Worker uses the same Firestore query that the Racket group page uses for its activity list, so it does not spend Cloudflare Browser Run minutes for normal checks.

## Setup

```sh
npm install
npm run deploy
```

The cron fires every minute as a watchdog. During the configured run window it
starts a singleton `MonitorScheduler` Durable Object, which searches for new
events once every 60 seconds. Between searches, only discovered events still
waiting for participants or retrying registration are read directly by ID every
10 seconds. Completed or exhausted events leave the fast queue; discovery keeps
running every minute so later events can still be found. The queue, known copy
parents, and last discovery time survive scheduler restarts in Durable Object storage.
The weekdays and times use Europe/Lisbon and
are configured at runtime on `/players` in KV (`schedule`). If `pausedUntil` is
present, the page shows the pause deadline and affected groups, with a button that
resumes monitoring immediately. If no weekday is enabled, the Worker does nothing.

The same page stores `monitored_groups`, an ordered list of Racket group IDs and
their enabled state. It accepts either IDs or full group URLs. Each group has
independent switches for ordinary and team-signup events. Team events use an
ordered list of pairs; the partner can be another enabled roster player or a
Racket `Placeholder`. A group can be
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
minute outside the window is a single KV read and an immediate return. Empty
discovery checks produce one persisted health entry per minute so they
do not displace event and join diagnostics from the 10,000-step journal.

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

The Worker exposes `/telegram` as a Telegram webhook. When you send any message to the bot, the Worker stores that chat ID in KV and uses it for future notifications. Notifications are sent when the event IDs or their auto-join eligibility change. Each message says which events can be auto-joined and which doubles events are skipped because they require a partner.

KV is used only for small monitor state:

- `telegram_chat_id`: where to send Telegram notifications.
- `last_has_events:<groupId>`: compact event ID and auto-join eligibility signature, so the bot writes and sends only when the event set changes.
- `active_join_event:<groupId>`: event whose Durable Object state is current.
- `monitored_groups`: ordered list of groups and their enabled state.

The Worker reads each group's state during scheduled checks, but writes it only when the state changes.

## Auto Join

Scheduled registration waits until the event has at least 10 registered
participants, then starts on the next 10-second check with no extra delay.
Reserve entries do not count, including reserves inherited from a copied event.
The threshold is configurable per group on `/players`; set it to 0 to register
immediately. Waiting does not consume player attempts. Once a batch starts,
retries continue even if the participant count later falls below the threshold.
An already discovered upcoming event is checked directly by ID if it is removed
from the group's list. Scheduled discovery also finds hidden copies through
`copiedFrom`, starting with past and undated events belonging to the group.
Copies must have the same creator as their known parent, be event products with
`status: instance`, and belong to this group or have an empty group. Unrelated
creator-only events, bookings, and copies attached to another group are excluded.
Parent IDs are remembered even after removal from the group; successive copies
are followed in the same discovery pass. Queries project only event metadata
and batch up to 30 parent IDs per request, once per minute.
Undated candidates created within the last seven days are persisted and read
every 10 seconds. Older permanent templates remain copy parents and are checked
by minute discovery rather than occupying the fast queue. Undated candidates are never joined
or announced as upcoming events until they have a valid future date. They then
follow the configured participant threshold. Discovery/read failures keep the
pending queue for the next check.
Manual `/join` and `/join-test` calls bypass the participant threshold.

When a scheduled check finds an upcoming (non-doubles) event in a monitored group,
the Worker joins every enabled person from the roster (see `/players`) through
Racket's authenticated Firestore API. Players are joined in the order shown on
`/players`: the top enabled player is always attempted first.
Use the up/down controls in the priority column to change that order, then save.

One Durable Object is created per event id. It grants a renewable lease to only
one alarm/manual invocation, so competing ticks return immediately.
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

The same page includes a live operation journal backed by the singleton
`OperationLogStore` Durable Object. It groups entries by `runId`, refreshes every
10 seconds, and opens in the `Запись игроков` view, which hides routine no-event
cron checks. Server-side views select complete runs before applying the response
limit: `join`, `problems`, `events`, or `all`. `GET /logs?secret=...&view=join`
exposes the same data as JSON. The store keeps the newest 10,000 steps and prunes
older entries automatically; it does not use Workers KV.

Cron checks and join batches also emit structured JSON logs with
`type: "racket-monitor"`. Important actions include `monitor_polling_healthy`,
`monitor_check_started`, `group_check_finished`, `monitor_check_finished`, and
`join_batch_finished`. Per-player diagnostics use `join_person_started`,
`firestore_join_attempt`, `browser_fallback_started`, `browser_acquired`,
`browser_acquisition_failed`, and `join_person_finished`. They include HTTP
statuses and timings but never authentication tokens or Firestore documents.
Browser fallback also records page navigation, login controls, event selection,
the Join and checkout buttons, and final participation verification. Sensitive
keys such as passwords, tokens, authorization headers, cookies, secrets, and
emails are recursively redacted before persistence.

Team-signup events are detected from Firestore's `teamSignup` / `fixedTeams`
fields, not from the title or the generic `doubles` field. The latter is also true
for ordinary 2×2 padel games. A configured pair is written as one optimistic
Firestore update with the same `joinDate` for both participants. Placeholder
partners receive the same temporary `IUserProfiles` record that the Racket client
creates. Team writes are verified from the event document and never fall back to
Browser Run.

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
