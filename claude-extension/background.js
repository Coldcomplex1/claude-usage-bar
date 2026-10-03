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
// A full limit shows the time until it resets instead of "100".
//
// The icon's right-click menu adds Refresh now and the dashboard.
//
// The content script reacts to the cub_enabled storage change to show/hide the bar.

importScripts("usage.js", "session.js", "history.js", "alerts.js");   // classic service worker: CUB, CUBS, CUBH, CUBA

var TOGGLE_KEY = "cub_enabled";
var LAST_KEY = "cub_last";
var BADGE_KEY = "cub_badge";
var SETUP_KEY = "cub_setup";     // first-run chooser: { done, at } once answered
var FREE_KEY = "cub_free_session";  // free plan: locally counted sends (session.js)
var HEALTH_KEY = "cub_health";   // refresh bookkeeping/backoff; nothing renders it
var PREFS_KEY = "cub_prefs";     // colour thresholds, among others (Settings)
var DEFAULT_BADGE = { enabled: false, source: "session" };

var ALARM = "cub-refresh";
var PERIOD_MIN = 5;                        // how often we refresh in the background
var FRESH_MS = 4 * 60 * 1000;              // someone refreshed this recently: skip
var TAB_TIMEOUT_MS = 15000;                // a frozen tab must not stall the run
var MAX_BACKOFF_MS = 30 * 60 * 1000;
var DIRECT_BLOCK_MS = 6 * 60 * 60 * 1000;  // how long to stop fetching from here after 403s
var refreshing = false;                    // reentrancy guard, per worker lifetime

// Colors match the in-page bar in content.css: blue, then Claude orange, then
// red, at the thresholds Settings sets (30% and 80% unless changed).
var BADGE_LOW = "#378add", BADGE_MID = "#d85a30", BADGE_HIGH = "#e2564d";
function badgeColor(pct, prefs){
  var lv = CUB.colorLevel(pct, prefs);
  return lv === "high" ? BADGE_HIGH : lv === "mid" ? BADGE_MID : BADGE_LOW;
}

// A free account has no percentage to show, so the badge carries the counted
// message total instead, in the neutral colour: a count is not 0-100, and
// running it through the usage thresholds would read as a warning it is not.
function isFree(data){ return !!data && data.reported === false; }

// The limit the chosen source is about, or null when the reading has none.
//   session / allModels   that window
//   highest               the higher of those two (the original choice)
//   tightest              the fullest of every limit, per-model ones included
function badgeLimit(data, source){
  var limits = CUB.limitsOf(data);
  function byId(id){ for (var i = 0; i < limits.length; i++) if (limits[i].id === id) return limits[i]; return null; }
  if (source === "session") return byId("session");
  if (source === "allModels") return byId("allModels");
  if (source === "highest"){
    var s = byId("session"), a = byId("allModels");
    if (!s) return a;
    if (!a) return s;
    return a.pct > s.pct ? a : s;
  }
  if (source === "tightest") return CUB.tightest(limits);
  return null;
}

// The spend, badge-sized: "$12". Red at the cap, orange while a full limit
// bills to it, otherwise coloured against the cap (blue when there is none).
function creditsBadge(c, data, prefs){
  var color = c.capReached ? BADGE_HIGH : CUB.creditsInUse(data) ? BADGE_MID
            : c.limit ? badgeColor(c.pct, prefs) : BADGE_LOW;
  return { text: CUB.fmtShortMoney(c.used, c.currency) || "$0", color: color };
}

// { text, color } for the badge, or null to leave it blank. A source the
// reading has nothing for (no session on a spend-only account, say) falls back
// to the tightest limit, then to the spend, rather than going blank.
function badgeFor(data, badge, prefs, now){
  if (!data) return null;
  if (badge.source === "credits" && data.credits) return creditsBadge(data.credits, data, prefs);
  var l = badgeLimit(data, badge.source) || CUB.tightest(CUB.limitsOf(data));
  if (!l) return data.credits ? creditsBadge(data.credits, data, prefs) : null;
  var pct = Math.max(0, Math.min(100, Math.round(l.pct)));
  // Full: the number that matters now is how long until it refills.
  if (pct >= 100 && l.resetAt){
    var left = new Date(l.resetAt).getTime() - now;
    if (left > 0) return { text: CUB.fmtShortSpan(left), color: BADGE_HIGH };
  }
  return { text: String(pct), color: badgeColor(pct, prefs) };
}

function clearBadge(){ chrome.action.setBadgeText({ text: "" }); }

function renderBadge(enabled, badge, data, free, prefs){
  if (enabled === false || !badge.enabled) return clearBadge();
  var text, color;
  if (isFree(data)){
    if (!free || !free.count) return clearBadge();
    text = String(free.count); color = BADGE_LOW;
  } else {
    var b = badgeFor(data, badge, prefs, Date.now());
    if (!b) return clearBadge();
    text = b.text; color = b.color;
  }
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: color });
  // Guarded: setBadgeTextColor is Chrome 110+; older Chromium forks fall back
  // to auto-contrast, which is still legible on these backgrounds.
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#ffffff" });
}

// The icon's hover text carries the full readout, so the whole thing can be read
// without opening anything. The badge only has room for one number; this has room
// for every limit, their countdowns, the extra-usage spend, and how old the
// reading is.
function titleFor(data, free){
  var base = "Claude Usage Bar";
  if (!data) return base;
  if (data.tier) base += " \u00b7 " + data.tier;
  if (isFree(data)){
    var left = free && free.resetAt ? CUB.fmtReset(free.resetAt) : "";
    var n = (free && free.count) || 0;
    return base + "\nSession (5h): " + n + (n === 1 ? " message" : " messages") + " counted" +
      (left ? " \u00b7 resets in " + left : "") +
      "\nClaude reports no usage percentage on the free plan." +
      // Not "Updated": the count above is live, and this timestamp dates only the
      // once-a-day check for a percentage, which is hours old by design.
      (data.fetchedAt ? "\nChecked " + CUB.fmtAgo(data.fetchedAt) : "");
  }
  var lines = [];
  CUB.limitsOf(data).forEach(function (l){
    var pct = Math.round(l.pct);
    var left = pct > 0 ? CUB.fmtReset(l.resetAt) : "";
    lines.push(l.label + (l.sub ? " (" + l.sub + ")" : "") + ": " + pct + "%" + (left ? " \u00b7 resets in " + left : ""));
  });
  var c = data.credits;
  if (c){
    lines.push((c.label || "Extra usage") + ": " + CUB.fmtMoney(c.used, c.currency) +
      (c.limit ? " of " + CUB.fmtMoney(c.limit, c.currency, true) : "") +
      (!c.enabled ? " (off)" : c.capReached ? " (cap reached)" : CUB.creditsInUse(data) ? " (in use)" : ""));
  }
  if (!lines.length) return base;
  if (data.fetchedAt) lines.push("Updated " + CUB.fmtAgo(data.fetchedAt));
  return base + "\n" + lines.join("\n");
}

function refreshBadge(){
  chrome.storage.local.get([TOGGLE_KEY, LAST_KEY, BADGE_KEY, FREE_KEY, PREFS_KEY], function (o){
    var badge = Object.assign({}, DEFAULT_BADGE, o[BADGE_KEY] || {});
    var free = CUBS.summarize(o[FREE_KEY]);
    renderBadge(o[TOGGLE_KEY] !== false, badge, o[LAST_KEY], free, o[PREFS_KEY] || {});
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

// ---- Every new reading -----------------------------------------------------
// This worker is the one place that sees every reading land, whichever surface
// fetched it, so it is the one writer of the history (history.js): readings
// are recorded one at a time, in the order they arrive, on a single chain.
// A failure is logged and dropped; the next reading starts a fresh link.
// The same chain then decides whether the reading is worth an alert.
var pipeline = Promise.resolve();
function onReading(result){
  pipeline = pipeline.then(function (){ return CUBH.record(result); })
    .catch(function (e){ try { console.debug("[Claude Usage Bar] history", e); } catch (e2) {} })
    .then(function (){ return checkAlerts(result); })
    .catch(function (e){ try { console.debug("[Claude Usage Bar] alerts", e); } catch (e2) {} });
  return pipeline;
}

// New usage numbers (cub_last), a master-toggle flip, or a badge-settings change
// all wake the service worker here and repaint the badge.
chrome.storage.onChanged.addListener(function (changes, area){
  if (area !== "local") return;
  if (changes[LAST_KEY] || changes[TOGGLE_KEY] || changes[BADGE_KEY] || changes[FREE_KEY] || changes[PREFS_KEY]) refreshBadge();
  if (changes[LAST_KEY] && changes[LAST_KEY].newValue) onReading(changes[LAST_KEY].newValue);
  // Alerts switched off: the pending reset reminders go with them.
  if (changes[CUBA.SETTINGS_KEY] && !CUBA.settingsOf(changes[CUBA.SETTINGS_KEY].newValue).on) clearResetAlarms();
});

// ---- Alerts --------------------------------------------------------------------
// Off until the user turns them on. Delivered as a desktop notification when
// the user allowed those (the permission is optional and asked for only when
// they switch it on in Settings), otherwise as cub_notice, which every visible
// claude.ai tab shows as a toast.

function hasNotifications(){
  return new Promise(function (r){
    try { chrome.permissions.contains({ permissions: ["notifications"] }, function (ok){ r(!!ok && !!chrome.notifications); }); }
    catch (e){ r(false); }
  });
}

async function deliver(alerts){
  var note = CUBA.combine(alerts);
  if (!note) return null;
  var settings = CUBA.settingsOf((await sget([CUBA.SETTINGS_KEY]))[CUBA.SETTINGS_KEY]);
  if (settings.desktop && await hasNotifications()){
    wireNotificationClicks();
    chrome.notifications.create("cub-" + Date.now(), {
      type: "basic", iconUrl: "icons/icon128.png", title: note.title, message: note.message, priority: 1
    });
    return "desktop";
  }
  await sset({ [CUBA.NOTICE_KEY]: { id: Date.now() + "-" + Math.random().toString(36).slice(2), title: note.title,
                                    message: note.message, at: Date.now() } });
  return "page";
}

async function checkAlerts(result){
  var st = await sget([CUBA.SETTINGS_KEY, CUBA.STATE_KEY]);
  var settings = CUBA.settingsOf(st[CUBA.SETTINGS_KEY]);
  if (!settings.on) return;
  var out = CUBA.evaluate(result, settings, st[CUBA.STATE_KEY], Date.now());
  if (JSON.stringify(out.state) !== JSON.stringify(st[CUBA.STATE_KEY] || {})) await sset({ [CUBA.STATE_KEY]: out.state });
  out.resets.forEach(scheduleReset);
  await deliver(out.alerts);
}

// One alarm per limit, at the moment it resets. Only (re)created when missing
// or moved, since this runs on every reading.
function scheduleReset(r){
  var name = CUBA.RESET_ALARM + r.id;
  chrome.alarms.get(name, function (a){
    if (a && Math.abs(a.scheduledTime - r.when) < 60000) return;
    chrome.alarms.create(name, { when: r.when + 15000 });
  });
}

function clearResetAlarms(){
  chrome.alarms.getAll(function (all){
    (all || []).forEach(function (a){ if (a.name.indexOf(CUBA.RESET_ALARM) === 0) chrome.alarms.clear(a.name); });
  });
}

async function onResetAlarm(alarm){
  var id = alarm.name.slice(CUBA.RESET_ALARM.length);
  var st = await sget([CUBA.SETTINGS_KEY, CUBA.STATE_KEY]);
  var out = CUBA.onReset(id, alarm.scheduledTime, st[CUBA.SETTINGS_KEY], st[CUBA.STATE_KEY], Date.now());
  if (!out.alert) return;
  await sset({ [CUBA.STATE_KEY]: out.state });
  await deliver([out.alert]);
}

// A click on a desktop notification brings claude.ai forward, or opens it.
var notificationClicksWired = false;
function wireNotificationClicks(){
  if (notificationClicksWired || !chrome.notifications || !chrome.notifications.onClicked) return;
  notificationClicksWired = true;
  chrome.notifications.onClicked.addListener(function (nid){
    if (nid.indexOf("cub-") !== 0) return;
    chrome.notifications.clear(nid);
    claudeTabs().then(function (tabs){
      if (tabs.length){
        chrome.tabs.update(tabs[0].id, { active: true });
        if (tabs[0].windowId != null) chrome.windows.update(tabs[0].windowId, { focused: true });
      } else chrome.tabs.create({ url: "https://claude.ai/" });
    });
  });
}
// Registered at start-up whenever the permission is already there, so a click
// on a notification still lands after the worker has been put to sleep.
wireNotificationClicks();
if (chrome.permissions && chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(wireNotificationClicks);

// Settings' "Send a test alert".
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse){
  if (!msg || msg.type !== "cub:test-alert") return;
  deliver([{ title: "Claude Usage Bar alert", message: "This is how an alert will look. Session at 80% \u00b7 resets in 1h 12m." }])
    .then(function (via){ sendResponse({ ok: true, via: via }); }, function (){ sendResponse({ ok: false }); });
  return true;
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
  // "Refresh usage now" from the icon's menu: the user asked, so none of the
  // reasons to skip a scheduled run apply. The 403 block below still does --
  // it exists to stop poking bot protection, asked or not.
  var manual = reason === "manual";
  try {
    var st = await sget([TOGGLE_KEY, LAST_KEY, HEALTH_KEY]);
    if (st[TOGGLE_KEY] === false && !manual) return;      // master off: the badge is hidden anyway
    var h = st[HEALTH_KEY] || {};
    if (reason === "alarm" && h.nextAttemptAt && Date.now() < h.nextAttemptAt) return;

    var last = st[LAST_KEY];
    // Free plan: one check a day, not one every five minutes. Ahead of the
    // freshness test on purpose -- a day-old reading is no evidence the session
    // still works, so it must not clear the backoff below either.
    if (CUB.freeHold(last) && !manual) return;
    if (!manual && last && last.fetchedAt && Date.now() - last.fetchedAt < FRESH_MS){
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

chrome.alarms.onAlarm.addListener(function (a){
  // The badge repaints too, so a "2h" countdown on a full limit stays true
  // even when no new reading arrives to prompt it.
  if (a.name === ALARM){ refreshBadge(); doRefresh("alarm"); }
  else if (a.name.indexOf(CUBA.RESET_ALARM) === 0) onResetAlarm(a);
});

// ---- The icon's right-click menu -------------------------------------------

var MENU = [
  { id: "cub-refresh", title: "Refresh usage now" },
  { id: "cub-dashboard", title: "Open usage dashboard" }
];

// Menu items outlive the worker, so they are made once per install or update
// (cleared first, since creating an id that exists is an error).
function createMenus(){
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(function (){
    MENU.forEach(function (m){ chrome.contextMenus.create({ id: m.id, title: m.title, contexts: ["action"] }); });
  });
}

if (chrome.contextMenus) chrome.contextMenus.onClicked.addListener(function (info){
  if (info.menuItemId === "cub-refresh") doRefresh("manual");
  else if (info.menuItemId === "cub-dashboard") chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

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

chrome.runtime.onInstalled.addListener(function (details){
  refreshBadge(); ensureAlarm(); createMenus(); doRefresh("install");
  openSetupIfNeeded(details);
});
chrome.runtime.onStartup.addListener(function (){ refreshBadge(); ensureAlarm(); doRefresh("startup"); });

// And whenever the service worker first spins up with data already in storage.
// ensureAlarm is safe here only because it is guarded; doRefresh is not, and
// must never run at top level: this worker wakes on its own cub_last write.
refreshBadge();
ensureAlarm();
