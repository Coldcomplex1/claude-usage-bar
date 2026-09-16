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
to fetch. What the bar shows there depends on what Claude itself has told you.
Claude does say things about your free limit in its own interface — how many
messages are left, that you have run out, the time it comes back — and when it
does, the extension reads that and turns it into a real bar. Until then it shows
what it can count on its own: the messages you have sent in the current 5-hour
window, and the countdown to when that window rolls over.

A percentage worked out this way is always drawn hatched and always prefixed `~`,
so it can never be mistaken for one of the solid bars a paid account gets. The
extension never invents a limit to measure you against.

There is nothing to set up. No tokens, no API keys, and no extra sign-in. As long as
you are logged in to Claude, it just works, because it reads your usage straight from
Claude using the session already in your browser. Everything stays on your device and
nothing is sent to any server.

You can pick which bars show, turn the bar on or off with a keyboard shortcut, and
open a small popup for the same numbers with a one-click refresh.

Your privacy is respected. The extension only talks to claude.ai and keeps your
numbers in your local browser storage, and never sends your data anywhere. On the
free plan it measures how long your messages are, because that is what the limit
is really spent on — only the character count is kept, never a word of what you
wrote, and it never leaves your device.

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
- `tests/run.js` covers the logic that decides what the user is told: the counting
  rule, the anchored window, the limit-notice parser and the estimator's
  fallbacks. Run it with `node tests/run.js` — no dependencies, no `package.json`,
  nothing to install, so the repo stays a clone-and-load-unpacked repo.

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

On an account with no windows (the free plan) there is nothing to fill them with,
so that answer is held for a day rather than asked for again every minute. It is
still checked: once the day is up the next refresh probes for real, so an upgrade
is picked up on its own, and the popup's Refresh button forces a check straight
away for anyone who would rather not wait. Only a clean "no usage reported" starts
that day -- a request that failed is not an answer, so an outage or a logged-out
moment never parks a paying account on the free readout.

In between, `session.js` counts sends, by watching the transcript for a new message
bubble; it stores a timestamp per message, and a cost in units (below). Message
text is measured for its length and never stored. A
batch that adds several bubbles at once is history arriving (a page load, a
conversation switch, scrolling back) and is not counted; only a single bubble
appearing at the end of the transcript is.

The window those messages fall in is **anchored**, not sliding. Claude states one
reset time and clears everything at it, so that is what the extension models: a
send arriving after the reset opens a new window and the count starts again. (It
used to slide the window along its oldest surviving message, which meant that
messages at 00:00 and 04:00, read at 05:00, came back as "1 message, resets at
09:00" when Claude had in fact reset to zero.)

`estimate.js` is what makes a percentage possible. It reads the short notices
claude.ai shows about your own limit — "5 messages remaining", a message-limit
notice, "until 4 PM" — off the nodes the counting observer is already walking, so
there is no second observer on the page. From those it learns two things:

- **A reset time anchors the window**, including one that opened before the
  extension was watching. This is what fixes the countdown for anyone who installs
  mid-window.
- **A stated figure gives a denominator.** "5 left" when we have counted 20 means
  the cap is 25; being cut off at 23 means the cap was 23, exactly.

A figure Claude gave in an earlier window is not a fact about this one, but it is
the best evidence there is, so a window Claude has said nothing about is measured
against the median of what it said before. That reading is `estimated` rather than
`observed`, and the tooltip says which it is.

**Messages are not what the limit is spent on.** Claude is billed in tokens, and
the whole conversation is re-sent every turn, so message 20 of a long chat costs
many times message 1 of a fresh one — which is why "I only sent 8 messages and got
cut off" is a real experience a message counter can never explain. So each send is
weighed by how much conversation it carried: character counts over a
characters-per-token figure, with output weighted above input and a flat allowance
for the system prompt and for images. Every constant is named `PRIOR_` because it
is a shape rather than a measurement; they make the *relative* comparison
trustworthy long before they make any absolute number so. Only the integer cost is
stored, never the text it was measured from. If the page changes shape and the
measurement stops working, every send costs the same flat amount and the estimate
degrades to the count-based one rather than reading as no usage at all.

Two readings fall out of the cost model that need no limit at all, and so are
there on a free account's first day, before Claude has said anything:

- **What this conversation costs.** The next send in a long chat can cost several
  times one in a fresh chat, and the tooltip says so — "this chat costs about 4x a
  message in a fresh one". Past about 3x it adds the one piece of advice available
  on the free plan that actually saves anything: start a new chat, and the next
  message is cheap again. Nothing else on the page will tell you that.
- **How many sends are left at this pace.** Once there is a cap, the remainder is
  divided by what the recent sends actually cost, rounded down. Two windows can
  sit at the same percentage and have room for six more messages or one, and only
  this says which — when Claude has stated a figure in messages, that figure wins
  over the arithmetic.

Four rules keep that honest:

- **A number inside the conversation is never read as a limit.** Anything the
  guard places inside the transcript or the composer is thrown out before the
  patterns run, so typing "5 messages left" into a chat cannot move the bar.
- **A cap derived from an incomplete count is not a denominator.** "5 left" says
  what remains and nothing about the total; turning it into one needs
  `cap = what we sent + what is left`, which only holds if our count was complete.
  Install midway through a window, or have the browser shut for an hour of it, and
  our count is a floor — the cap comes out too small and the percentage too big,
  which would tell someone they are nearly out when they are not. So no bar is
  drawn at all. The row shows "5 left" instead, which is the more useful half.
- **An un-hit cap is a lower bound, not a cap.** If a window has already run past
  every limit learned before and Claude has not stopped you, the cap moved — it
  does, with demand — and the learned number is simply too small. Pinning the bar
  at 100% for someone still happily chatting is the same cry-wolf failure as
  above, so no bar is drawn and the row says "past your usual".
- **Nothing degrades to a wrong number.** Every path can only turn a count into a
  percentage. If Claude rewords its notices and none of the patterns match again,
  the readout is the count it always was.

### Working on the free readout

It cannot be reached from a paid account, so there are hooks. In the extension's
storage (DevTools → Application → Storage → Extension storage):

- `cub_debug_plan: "free"` forces the not-reported path, so a paid account renders
  the free readout. This is the prerequisite for the rest.
- `cub_free_calib` is the calibration store, and writing it by hand is how you
  drive the other two readouts without waiting to hit a real limit. One row is
  enough — `{"caps":[{"at":<now>,"cap":25,"count":20,"kind":"remaining","whole":true}]}`
  gives the hatched bar; `"whole":false` gives the "5 left" readout instead;
  `"kind":"exhausted"` gives the hard stop. There is no separate debug key for
  this because the real one is already the right shape.
- `cub_debug_on: true` additionally logs limit-ish text that was seen on the page
  but matched none of the patterns, which is how you find out what Claude's copy
  has changed to. It logs to the console only and stores nothing.

`node tests/run.js` covers the parsing and the estimator without a browser.

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
  stale reading never passes for a fresh one. The free-plan number is worked out
  here rather than fetched, so it is always current and never fades; its tooltip
  says which of the three readouts it is and where the figure came from.
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

On the free plan the readout is only ever as good as what Claude has said:

- **The limit notices are undocumented UI.** If Claude rewords them, the patterns
  in `estimate.js` stop matching and the bar falls back to the message count. It
  degrades to less information, never to a wrong number.
- **The free cap moves with demand,** so a figure Claude gave in one window is not
  a promise about the next. A figure stated during the window in progress is used
  directly; older ones are used only as a median, are dropped after 30 days, and
  give the weaker `estimated` reading. This is why the bar is hatched and prefixed
  `~`.
- **The cost model approximates tokens from characters.** It is systematically off
  for code, which is denser than prose, and it is blind to how large an image or
  an uploaded file actually is — an upload can cost more than everything else in
  the window and the extension cannot see it. The burn-rate comparison it supports
  is trustworthy well before the absolute percentage is, because a ratio between
  two numbers computed the same way survives both of them being off.
- **"At this pace" means the last three sends.** A conversation that is about to
  get much longer, or one you are about to abandon for a fresh chat, will not
  match it. It answers "if I carry on exactly like this", which is the useful
  question, not a prediction.
- **The count is per browser profile.** Messages sent from the phone app, or from
  another browser, are invisible to it, which makes it a floor rather than a
  total. A figure from Claude is the only thing that corrects for this, because it
  comes from Claude and so covers every device.
- **A window the extension did not watch from the start gets no bar.** Installing
  mid-window, or the browser being shut for part of one, means the count has a
  hole in it; see the rule above. The reading shown is "5 left" rather than a
  percentage that would be wrong in the alarming direction.
- **Free accounts get the session row only.** Claude publishes no weekly figure
  for them and there is no way to infer one from messages, so the weekly and Opus
  rows stay hidden rather than being filled with something invented.

Because a free account is only re-checked once a day, upgrading can take up to a
day to turn into real bars on its own. Opening the popup and clicking Refresh
checks straight away.

## License

MIT license, see `LICENSE`.
