# Racket Events Monitor

Cloudflare Worker that checks a Racket ID group on Mondays and sends Telegram notifications when events appear.

The Worker uses the same Firestore query that the Racket group page uses for its activity list, so it does not spend Cloudflare Browser Run minutes for normal checks.

## Setup

```sh
npm install
npm run deploy
```

The schedule is configured in `wrangler.jsonc`. Cloudflare cron runs in UTC, so the Sunday 23:00 UTC trigger covers the first hour of Monday in Europe/Lisbon during daylight saving time; the code still skips checks unless it is Monday in Europe/Lisbon.

```jsonc
"triggers": {
  "crons": ["* 23 * * SUN", "* * * * MON"]
}
```

Cloudflare cron expressions run in UTC. Cron trigger changes can take several minutes to propagate after deploy.

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

When the Monday check finds an upcoming event in the real group, the Worker signs
in with the configured Racket credentials and joins the first upcoming event
through the Racket web UI.

Idempotency across the every-minute Monday cron is handled with a per-event KV
flag (`join:<eventId>`): once joined it is marked `done` and no browser is
launched again; on failure a counter caps retries at 10 so a persistent failure
cannot burn browser minutes all day. Success and failure are reported to Telegram.

Registration is confirmed on the event page itself by finding the expected player
name(s) in the joined-players list — set them as a comma-separated Cloudflare
secret `RACKET_PLAYER_NAMES` exactly as Racket displays them (e.g. `Anton Gusar`).
Matching is case-insensitive.

## Manual Join

Two endpoints trigger a join through the browser and stream step-by-step
screenshots to the registered Telegram chat:

- `/join-test` — joins the first event of the test group (`IenuPng40UmpsU`).
- `/join` — joins the first event of the real group (`GROUP_URL`).

Both use the Cloudflare Browser Rendering binding named `BROWSER` and are protected
by `JOIN_SECRET` (pass it as `x-join-secret` or `?secret=...`). Normal scheduled
checks still use Firestore reads and do not launch a browser.

The Racket credentials are stored as Cloudflare secrets named `RACKET_EMAIL` and
`RACKET_PASSWORD`.
