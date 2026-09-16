// usage.js: shared helpers for Claude's internal usage endpoint.
// Loaded by both the content script (same-origin on claude.ai) and the popup.
//
// Endpoints (undocumented, can change):
//   GET /api/organizations -> [{ uuid, name, capabilities:[...] }, ...]
//   GET /api/organizations/{uuid}/usage
//       -> { five_hour:{utilization:0-100,resets_at}, seven_day:{...}, seven_day_opus:{...} }
//
// Key fix vs v1: an account can belong to several orgs; we probe each org's
// usage and lock onto the one with real data/activity, and let the user override.
//
// Claude only fills those windows in for paid plans. On a free account the
// endpoint answers, but with nothing in it, which used to leave every surface
// painting "-" forever with no way to tell that apart from an outage. So a
// result now carries `reported`: false means "Claude told us nothing", and the
// free-plan readout in session.js takes over. `plan` (read from the org's
// capabilities) only ever words the message -- the presence of real windows is
// what decides which readout is shown, so an unfamiliar capability list can
// never demote a paying account to the free view.
//
// That answer is also worth holding on to. "Claude reports no usage for this
// account" does not change from minute to minute, so every surface stops asking
// for a day once it has one (freeHold, below) and checks again after that in
// case the account has been upgraded.

var CUB = (function () {
  var AUTO_KEY = "cub_org";          // {id,name,caps,ts} auto-detected
  var MANUAL_KEY = "cub_org_manual"; // user-chosen uuid (string), wins over auto
  var DEBUG_KEY = "cub_debug_on";    // opt-in: keep the raw payload in storage
  var FORCE_KEY = "cub_debug_plan";  // test hook: "free" forces the not-reported path
  var ORG_TTL_MS = 6 * 60 * 60 * 1000;
  var FREE_RECHECK_MS = 24 * 60 * 60 * 1000;  // free plan: check again once a day
  var API = "https://claude.ai/api";

  function sget(k){ return new Promise(function(r){ chrome.storage.local.get(k, r); }); }
  function sset(o){ return new Promise(function(r){ chrome.storage.local.set(o, r); }); }
  function sdel(k){ return new Promise(function(r){ chrome.storage.local.remove(k, r); }); }

  async function fetchJson(url){
    // Bounded so a hung request can't pin the service worker awake waiting for
    // TCP to give up. An abort has no .code, so callers treat it as a generic
    // failure: "!" in the bar, "Couldn't reach Claude" in the popup.
    // no-store because a cached body would read as usage that never moves.
    var res = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    // 401 is "logged out" and 403 is not: a free account, or an org the session
    // may not read, answers 403 while the login is perfectly good. They used to
    // share the AUTH code, which is why a signed-in free user was told to sign in.
    if (res.status === 401){ var a=new Error("AUTH"); a.code="AUTH"; a.status=401; throw a; }
    if (res.status === 403){ var f=new Error("FORBIDDEN"); f.code="FORBIDDEN"; f.status=403; throw f; }
    if (!res.ok){ var h=new Error("HTTP_"+res.status); h.code="HTTP"; h.status=res.status; throw h; }
    return res.json();
  }

  // ---- Reading a usage window ----------------------------------------------
  // Claude sends a percentage today. Accept the other ways the same fact can be
  // written (used/limit, remaining/limit) and the other spellings of the reset
  // key, so a renamed field degrades to a slightly-off reading rather than to a
  // blank bar -- and so a free-plan payload in some other shape is picked up.

  var FIVE_HOUR = ["five_hour", "fiveHour", "five_hour_limit", "session"];
  var SEVEN_DAY = ["seven_day", "sevenDay", "seven_day_limit", "week", "weekly"];
  var SEVEN_DAY_OPUS = ["seven_day_opus", "sevenDayOpus", "seven_day_opus_limit", "opus"];

  function pick(data, names){
    if (!data || typeof data !== "object") return null;
    for (var i = 0; i < names.length; i++){
      var v = data[names[i]];
      if (v && typeof v === "object") return v;
    }
    return null;
  }

  function num(v){
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v))) return Number(v);
    return null;
  }

  // ISO out, whatever went in: an ISO string, or epoch in seconds or ms.
  function toIso(v){
    if (v == null) return null;
    if (typeof v === "string"){
      if (isNaN(new Date(v).getTime())) return null;
      return v;
    }
    var n = num(v);
    if (n == null) return null;
    if (n < 1e11) n *= 1000;              // seconds, not milliseconds
    var d = new Date(n);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function resetOf(b){
    var keys = ["resets_at", "reset_at", "resetsAt", "resetAt", "resets_at_utc"];
    for (var i = 0; i < keys.length; i++){
      var iso = toIso(b[keys[i]]);
      if (iso) return iso;
    }
    return null;
  }

  // The percentage this window is at, or null when the payload does not say.
  function pctOf(b){
    var u = num(b.utilization);
    if (u != null) return u;
    var limit = num(b.limit != null ? b.limit : b.total);
    if (limit != null && limit > 0){
      var used = num(b.used != null ? b.used : b.usage);
      if (used != null) return (used / limit) * 100;
      var left = num(b.remaining != null ? b.remaining : b.remaining_count);
      if (left != null) return (1 - left / limit) * 100;
    }
    return null;
  }

  function readWindow(b){
    if (!b || typeof b !== "object") return { available:false, pct:null, resetAt:null };
    var pct = pctOf(b);
    if (pct == null) return { available:false, pct:null, resetAt:null };
    return { available:true, pct: Math.max(0, Math.min(100, pct)), resetAt: resetOf(b) };
  }

  // The three windows of a raw payload, in the shape the rest of the extension
  // speaks. Exported because the Settings account-picker reads raw rows too.
  function summarize(data){
    return {
      session:   readWindow(pick(data, FIVE_HOUR)),
      allModels: readWindow(pick(data, SEVEN_DAY)),
      opus:      readWindow(pick(data, SEVEN_DAY_OPUS))
    };
  }

  function anyWindow(s){ return !!(s.session.available || s.allModels.available || s.opus.available); }
  function maxUtil(s){
    return Math.max.apply(null, [s.session, s.allModels, s.opus]
      .map(function(w){ return w.available ? w.pct : -1; }).concat(-1));
  }

  // Should this reading be reused instead of going to the network? True only for
  // a free account inside the day since it was last checked. Every surface calls
  // this from the freshness gate it already had, so one rule covers the tab poll,
  // the background alarm, the popup and the Settings page.
  //
  // It is armed by a stored result and nothing else, which is what keeps a failed
  // request from counting as the day's check: a fetch that throws never writes
  // cub_last, so an outage (or a logged-out moment) leaves the normal retry and
  // backoff in charge and can never park a paying account on the free readout.
  function freeHold(last){
    return !!last && last.reported === false && !!last.fetchedAt &&
           (Date.now() - last.fetchedAt) < FREE_RECHECK_MS;
  }

  // ---- Plan ----------------------------------------------------------------
  // Wording only. Which readout appears is decided by whether real windows came
  // back, never by this, so an unrecognised capability list is harmless.
  function planFromCaps(caps){
    if (!Array.isArray(caps)) return "unknown";
    function has(c){ return caps.indexOf(c) !== -1; }
    if (has("claude_max")) return "max";
    if (has("claude_pro")) return "pro";
    if (has("claude_enterprise") || has("enterprise")) return "enterprise";
    if (has("claude_team") || has("team")) return "team";
    if (has("chat")) return "free";
    return "unknown";
  }

  async function listOrgs(){
    var orgs = await fetchJson(API + "/organizations");
    if (!Array.isArray(orgs) || !orgs.length){ var e=new Error("NO_ORGS"); e.code="NO_ORGS"; throw e; }
    return orgs;
  }

  // Fetch usage for every org. Returns rich rows for the popup AND the best pick.
  // The probes run together: serially, an account with several orgs paid one full
  // round-trip per org before anything could paint.
  async function scanOrgs(){
    var orgs = await listOrgs();
    var rows = await Promise.all(orgs.map(async function(o){
      var row = { uuid:o.uuid, name:o.name || "(unnamed)", caps:o.capabilities || null,
                  plan:planFromCaps(o.capabilities), ok:false, raw:null, windows:null, error:null };
      try {
        row.raw = await fetchJson(API + "/organizations/" + o.uuid + "/usage");
        row.windows = summarize(row.raw);
        row.ok = true;
      }
      catch (e) { row.error = e.code || "ERR"; }
      return row;
    }));

    var best = null, bestScore = -2;
    rows.forEach(function(row){
      if (!row.ok) return;
      var mu = maxUtil(row.windows);
      var score = (anyWindow(row.windows) ? 1000 : 0) + (mu >= 0 ? mu : 0);
      if (score > bestScore){
        bestScore = score;
        best = { id:row.uuid, name:row.name, caps:row.caps, usage:row.raw };
      }
    });

    if (!best){
      var chat = orgs.find(function(o){ return Array.isArray(o.capabilities) && o.capabilities.indexOf("chat")!==-1; }) || orgs[0];
      best = { id: chat.uuid, name: chat.name || "", caps: chat.capabilities || null, usage: null,
               // Every org answered, none of them with usage: not an outage, and
               // not a login problem either. Say so rather than falling through
               // to the generic failure text.
               reason: rows.every(function(r){ return !r.ok; }) ? "NO_WINDOWS" : null };
    }
    await sset({ cub_scan: { rows: rows, at: Date.now() } });
    return { rows: rows, best: best };
  }

  async function resolveOrg(){
    var st = await sget([AUTO_KEY, MANUAL_KEY]);
    if (st[MANUAL_KEY]){
      var cached = (st[AUTO_KEY] && st[AUTO_KEY].id === st[MANUAL_KEY]) ? st[AUTO_KEY] : null;
      return { id: st[MANUAL_KEY], name: cached ? cached.name : "", caps: cached ? cached.caps : null, manual: true };
    }
    if (st[AUTO_KEY] && st[AUTO_KEY].id && (Date.now() - st[AUTO_KEY].ts) < ORG_TTL_MS){
      return { id: st[AUTO_KEY].id, name: st[AUTO_KEY].name, caps: st[AUTO_KEY].caps };
    }
    var scan = await scanOrgs();
    await sset({ [AUTO_KEY]: { id: scan.best.id, name: scan.best.name, caps: scan.best.caps, ts: Date.now() } });
    return { id: scan.best.id, name: scan.best.name, caps: scan.best.caps,
             prefetched: scan.best.usage, reason: scan.best.reason };
  }

  function toResult(data, org, reason){
    var w = summarize(data);
    var reported = anyWindow(w);
    return {
      session: w.session, allModels: w.allModels, opus: w.opus,
      // false = Claude answered with no usage in it (the free plan). The bar
      // shows the locally-counted session instead of a row of dashes.
      reported: reported,
      reason: reported ? null : (reason || "NO_WINDOWS"),
      plan: planFromCaps(org.caps),
      orgName: org.name || "", orgId: org.id, fetchedAt: Date.now()
    };
  }

  async function fetchUsage(){
    var org = await resolveOrg();
    var data = org.prefetched || null;
    var reason = org.reason || null;
    if (!data){
      try { data = await fetchJson(API + "/organizations/" + org.id + "/usage"); }
      catch (e){
        if (e.code === "FORBIDDEN" || (e.code === "HTTP" && e.status === 404)){
          await sdel([AUTO_KEY]);                 // stale auto pick -> rescan
          var scan = await scanOrgs();
          org = { id: scan.best.id, name: scan.best.name, caps: scan.best.caps };
          await sset({ [AUTO_KEY]: { id: org.id, name: org.name, caps: org.caps, ts: Date.now() } });
          if (scan.best.usage) data = scan.best.usage;
          else if (scan.best.reason === "NO_WINDOWS"){
            // Listing the orgs worked, so the session is fine; every usage probe
            // was refused. Report an empty reading, not a failure.
            data = {}; reason = "NO_WINDOWS";
          }
          else data = await fetchJson(API + "/organizations/" + org.id + "/usage");
        } else throw e;
      }
    }
    try { console.debug("[Claude Usage Bar] org", org.id, org.name, "raw", data); } catch (e) {}
    // The raw payload used to be written to storage on every single fetch, which
    // on an open tab meant a disk write a minute for something only a bug report
    // ever reads. It is now opt-in (set cub_debug_on to keep it).
    var dbg = await sget([DEBUG_KEY, FORCE_KEY]);
    if (dbg[DEBUG_KEY]) await sset({ cub_debug: { orgName: org.name, orgId: org.id, raw: data, at: Date.now() } });
    // Test hook: the free path is otherwise unreachable from a paid account.
    if (dbg[FORCE_KEY]) return toResult({}, org, "NO_WINDOWS");
    return toResult(data, org, reason);
  }

  // One request per burst: the popup, the options page and a background ping can
  // all ask at once, and there is no reason for that to be three round-trips.
  var pending = null;
  function getUsage(){
    if (pending) return pending;
    pending = fetchUsage();
    pending.catch(function(){}).then(function(){ pending = null; });
    return pending;
  }

  async function setManualOrg(id){ await sset({ [MANUAL_KEY]: id || null }); await sdel([AUTO_KEY]); }
  async function clearOrg(){ await sdel([AUTO_KEY, MANUAL_KEY, "cub_scan"]); }

  // "3h 5m" until the window rolls over.
  function fmtReset(iso){
    if (!iso) return "";
    var t = new Date(iso).getTime(); if (isNaN(t)) return "";
    var ms = t - Date.now(); if (ms <= 0) return "now";
    var h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000);
    if (h >= 24){ var d=Math.floor(h/24); return d+"d "+(h%24)+"h"; }
    if (h > 0) return h+"h "+m+"m";
    return m+"m";
  }

  // The wall-clock time that countdown lands on, for tooltips: "4:30 PM", or
  // "Mon 4:30 PM" once it is far enough out that the day matters.
  function fmtResetAt(iso){
    if (!iso) return "";
    var d = new Date(iso); if (isNaN(d.getTime())) return "";
    var time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    var sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? time : d.toLocaleDateString([], { weekday: "short" }) + " " + time;
  }

  // How old the numbers on screen are.
  function fmtAgo(ts){
    if (!ts) return "";
    var ms = Date.now() - ts;
    if (ms < 0 || ms < 45000) return "just now";
    var m = Math.round(ms/60000);
    if (m < 60) return m + "m ago";
    var h = Math.round(m/60);
    if (h < 24) return h + "h ago";
    return Math.round(h/24) + "d ago";
  }

  return { getUsage:getUsage, scanOrgs:scanOrgs, setManualOrg:setManualOrg, clearOrg:clearOrg,
           summarize:summarize, planFromCaps:planFromCaps,
           freeHold:freeHold, FREE_RECHECK_MS:FREE_RECHECK_MS,
           fmtReset:fmtReset, fmtResetAt:fmtResetAt, fmtAgo:fmtAgo };
})();
