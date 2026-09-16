// background.js: keyboard shortcut + toolbar-icon badge + background refresh.
//
// Background refresh: the content script only polls while a claude.ai tab is
// open AND visible, so with no tab around the numbers froze and the badge went
// stale. A chrome.alarms heartbeat now refreshes them every few minutes,
// preferring to delegate the fetch to an open tab (same-origin there) and
// falling back to fetching from this worker when there is no tab to ask.
//
// Badge: mirrors one usage window onto the extension icon, colored the same as
// the in-page bar, so the user can read their usage at a glance without opening
// the popup or a claude.ai tab. Which window (and whether the badge shows at
// all) is configured on the Settings page and stored in cub_badge; the numbers
// come from cub_last, written by the content script and popup. Off by default.
//
// The content script reacts to the cub_enabled storage change to show/hide the bar.

// classic service worker: CUB.getUsage(), CUBS.summarize(), CUBE.estimate()
importScripts("usage.js", "session.js", "estimate.js");

var TOGGLE_KEY = "cub_enabled";
var LAST_KEY = "cub_last";
var BADGE_KEY = "cub_badge";
var SETUP_KEY = "cub_setup";     // first-run chooser: { done, at } once answered
var FREE_KEY = "cub_free_session";  // free plan: locally counted sends (session.js)
var CALIB_KEY = "cub_free_calib";   // free plan: what Claude has told us (estimate.js)
var INSTALL_KEY = "cub_installed_at";
var HEALTH_KEY = "cub_health";   // refresh bookkeeping/backoff; nothing renders it
var DEFAULT_BADGE = { enabled: false, source: "session" };

var ALARM = "cub-refresh";
var PERIOD_MIN = 5;                        // how often we refresh in the background
var FRESH_MS = 4 * 60 * 1000;              // someone refreshed this recently: skip
var TAB_TIMEOUT_MS = 15000;                // a frozen tab must not stall the run
var MAX_BACKOFF_MS = 30 * 60 * 1000;
var DIRECT_BLOCK_MS = 6 * 60 * 60 * 1000;  // how long to stop fetching from here after 403s
var refreshing = false;                    // reentrancy guard, per worker lifetime

// Thresholds/colors match the in-page bar in content.css: blue < 30%,
// Claude orange 30–80%, red > 80%.
var BADGE_LOW = "#378add", BADGE_MID = "#d85a30", BADGE_HIGH = "#e2564d";
function badgeColor(pct){ return pct > 80 ? BADGE_HIGH : pct >= 30 ? BADGE_MID : BADGE_LOW; }

function winPct(m){ return (m && m.available && m.pct != null) ? Math.round(m.pct) : null; }

// A free account gets no percentage from Claude's endpoint, so the badge carries
// whichever of the two the free readout has: a percentage once Claude's own
// interface has stated a figure we could calibrate against (estimate.js), and
// until then the counted message total in the neutral colour -- a count is not
// 0-100, and running it through the usage thresholds would read as a warning it
// is not.
function isFree(data){ return !!data && data.reported === false; }

// The % the badge should show for the chosen source, or null if unavailable.
function badgePct(data, source){
  if (!data) return null;
  if (source === "session") return winPct(data.session);
  if (source === "allModels") return winPct(data.allModels);
  // "highest": whichever of session / all-models we have data for.
  var s = winPct(data.session), a = winPct(data.allModels);
  if (s == null) return a;
  if (a == null) return s;
  return Math.max(s, a);
}

function clearBadge(){ chrome.action.setBadgeText({ text: "" }); }

function renderBadge(enabled, badge, data, free){
  if (enabled === false || !badge.enabled) return clearBadge();
  var text, color;
  if (isFree(data)){
    if (!free) return clearBadge();
    if (free.pct != null){
      // The "~" is not decoration. A badge has room for about four characters
      // and none for the difference between a figure Claude published and one
      // worked out from what it said, so it stays conservative on both.
      var fp = Math.round(free.pct);
      text = (free.exact ? "" : "~") + fp; color = badgeColor(fp);
    } else if (free.left != null){
      // Claude's own count of what is left. Not a percentage, so not run through
      // the usage thresholds -- except at zero, which is worth the red.
      text = String(free.left); color = free.left === 0 ? BADGE_HIGH : BADGE_LOW;
    } else {
      if (!free.count) return clearBadge();
      text = String(free.count); color = BADGE_LOW;
    }
  } else {
    var pct = badgePct(data, badge.source);
    if (pct == null) return clearBadge();
    pct = Math.max(0, Math.min(100, pct));
    text = String(pct); color = badgeColor(pct);
  }
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: color });
  // Guarded: setBadgeTextColor is Chrome 110+; older Chromium forks fall back
  // to auto-contrast, which is still legible on these backgrounds.
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#ffffff" });
}

// The icon's hover text carries the full readout, so the whole thing can be read
// without opening anything. The badge only has room for one number; this has room
// for all three windows, their countdowns, and how old the reading is.
function titleFor(data, free){
  var base = "Claude Usage Bar";
  if (!data) return base;
  if (isFree(data)){
    var left = free && free.resetAt ? CUB.fmtReset(free.resetAt) : "";
    var n = (free && free.count) || 0;
    var head, why;
    if (free && free.exact){
      head = "\nSession (5h): out of messages for this window";
      why = "Claude said so directly. This one is not an estimate.";
    } else if (free && free.pct != null){
      head = "\nSession (5h): " + Math.round(free.pct) + "% used" +
             (free.left != null ? " \u00b7 about " + free.left + " left" : "");
      why = "Claude publishes no percentage on the free plan; this is worked out from what it told you.";
    } else if (free && free.left != null){
      head = "\nSession (5h): " + free.left + (free.left === 1 ? " message" : " messages") + " left";
      why = "Claude's own figure. It says nothing about the total, so there is no percentage to show.";
    } else {
      head = "\nSession (5h): " + n + (n === 1 ? " message" : " messages") + " counted";
      why = "Claude reports no usage percentage on the free plan.";
    }
    return base + head +
      (left ? " \u00b7 resets in " + left : "") + "\n" + why +
      // Not "Updated": the readout above is live, and this timestamp dates only
      // the once-a-day check for a percentage, which is hours old by design.
      (data.fetchedAt ? "\nChecked " + CUB.fmtAgo(data.fetchedAt) : "");
  }
  var lines = [];
  [["Session (5h)", data.session], ["All models (7d)", data.allModels], ["Opus (7d)", data.opus]]
    .forEach(function (pair){
      var pct = winPct(pair[1]);
      if (pct == null) return;
      var left = pct > 0 ? CUB.fmtReset(pair[1].resetAt) : "";
      lines.push(pair[0] + ": " + pct + "%" + (left ? " · resets in " + left : ""));
    });
  if (!lines.length) return base;
  if (data.fetchedAt) lines.push("Updated " + CUB.fmtAgo(data.fetchedAt));
  return base + "\n" + lines.join("\n");
}

function refreshBadge(){
  chrome.storage.local.get([TOGGLE_KEY, LAST_KEY, BADGE_KEY, FREE_KEY, CALIB_KEY], function (o){
    var badge = Object.assign({}, DEFAULT_BADGE, o[BADGE_KEY] || {});
    // The free readout: what we counted, plus whatever Claude has told us about
    // the limit. With nothing to calibrate against this is the count as before.
    var free = CUBE.estimate(CUBS.summarize(o[FREE_KEY]), o[CALIB_KEY]);
    renderBadge(o[TOGGLE_KEY] !== false, badge, o[LAST_KEY], free);
    chrome.action.setTitle({ title: titleFor(o[LAST_KEY], free) });
  });
}

chrome.commands.onCommand.addListener(function (command) {
  if (command !== "toggle-bar") return;
  chrome.storage.local.get([TOGGLE_KEY], function (o) {
    var currentlyOn = o[TOGGLE_KEY] !== false; // default on
    chrome.storage.local.set({ [TOGGLE_KEY]: !currentlyOn });
  });
});

// New usage numbers (cub_last), a master-toggle flip, or a badge-settings change
// all wake the service worker here and repaint the badge.
chrome.storage.onChanged.addListener(function (changes, area){
  if (area !== "local") return;
  if (changes[LAST_KEY] || changes[TOGGLE_KEY] || changes[BADGE_KEY] ||
      changes[FREE_KEY] || changes[CALIB_KEY]) refreshBadge();
});

// ---- Background refresh --------------------------------------------------

function sget(keys){ return new Promise(function (r){ chrome.storage.local.get(keys, r); }); }
function sset(o){ return new Promise(function (r){ chrome.storage.local.set(o, r); }); }

// Create the alarm only when it is missing. This worker wakes on every cub_last
// write, which a visible claude.ai tab does once a minute; an unguarded create()
// would reset the schedule on each wake and the alarm would never fire at all.
function ensureAlarm(){
  chrome.alarms.get(ALARM, function (a){
    if (!a) chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN, delayInMinutes: 1 });
  });
}

// claude.ai tabs we can actually message, most-likely-alive first. Discarded
// tabs have no content script. Filtering by url needs host permissions, which
// we already have for claude.ai, so this costs no extra permission warning.
function claudeTabs(){
  return new Promise(function (resolve){
    chrome.tabs.query({ url: "https://claude.ai/*" }, function (tabs){
      if (chrome.runtime.lastError || !tabs) return resolve([]);
      resolve(tabs.filter(function (t){ return t.id != null && !t.discarded; })
                  .sort(function (a, b){ return (b.active ? 1 : 0) - (a.active ? 1 : 0); }));
    });
  });
}

// Never rejects. Covers a tab with no content script (the extension was reloaded
// but the tab was not), a tab that never answers, and ordinary success/failure.
function askTab(tabId){
  return new Promise(function (resolve){
    var settled = false;
    var timer = setTimeout(function (){
      if (!settled){ settled = true; resolve({ ok: false, code: "TIMEOUT" }); }
    }, TAB_TIMEOUT_MS);
    function done(r){ if (settled) return; settled = true; clearTimeout(timer); resolve(r); }
    try {
      chrome.tabs.sendMessage(tabId, { type: "cub:refresh", reason: "alarm" }, function (resp){
        if (chrome.runtime.lastError) return done({ ok: false, code: "NO_RECEIVER" });
        done(resp || { ok: false, code: "NO_RESPONSE" });
      });
    } catch (e){ done({ ok: false, code: "THREW" }); }
  });
}

function noteOk(){
  var now = Date.now();
  return sset({ [HEALTH_KEY]: { lastOkAt: now, lastTryAt: now, fails: 0, lastError: null,
                                nextAttemptAt: 0, direct403: 0, directBlockedUntil: 0 } });
}

function noteFail(h, e){
  var fails = (h.fails || 0) + 1;
  var backoff = Math.min(MAX_BACKOFF_MS, PERIOD_MIN * 60 * 1000 * Math.pow(2, fails - 1));
  var status = (e && e.status) || 0;
  // usage.js reports both 401 and 403 as code "AUTH", so branch on the status:
  // 401 means logged out, but a 403 on a request from this origin smells like
  // bot protection, and repeatedly poking it is exactly what we should not do.
  var d403 = status === 403 ? (h.direct403 || 0) + 1 : 0;
  return sset({ [HEALTH_KEY]: Object.assign({}, h, {
    lastTryAt: Date.now(),
    fails: fails,
    lastError: { code: (e && e.code) || "ERR", status: status },
    nextAttemptAt: Date.now() + backoff,
    direct403: d403,
    directBlockedUntil: d403 >= 3 ? Date.now() + DIRECT_BLOCK_MS : (h.directBlockedUntil || 0)
  }) });
}

async function doRefresh(reason){
  if (refreshing) return;
  refreshing = true;
  try {
    var st = await sget([TOGGLE_KEY, LAST_KEY, HEALTH_KEY]);
    if (st[TOGGLE_KEY] === false) return;      // master off: the badge is hidden anyway
    var h = st[HEALTH_KEY] || {};
    if (reason === "alarm" && h.nextAttemptAt && Date.now() < h.nextAttemptAt) return;

    var last = st[LAST_KEY];
    // Free plan: one check a day, not one every five minutes. Ahead of the
    // freshness test on purpose -- a day-old reading is no evidence the session
    // still works, so it must not clear the backoff below either.
    if (CUB.freeHold(last)) return;
    if (last && last.fetchedAt && Date.now() - last.fetchedAt < FRESH_MS){
      // A visible tab or the popup just refreshed. Nothing to do, and the fact
      // that it worked means the session is fine, so drop any backoff.
      if (h.fails) await noteOk();
      return;
    }

    var tabs = await claudeTabs();
    for (var i = 0; i < tabs.length && i < 3; i++){
      var r = await askTab(tabs[i].id);
      if (r && r.ok){ await noteOk(); return; }   // the tab wrote cub_last for us
    }

    if (h.directBlockedUntil && Date.now() < h.directBlockedUntil) return;
    try {
      var data = await CUB.getUsage();
      await sset({ [LAST_KEY]: data });           // fires onChanged -> refreshBadge()
      await noteOk();
    } catch (e){
      await noteFail(h, e);                       // cub_last untouched: keep last-known numbers
    }
  } catch (e){
    try { console.debug("[Claude Usage Bar] background refresh failed", e); } catch (e2) {}
  } finally { refreshing = false; }
}

chrome.alarms.onAlarm.addListener(function (a){ if (a.name === ALARM) doRefresh("alarm"); });

// ---- First run ------------------------------------------------------------

// A fresh install used to land on Design 1 with the badge off, silently, and
// most people never open Settings to discover either was a choice. So ask, in a
// tab, the moment the extension is installed.
//
// Guarded twice over: "install" excludes the update and browser-update reasons
// this same listener fires for, and cub_setup excludes a reinstall on top of a
// profile that already answered.
function openSetupIfNeeded(details){
  if (!details || details.reason !== "install") return;
  chrome.storage.local.get([SETUP_KEY], function (o){
    if (o[SETUP_KEY] && o[SETUP_KEY].done) return;
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  });
}

// When counting began. A cap learned from Claude ("5 messages left") is only a
// true cap if we watched the whole window: install midway through one and our
// count is short by whatever came before, so the cap would be biased low.
// estimate.js compares the window's start against this to tell the two apart.
//
// Written on "update" as well as "install", because this listener fires for
// both and there is no record of the original install to recover. Dating the
// clock at the upgrade is the conservative direction: the window in progress is
// treated as one we did not see the start of, and the next one to open is the
// first allowed to set a cap.
function markInstalled(){
  chrome.storage.local.get([INSTALL_KEY], function (o){
    if (typeof o[INSTALL_KEY] === "number") return;
    chrome.storage.local.set({ [INSTALL_KEY]: Date.now() });
  });
}

chrome.runtime.onInstalled.addListener(function (details){
  markInstalled();
  refreshBadge(); ensureAlarm(); doRefresh("install");
  openSetupIfNeeded(details);
});
chrome.runtime.onStartup.addListener(function (){ refreshBadge(); ensureAlarm(); doRefresh("startup"); });

// And whenever the service worker first spins up with data already in storage.
// ensureAlarm is safe here only because it is guarded; doRefresh is not, and
// must never run at top level: this worker wakes on its own cub_last write.
refreshBadge();
ensureAlarm();
