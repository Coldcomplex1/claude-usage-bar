// alerts.js: deciding when to speak up. Off until the user turns it on
// (Settings, or the popup's one-click switch); then:
//   - a limit crossing one of the chosen thresholds (80% and 95% by default),
//     once per window, naming the highest one crossed;
//   - a limit the user was close to resetting, at the moment it resets;
//   - extra usage starting to bill, crossing the same thresholds of its
//     monthly cap, and reaching the cap.
//
// evaluate() is a pure function of (reading, settings, what was already said,
// now): the service worker calls it on every new reading, stores the state it
// hands back, schedules the reset alarms it lists, and delivers the alerts --
// as a desktop notification when the user allowed those, otherwise as a toast
// on claude.ai (content.js). Nothing here touches the network.

var CUBA = (function () {
  var SETTINGS_KEY = "cub_alerts";
  var STATE_KEY = "cub_alert_state";
  var NOTICE_KEY = "cub_notice";
  var RESET_ALARM = "cub-reset|";
  var DEFAULTS = { on: false, at: [80, 95], resets: true, credits: true, desktop: false };
  var CHOICES = [50, 75, 80, 90, 95, 100];
  var DAY = 24 * 60 * 60 * 1000;
  var LATE_MS = 30 * 60 * 1000;    // a reset alarm firing later than this is old news

  function settingsOf(v){
    var s = Object.assign({}, DEFAULTS, v && typeof v === "object" ? v : {});
    var at = Array.isArray(s.at) ? s.at : DEFAULTS.at;
    s.at = at.map(Number).filter(function(n){ return n >= 1 && n <= 100; })
             .sort(function(a, b){ return a - b; })
             .filter(function(n, i, all){ return all.indexOf(n) === i; });
    return s;
  }

  function nameOf(l){ return l.label + (l.group === "session" ? " (5h)" : l.group === "weekly" ? " (7d)" : ""); }

  function resetLine(iso){
    if (!iso) return "";
    var when = CUB.fmtResetAt(iso);
    return "Resets in " + CUB.fmtReset(iso) + (when ? " (" + when + ")" : "") + ".";
  }

  function limitAlert(l, result){
    var pct = Math.round(l.pct), full = pct >= 100;
    var c = result.credits;
    var msg = full ? "Limit reached. " + resetLine(l.resetAt) : resetLine(l.resetAt);
    if (full && c && c.enabled && !c.capReached) msg += " Extra usage is on, so you can keep going at API rates.";
    return { key: "limit:" + l.id, title: nameOf(l) + " at " + pct + "%", message: msg.trim() };
  }

  function money(v, c){ return CUB.fmtMoney(v, c.currency); }

  // ---- The decision ----------------------------------------------------------
  // state: { at, w:{ <id>: { r, fired, peak, label, group, told } }, inUse, cap, cpct }
  //   r      the window (its reset time) the entry is about; a new one re-arms
  //   fired  the highest threshold already announced in that window
  //   peak   how high the window got, which decides whether its reset is news
  //   told   the window whose reset was already announced
  function evaluate(result, settings, state, now){
    settings = settingsOf(settings);
    var next = JSON.parse(JSON.stringify(state && typeof state === "object" ? state : {}));
    next.w = next.w || {};
    var out = { alerts: [], state: next, resets: [] };
    if (!settings.on || !result || result.reported === false) return out;
    // A slower fetch landing after a newer one says nothing new, and an older
    // window coming back would re-arm alerts that were already given.
    var at = result.fetchedAt || now;
    if (next.at && at <= next.at) return out;
    next.at = at;

    var min = settings.at.length ? settings.at[0] : 100;
    CUB.limitsOf(result).forEach(function(l){
      var e = next.w[l.id];
      if (!e || e.r !== (l.resetAt || null)) e = next.w[l.id] = { r: l.resetAt || null, fired: 0, peak: 0 };
      e.label = l.label; e.group = l.group;
      e.peak = Math.max(e.peak, l.pct);
      var crossed = settings.at.filter(function(t){ return l.pct >= t && t > e.fired; });
      if (crossed.length){
        e.fired = crossed[crossed.length - 1];
        out.alerts.push(limitAlert(l, result));
      }
      if (settings.resets && l.resetAt && e.peak >= min && e.told !== e.r){
        var when = new Date(l.resetAt).getTime();
        if (when > now) out.resets.push({ id: l.id, when: when });
      }
    });
    // Windows long gone are forgotten, so the state cannot grow without bound.
    Object.keys(next.w).forEach(function(id){
      var r = next.w[id].r ? new Date(next.w[id].r).getTime() : 0;
      if (r && r < now - 7 * DAY) delete next.w[id];
    });

    var c = result.credits;
    if (settings.credits){
      var inUse = CUB.creditsInUse(result);
      if (inUse && !next.inUse){
        out.alerts.push({ key: "credits", title: "Now using extra usage",
          message: "A limit is full, so what you send is billed at API rates. " + money(c.used, c) + " spent so far" +
                   (c.limit ? " of your " + CUB.fmtMoney(c.limit, c.currency, true) + " cap." : ".") });
      }
      next.inUse = inUse;
      var cap = !!(c && c.capReached);
      if (cap && !next.cap){
        out.alerts.push({ key: "cap", title: "Extra usage cap reached",
          message: money(c.used, c) + (c.limit ? " of your " + CUB.fmtMoney(c.limit, c.currency, true) + " monthly cap" : "") +
                   " spent. Extra usage is paused until the cap resets." });
      }
      next.cap = cap;
      if (c && c.limit && c.pct != null && !cap){
        if (next.cpct && c.pct + 10 < next.cpct) next.cpct = 0;     // a new month started
        var crossedC = settings.at.filter(function(t){ return t < 100 && c.pct >= t && t > (next.cpct || 0); });
        if (crossedC.length){
          next.cpct = crossedC[crossedC.length - 1];
          out.alerts.push({ key: "credits-pct", title: "Extra usage at " + Math.round(c.pct) + "% of the cap",
            message: money(c.used, c) + " of your " + CUB.fmtMoney(c.limit, c.currency, true) + " monthly cap spent." });
        }
      }
    }
    return out;
  }

  // The reset alarm for a limit went off. Returns the alert to give, and the
  // state to keep, or no alert when it is not news: alerts off, the window was
  // never close, it was already announced, or the alarm is far too late.
  function onReset(id, scheduled, settings, state, now){
    settings = settingsOf(settings);
    var next = JSON.parse(JSON.stringify(state && typeof state === "object" ? state : {}));
    next.w = next.w || {};
    var e = next.w[id];
    if (!settings.on || !settings.resets || !e || e.told === e.r) return { alert: null, state: next };
    if (now - scheduled > LATE_MS) return { alert: null, state: next };
    e.told = e.r;
    var what = e.group === "session" ? "Your 5-hour session is fresh again." : e.group === "weekly" ? "Your weekly allowance for it is fresh again." : "It is fresh again.";
    return { alert: { key: "reset:" + id, title: (e.label || "Usage") + " limit has reset", message: what }, state: next };
  }

  // Several at once become one notice rather than a stack of them.
  function combine(alerts){
    if (!alerts.length) return null;
    if (alerts.length === 1) return { title: alerts[0].title, message: alerts[0].message };
    return { title: "Claude usage", message: alerts.map(function(a){ return a.title; }).join(" · ") };
  }

  return { SETTINGS_KEY: SETTINGS_KEY, STATE_KEY: STATE_KEY, NOTICE_KEY: NOTICE_KEY, RESET_ALARM: RESET_ALARM,
           DEFAULTS: DEFAULTS, CHOICES: CHOICES, LATE_MS: LATE_MS,
           settingsOf: settingsOf, evaluate: evaluate, onReset: onReset, combine: combine };
})();
