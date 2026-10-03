# Claude Usage Bar

See your Claude.ai usage, every limit your plan has and the extra-usage credits
you spend, in a slim bar under the chat. No sign-in needed.

Claude Usage Bar shows how much of your Claude.ai usage you have left, right under
the chat box, so a limit never catches you off guard mid-conversation.

It puts small bars under the message box for your current 5-hour session and your
weekly all-models usage, and for every other limit Claude reports for your plan:
a per-model weekly cap such as "Fable only" or "Sonnet only", or a separate
Cowork or Claude Code allowance. Each appears on its own, under Claude's own
name. Each bar is color-coded, blue when you are under 30%, orange from 30% to
80%, and red above 80% (you can move those two points), and shows a countdown to
when the limit resets.

If you use extra usage, the money shows too: what you have spent against your
monthly cap ("$12.40 of $50"), and a clear mark when a limit is full and what you
send is now billed at API rates.

It also keeps a short history on your device, which buys three things:

- A pace marker on each bar, where an even pace through the window would put
  you by now, and a forecast when you are on course to run out before the reset
  ("At this pace: full in ~40m, resets in 2h 10m").
- A dashboard: every limit over the last day, week or month, how often you ran
  out, your busiest hours, what extra usage you spent, and an export.
- Optional alerts at the thresholds you choose, when a limit you got close to
  resets, and when extra usage starts billing or nears its cap.

On the free plan Claude publishes no usage percentages at all, so there is nothing
to fetch and no honest bar to fill. There the extension shows the one thing it can
work out on its own: how many messages you have sent in the current 5-hour window,
and the countdown to when that window rolls over. It is a count, not a percentage,
because the free cap moves with demand, and it starts from when you install.

There is nothing to set up. No tokens, no API keys, and no extra sign-in. As long as
you are logged in to Claude, it just works, because it reads your usage straight from
Claude using the session already in your browser. Everything stays on your device and
nothing is sent to any server.

Your privacy is respected. The extension only talks to claude.ai and keeps your
numbers in your local browser storage. It never reads your conversations and never
sends your data anywhere.

This extension is not affiliated with, endorsed by, or sponsored by Anthropic. Claude
is a trademark of Anthropic PBC. It relies on undocumented Claude features that can
change over time.

## Repo layout

- `claude-extension/` is the extension itself. This is the folder you load unpacked
  and the folder you zip for the store.
  - `usage.js` reads the usage endpoint (every limit, the extra-usage block, the plan).
  - `history.js` keeps the local history and works out the forecasts.
  - `alerts.js` decides when an alert is due.
  - `session.js` is the free-plan send counter.
  - `charts.js` draws the dashboard's charts as plain SVG.
  - `content.js` is the bar on claude.ai, `background.js` the service worker
    (badge, background refresh, history and alerts), and `popup.*`,
    `options.*`, `dashboard.*` and `welcome.*` the extension's pages.
  - `previews/` holds the screenshot of each design the setup box puts side by side.
- `tests/` is the unit test suite (see Tests below). It is not part of the
  extension.
- `index.html` is the landing page, a single self-contained file with a live demo of
  the bar. `vercel.json` is the deploy config for it.

## How it works

It reads your usage from Claude's own internal endpoints using the login session
already in your browser:

- `GET /api/organizations` → finds your chat org (probes each org and locks onto
  the one with real usage; cached). The org's `capabilities` and
  `rate_limit_tier` say which plan you are on (Pro, Max 5x, Max 20x...), which is
  used for wording only.
- `GET /api/organizations/{id}/usage` → everything else, from one response:
  - `limits[]`, the list that names every limit the plan has
    (`session`, `weekly_all`, and `weekly_scoped` with the model or surface it
    applies to), plus the older top-level keys `five_hour`, `seven_day`,
    `seven_day_opus`, `seven_day_sonnet`, `seven_day_cowork` and
    `seven_day_oauth_apps`. The list wins where it has something to say; the old
    keys fill in what it leaves out, and the old per-model keys are read only when
    the list names no per-model limit, so one cap is never drawn twice.
  - `extra_usage` and `spend`, the extra-usage meter: what was spent and the
    monthly cap (both in minor units, so 1240 is $12.40), the balance and
    auto-reload when present, and whether the cap is reached.

Whether the percentage readout or the free-plan count appears is decided by
whether that second call actually returned any limits (or any spend), never by the
plan name -- so an account Claude reports usage for always gets the bars, whatever
its capabilities happen to be called. An enterprise account billed purely by
usage, with spend but no limits, gets its spend rather than the free-plan count.

On an account with nothing reported (the free plan) there is nothing to fill the
bars with, so that answer is held for a day rather than asked for again every
minute. It is still checked: once the day is up the next refresh probes for real,
so an upgrade is picked up on its own, and the popup's Refresh button forces a
check straight away for anyone who would rather not wait. Only a clean "no usage
reported" starts that day -- a request that failed is not an answer, so an outage
or a logged-out moment never parks a paying account on the free readout.

In between, `session.js` counts sends, by watching the transcript for a new message
bubble; it stores a timestamp per message and prunes anything older than five
hours, and it adds each send to a count per hour for the dashboard's activity view.
Message text is never read or stored. A batch that adds several bubbles at once is
history arriving (a page load, a conversation switch, scrolling back) and is not
counted; only a single bubble appearing at the end of the transcript is. This
counting only runs on the free plan.

The numbers refresh every five minutes in the background, so the toolbar badge and
the popup are current even when no claude.ai tab is open. A free account is the
exception described above: it is checked once a day, and the count it shows in
between is worked out locally and current either way. When a claude.ai tab is
open the extension asks that tab to do the fetch; otherwise it calls the endpoint
itself. An open, visible tab keeps its own bar no more than a minute old.

Every surface shares one answer rather than fetching its own. A tab, the popup and
the Settings page all check how old the stored numbers are first and only go to the
network when they have actually gone off, so ten open claude.ai tabs still cost one
request a minute between them, and opening the popup on fresh numbers costs none.
The countdowns tick down locally in between.

### History, forecasts and alerts

The service worker sees every reading land, whichever surface fetched it, so it is
the one place that writes the history: tabs never race each other into it. It
keeps a point only when something moved (at most one a minute, and an hourly one
when nothing does), in one storage key per day; days older than a week are thinned
to one point per ten minutes, and nothing is kept past sixty days. Limits running
out, resets, and extra usage starting or reaching its cap are logged as events.

From that history it works out each limit's burn rate since it last fell, and from
the rate when the limit fills and where it lands by the reset. A limit that has not
moved for a while counts as idle and gets no forecast; a weekly one needs an hour
of data and more than a one-point step first, since Claude reports whole
percentages. The pace marker needs no history: it is how much of the window (five
hours, or seven days) has gone by, read from the reset time.

The activity view on a paid plan comes from the same history -- how fast the
session filled, hour by hour -- so it covers every device you use Claude on, and
nothing about any message is read or counted for it.

Alerts are off until you turn them on. Then each new reading is checked against the
thresholds you chose (80% and 95% by default), once per window; a limit you got
close to gets an alarm for the moment it resets; and extra usage gets its own
alerts. They show as a toast on claude.ai, or as desktop notifications if you allow
those -- that permission is optional and only asked for when you switch it on.

The bar follows claude.ai's own light/dark setting, read from the page, rather than
the operating system's, so it stays legible if you set one of them to override the
other.

Everything stays on your machine (`chrome.storage.local`). Nothing is sent to any
third-party server.

## Install

From the Chrome Web Store:
[Claude Usage Bar](https://chromewebstore.google.com/detail/claude-usage-bar-track-yo/jlomdmgiaoldnhjfhehgjjkgnlighmeo).

Or run it from source:

1. Go to `chrome://extensions`.
2. Turn on Developer mode (top right).
3. Click Load unpacked and select the `claude-extension` folder.
4. Open or refresh claude.ai.

Works on any Chromium browser (Chrome, Edge, Brave, Arc, Opera).

## Using it

Installing opens a setup box in a tab, which asks the two things the extension
used to decide on your behalf: Design 1 or Design 2, and whether the toolbar icon
carries your usage number. Both apply as you click them. Close that tab without
answering and the same box appears once over claude.ai instead, where clicking a
design swaps the real widget on the page behind it. Nothing is blocked either way —
the bar runs on Design 1 until you say otherwise, and Settings → "Run setup again"
brings the box back whenever you want it.

- Click the toolbar icon for the popup: every limit with its pace, forecast and a
  one-day sparkline, the extra-usage card, your plan, "Show in bar" (Session / All
  models / Per-model / Extra usage), a one-click alerts switch, Refresh, Settings,
  and links to the dashboard and to Claude's own usage page.
- Right-click the toolbar icon for Refresh usage now, Open usage dashboard, and
  Open Claude's usage page.
- Hover anything for the detail: a bar row, or the toolbar icon itself, shows each
  window's percentage, the countdown, the clock time it resets at, the pace, the
  forecast, and how old the reading is. Numbers that could not be refreshed stay on
  screen but fade, so a stale reading never passes for a fresh one. The free-plan
  number is counted here rather than fetched, so it is always current and never
  fades.
- The dashboard (from the popup, Settings, or the right-click menu) shows the last
  24 hours, 7 days or 30 days: every limit over time, how often one ran out, the
  average daily peak, time spent at a limit, extra usage spent, your busiest hours,
  and a log of what happened. Every chart has a table view, and the history exports
  as CSV or JSON.
- Everything else lives on the Settings page (the Settings button, or right-click
  the icon → Options):
  - Master on/off for the bar.
  - Design 1 or Design 2: the full bar under the chat, or a compact widget tucked
    into the composer toolbar (on a composer with no toolbar row, such as the
    one-line chat composer, it takes its own row under the input instead). Set at
    install; Design 1 until you choose. Design 2 shows the tightest per-model limit
    by name, with the rest in its tooltip. "Run setup again" reopens the install box.
  - What the bar shows: each kind of row on or off, the pace marker, "hide the bar
    until usage reaches" a level you pick (a forecast that a limit will run out, or
    extra usage billing, still shows it), and the orange and red thresholds.
  - Toolbar-icon badge: a colored usage number on the extension icon so you can
    read it at a glance. Off by default; when on, choose your session (5h), weekly
    all-models (7d), the higher of the two, the tightest of every limit, or the
    extra-usage spend. A full limit shows the time until it resets instead.
  - Alerts: off by default; the thresholds, reset alerts, extra-usage alerts,
    desktop notifications, and a test button.
  - Usage history: switch it off, clear it, or open the dashboard.
  - Account switch (for multi-org accounts) and "Use automatic" to undo it.
  - The keyboard shortcuts.
- Hotkey to show or hide the bar: `Ctrl/Cmd + Shift + U`. A second one, to open the
  popup, has no default so it cannot clash with anything; set it, or rebind either,
  at `chrome://extensions/shortcuts`.
- If the bar ever shows 0% on a multi-org account, open Settings → Change → pick
  the account with your real usage. Accounts Claude reports no usage for are
  listed there as "no usage reported (free plan)".

## Permissions

- `storage`: saves your preferences, the last-seen numbers and the history, locally.
- host `https://claude.ai/*`: calls the usage endpoint with your existing session.
- `alarms`: refreshes the numbers every five minutes so they are not stale, and
  times the reset alerts.
- `contextMenus`: the three items on the toolbar icon's right-click menu.
- `notifications` (optional): only requested if you turn on desktop notifications
  for alerts. Without it, alerts show on claude.ai instead.
- `commands`: the keyboard shortcuts.

## Tests

The logic that does not need a page -- reading the payload, the history and its
forecasts, the alert decisions, the badge, the chart helpers, the free-plan counter
-- has a dependency-free test suite. With Node 18 or newer:

    node --test tests/*.test.js

`tests/load.js` runs the extension's scripts as the browser would, against an
in-memory stand-in for the `chrome.*` APIs.

## Shipping an update

The listing is live, so an update is: bump `version` in
`claude-extension/manifest.json`, zip the `claude-extension` folder, upload it in
the developer dashboard. The code is Manifest V3 and ships no remote code, so
there is nothing else to satisfy on the store side.

The privacy policy the listing points at is `claude-extension/privacy-policy.html`,
which the landing page also serves at `/privacy`.

## Landing page

`index.html` at the repo root is the whole site: one self-contained file, no build
step, with a working demo of the bar running on made-up numbers. Open it straight
from disk to work on it.

Vercel needs no configuration for it. Import the repo, framework preset "Other", no
build command, root directory `.`. `vercel.json` only adds the `/privacy` rewrite
and two security headers, and `.vercelignore` keeps the tests off the site.

## Caveats

These endpoints are undocumented and not officially supported by Anthropic. If
Claude changes them, the bar may show `–` or `!` until updated. The payload reader
accepts a few shapes beyond the current one (`used`/`limit` and `remaining`/`limit`
as well as `utilization`, epoch or ISO reset times, the camelCase spellings of
each key, both the `limits` list and the older keys, and both extra-usage blocks),
so a rename degrades to a slightly different reading rather than to a blank bar.

The forecasts are estimates: they assume you keep going at the rate of the last
hour (session) or day (weekly), and the pace marker assumes the window is five
hours or seven days long, counted back from the reset time Claude reports.

The free-plan count is an approximation by construction: it starts when you
install rather than when the window did, so the first window can read low, and
Claude's free cap is not published and varies with demand, which is why no
percentage is shown against it.

Because a free account is only re-checked once a day, upgrading can take up to a
day to turn into real bars on its own. Opening the popup and clicking Refresh
checks straight away.

## License

MIT license, see `LICENSE`.
