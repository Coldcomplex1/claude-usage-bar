# Claude Usage Bar

See your Claude.ai usage, your 5-hour session and weekly all-models limits, in a
slim bar under the chat. No sign-in needed.

Claude Usage Bar shows how much of your Claude.ai usage you have left, right under
the chat box, so a limit never catches you off guard mid-conversation.

It puts small bars under the message box for your current 5-hour session usage and
your weekly all-models usage. If your plan has a separate Opus allowance, that
appears too. Each bar is color-coded, blue when you are under 30%, orange from 30%
to 80%, and red above 80%, and it shows a countdown to when the limit resets.

On the free plan Claude publishes no usage percentages at all, so there is nothing
to fetch and no honest bar to fill. There the extension shows the one thing it can
work out on its own: how many messages you have sent in the current 5-hour window,
and the countdown to when that window rolls over. It is a count, not a percentage,
because the free cap moves with demand, and it starts from when you install.

There is nothing to set up. No tokens, no API keys, and no extra sign-in. As long as
you are logged in to Claude, it just works, because it reads your usage straight from
Claude using the session already in your browser. Everything stays on your device and
nothing is sent to any server.

You can pick which bars show, turn the bar on or off with a keyboard shortcut, and
open a small popup for the same numbers with a one-click refresh.

Your privacy is respected. The extension only talks to claude.ai and keeps your
numbers in your local browser storage. It never reads your conversations and never
sends your data anywhere.

This extension is not affiliated with, endorsed by, or sponsored by Anthropic. Claude
is a trademark of Anthropic PBC. It relies on undocumented Claude features that can
change over time.

## Repo layout

- `claude-extension/` is the extension itself. This is the folder you load unpacked
  and the folder you zip for the store. `welcome.html` / `.js` / `.css` inside it is
  the setup box shown on install, and `previews/` holds the screenshot of each
  design that box puts side by side.
- `index.html` is the landing page, a single self-contained file with a live demo of
  the bar. `vercel.json` is the deploy config for it.

## How it works

It reads your usage from Claude's own internal endpoints using the login session
already in your browser:

- `GET /api/organizations` → finds your chat org (probes each org and locks onto
  the one with real usage; cached). The org's `capabilities` also say which plan
  you are on, which is used for wording only.
- `GET /api/organizations/{id}/usage` → `five_hour`, `seven_day`, `seven_day_opus`

Whether the percentage readout or the free-plan count appears is decided by
whether that second call actually returned any windows, never by the plan name —
so an account Claude reports usage for always gets the bars, whatever its
capabilities happen to be called.

On an account with no windows (the free plan) nothing is fetched to fill them.
`session.js` counts sends instead, by watching the transcript for a new message
bubble; it stores a timestamp per message and prunes anything older than five
hours. Message text is never read or stored. A batch that adds several bubbles at
once is history arriving (a page load, a conversation switch, scrolling back) and
is not counted; only a single bubble appearing at the end of the transcript is.

The numbers refresh every five minutes in the background, so the toolbar badge and
the popup are current even when no claude.ai tab is open. When a claude.ai tab is
open the extension asks that tab to do the fetch; otherwise it calls the endpoint
itself. An open, visible tab keeps its own bar no more than a minute old.

Every surface shares one answer rather than fetching its own. A tab, the popup and
the Settings page all check how old the stored numbers are first and only go to the
network when they have actually gone off, so ten open claude.ai tabs still cost one
request a minute between them, and opening the popup on fresh numbers costs none.
The countdowns tick down locally in between.

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

- Click the toolbar icon for the popup: your usage readout, "Show in bar"
  (Session / All models), a Refresh button, and a Settings button.
- Hover anything for the detail: a bar row, or the toolbar icon itself, shows each
  window's percentage, the countdown, the clock time it resets at, and how old the
  reading is. Numbers that could not be refreshed stay on screen but fade, so a
  stale reading never passes for a fresh one.
- Everything else lives on the Settings page (the Settings button, or right-click
  the icon → Options):
  - Master on/off for the bar.
  - Design 1 or Design 2: the full bar under the chat, or a compact widget tucked
    into the composer toolbar (on a composer with no toolbar row, such as the
    one-line chat composer, it takes its own row under the input instead). Set at
    install; Design 1 until you choose.
    "Run setup again" reopens the install box.
  - Toolbar-icon badge: a colored usage number on the extension icon so you can
    read it at a glance. Off by default; when on, choose whether it shows your
    session (5h), weekly all-models (7d), or the higher of the two.
  - Account switch (for multi-org accounts) and "Use automatic" to undo it.
  - The show or hide hotkey.
- Hotkey to show or hide the bar: `Ctrl/Cmd + Shift + U`. Rebind at
  `chrome://extensions/shortcuts`.
- If the bar ever shows 0% on a multi-org account, open Settings → Change → pick
  the account with your real usage. Accounts Claude reports no usage for are
  listed there as "no usage reported (free plan)".

## Permissions

- `storage`: saves your preferences and the last-seen numbers, locally.
- host `https://claude.ai/*`: calls the usage endpoint with your existing session.
- `alarms`: refreshes the numbers every five minutes so they are not stale.
- `commands`: the show or hide keyboard shortcut.

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
and two security headers.

## Caveats

These endpoints are undocumented and not officially supported by Anthropic. If
Claude changes them, the bar may show `–` or `!` until updated. The payload reader
accepts a few shapes beyond the current one (`used`/`limit` and `remaining`/`limit`
as well as `utilization`, epoch or ISO reset times, and the camelCase spellings of
each key), so a rename degrades to a slightly different reading rather than to a
blank bar.

The free-plan count is an approximation by construction: it starts when you
install rather than when the window did, so the first window can read low, and
Claude's free cap is not published and varies with demand, which is why no
percentage is shown against it.

## License

MIT license, see `LICENSE`.
