// usage.js: shared helpers for Claude's internal usage endpoint.
// Loaded by the content script (same-origin on claude.ai), the popup, the
// Settings page, the dashboard and the service worker.
//
// Endpoints (undocumented, can change):
//   GET /api/organizations -> [{ uuid, name, capabilities:[...], rate_limit_tier }, ...]
//   GET /api/organizations/{uuid}/usage
//       -> { five_hour:{utilization:0-100,resets_at}, seven_day:{...}, seven_day_opus:{...},
//            limits:[{ kind, group, percent, resets_at, severity, scope }],
//            extra_usage:{...}, spend:{...} }
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
//
// The same payload carries more than the three windows this file used to read:
// a `limits` list that names every limit the plan has (per-model weekly caps
// such as "Fable only", per-surface ones such as Cowork), and the extra-usage
// block (credits spent against a monthly cap). readLimits() and readCredits()
// below turn both into the shapes every surface draws from, so a limit Claude
// adds tomorrow shows up under its own name without a code change.

var CUB = (function () {
  var AUTO_KEY = "cub_org";          // {id,name,caps,tier,ts} auto-detected
  var MANUAL_KEY = "cub_org_manual"; // user-chosen uuid (string), wins over auto
  var DEBUG_KEY = "cub_debug_on";    // opt-in: keep the raw payload in storage
  var FORCE_KEY = "cub_debug_plan";  // test hook: "free" forces the not-reported path
  var ORG_TTL_MS = 6 * 60 * 60 * 1000;
  var FREE_RECHECK_MS = 24 * 60 * 60 * 1000;  // free plan: check again once a day
  var API = "https://claude.ai/api";

  // How long each kind of window runs, for the pace marker. A window of any
  // other length is drawn without one rather than with a guess.
  var WINDOW_MS = { session: 5 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };

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

  function obj(v){ return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
  function str(v){ return typeof v === "string" && v.trim() !== "" ? v.trim() : null; }
  function clampPct(p){ return Math.max(0, Math.min(100, p)); }

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
    return { available:true, pct: clampPct(pct), resetAt: resetOf(b) };
  }

  // ---- Every limit ---------------------------------------------------------
  // One shape for every limit, whichever part of the payload it came from:
  //   { id, label, sub, group, pct, resetAt, severity, scoped, tip }
  // `id` is stable across fetches (it keys the bar rows, the history and the
  // alerts), `label` is what the user reads, `group` says which window length
  // it runs on. "session" and "allModels" keep the ids they have always had.

  var TIP_SESSION = "Current rolling 5-hour session";
  var TIP_WEEK = "Weekly usage, across all models";

  function subOf(group){ return group === "session" ? "5h" : group === "weekly" ? "7d" : ""; }

  function slug(s){
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
  }

  // "weekly_scoped" -> "Weekly scoped": only ever used for a kind Claude has not
  // named for us, so it reads plainly rather than prettily.
  function words(s){
    var t = String(s || "").replace(/[_-]+/g, " ").trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
  }

  // Names for the surfaces Claude identifies by id alone.
  var SURFACES = { claude_code: "Claude Code", cowork: "Cowork", oauth_apps: "Apps", oauth: "Apps" };

  // { type: "model"|"surface", name, key } for a limit's scope, or null when it
  // applies to everything. The model wins when both are set: it is the narrower
  // of the two, and the one the composer's model picker talks about.
  function scopeOf(sc){
    sc = obj(sc);
    if (!sc) return null;
    var m = sc.model;
    if (m != null){
      var mName = typeof m === "string" ? str(m) : obj(m) && (str(m.display_name) || str(m.displayName) || str(m.name) || str(m.id));
      if (mName) return { type: "model", name: mName, key: slug(mName) };
    }
    var s = sc.surface;
    if (s != null){
      var sId = typeof s === "string" ? str(s) : obj(s) && (str(s.id) || str(s.key));
      var sName = typeof s === "string" ? null : obj(s) && (str(s.display_name) || str(s.displayName) || str(s.name));
      var name = sName || (sId && (SURFACES[sId.toLowerCase()] || words(sId)));
      if (name) return { type: "surface", name: name, key: slug(sId || name) };
    }
    return null;
  }

  // One entry of Claude's `limits` list. Returns null for an entry with no
  // percentage, which is the same rule readWindow() applies to the old keys.
  function limitFromItem(it, i){
    it = obj(it);
    if (!it) return null;
    var p = num(it.percent);
    if (p == null) p = pctOf(it);
    if (p == null) return null;
    var kind = str(it.kind) || "";
    var group = str(it.group) || (/session|five|5h/i.test(kind) ? "session" : /week|seven|7d/i.test(kind) ? "weekly" : "");
    var sc = scopeOf(it.scope);
    var id, label, tip, scoped = false;
    if (sc){
      scoped = true;
      id = sc.type + ":" + sc.key + (group && group !== "weekly" ? ":" + group : "");
      label = sc.name;
      tip = (group === "session" ? "5-hour limit for " : group === "weekly" ? "Weekly limit for " : "Limit for ") +
            sc.name + (sc.type === "model" ? " only" : "");
    } else if (kind === "session" || (!kind && group === "session")){
      id = "session"; label = "Session"; tip = TIP_SESSION; group = "session";
    } else if (kind === "weekly_all" || kind === "weekly" || (!kind && group === "weekly")){
      id = "allModels"; label = "All models"; tip = TIP_WEEK; group = "weekly";
    } else {
      id = "kind:" + slug(kind || ("limit " + i));
      label = words(kind) || (group === "session" ? "Session" : "Weekly");
      tip = label + " limit";
    }
    return { id: id, label: label, sub: subOf(group), group: group, pct: clampPct(p),
             resetAt: resetOf(it), severity: str(it.severity), scoped: scoped, tip: tip };
  }

  // The old top-level keys, read the way they always were.
  function legacyLimit(data, keys, def){
    var w = readWindow(pick(data, keys));
    if (!w.available) return null;
    return { id: def.id, label: def.label, sub: subOf(def.group), group: def.group, pct: w.pct,
             resetAt: w.resetAt, severity: null, scoped: !!def.scoped, tip: def.tip };
  }

  var LEGACY_SESSION = { id: "session", label: "Session", group: "session", tip: TIP_SESSION };
  var LEGACY_WEEK = { id: "allModels", label: "All models", group: "weekly", tip: TIP_WEEK };
  var LEGACY_SCOPED = [
    { keys: SEVEN_DAY_OPUS, id: "model:opus", label: "Opus", group: "weekly", scoped: true,
      tip: "Weekly limit for Opus only" },
    { keys: ["seven_day_sonnet", "sevenDaySonnet"], id: "model:sonnet", label: "Sonnet", group: "weekly", scoped: true,
      tip: "Weekly limit for Sonnet only" },
    { keys: ["seven_day_cowork", "sevenDayCowork"], id: "surface:cowork", label: "Cowork", group: "weekly", scoped: true,
      tip: "Weekly limit for Cowork" },
    { keys: ["seven_day_oauth_apps", "sevenDayOauthApps"], id: "surface:oauth-apps", label: "Apps", group: "weekly", scoped: true,
      tip: "Weekly usage from apps signed in with your Claude account, such as Claude Code" }
  ];

  // Every limit in the payload, in the order a reader wants them: the session,
  // then the all-models week, then the scoped limits in the order Claude lists
  // them. The `limits` list is the source of truth when it has something to
  // say; the old keys fill in what it leaves out. The old scoped keys are only
  // read when the list names no scoped limit at all, because the two spell the
  // same limit differently ("Opus" vs whatever display name the list uses) and
  // reading both is how one cap would end up drawn twice.
  function readLimits(data){
    var out = [], seen = {};
    function add(l){ if (l && !seen[l.id]){ seen[l.id] = true; out.push(l); } }
    var items = data && Array.isArray(data.limits) ? data.limits : [];
    var listed = items.map(limitFromItem).filter(Boolean);
    function listedById(id){ for (var i = 0; i < listed.length; i++) if (listed[i].id === id) return listed[i]; return null; }
    add(listedById("session") || legacyLimit(data, FIVE_HOUR, LEGACY_SESSION));
    add(listedById("allModels") || legacyLimit(data, SEVEN_DAY, LEGACY_WEEK));
    listed.forEach(add);
    if (!listed.some(function(l){ return l.scoped; })){
      LEGACY_SCOPED.forEach(function(d){ add(legacyLimit(data, d.keys, d)); });
    }
    return out;
  }

  // ---- Extra usage (credits) ------------------------------------------------
  // Two blocks describe the same money. `spend` is the newer one and writes
  // amounts as {amount_minor, currency, exponent}; `extra_usage` writes them in
  // minor units with `decimal_places` beside them. Either may be missing, so
  // `spend` is read first and `extra_usage` fills the gaps. Out comes:
  //   { enabled, used, limit, pct, currency, balance, autoReload, capReached,
  //     severity, disabledReason }
  // in major units ($12.40, not 1240), or null for an account that has never
  // spent anything and does not have it switched on -- which is most of them,
  // and for those the row would only be clutter.

  function money(m){
    m = obj(m);
    if (!m) return null;
    var a = num(m.amount_minor != null ? m.amount_minor : m.amountMinor);
    if (a == null) return null;
    var e = num(m.exponent);
    if (e == null || e < 0 || e > 6) e = 2;
    return { value: a / Math.pow(10, e), currency: str(m.currency) };
  }

  function readCredits(data){
    data = obj(data);
    if (!data) return null;
    var sp = obj(data.spend), eu = obj(data.extra_usage) || obj(data.extraUsage);
    if (!sp && !eu) return null;

    var dp = eu ? num(eu.decimal_places != null ? eu.decimal_places : eu.decimalPlaces) : null;
    if (dp == null || dp < 0 || dp > 6) dp = 2;
    var euCur = eu ? str(eu.currency) : null;
    function minor(v){ var n = num(v); return n == null ? null : { value: n / Math.pow(10, dp), currency: euCur }; }

    var used = money(sp && sp.used) || (eu ? minor(eu.used_credits != null ? eu.used_credits : eu.usedCredits) : null);
    var limit = money(sp && sp.limit) || (eu ? minor(eu.monthly_limit != null ? eu.monthly_limit : eu.monthlyLimit) : null);
    if (limit && !(limit.value > 0)) limit = null;      // a zero cap is "no cap", not "always full"

    var enabled = sp && typeof sp.enabled === "boolean" ? sp.enabled
                : eu && typeof eu.is_enabled === "boolean" ? eu.is_enabled
                : eu && typeof eu.isEnabled === "boolean" ? eu.isEnabled : false;
    var usedVal = used && used.value > 0 ? used.value : 0;
    if (!enabled && !usedVal) return null;

    var bal = money(sp && sp.balance);
    var ar = sp ? sp.auto_reload : null;
    var autoReload = typeof ar === "boolean" ? ar : obj(ar) ? ar.enabled !== false : null;

    return {
      enabled: enabled,
      used: usedVal,
      limit: limit ? limit.value : null,
      pct: limit ? clampPct(usedVal / limit.value * 100) : null,
      currency: (used && used.currency) || (limit && limit.currency) || euCur || "USD",
      balance: bal ? bal.value : null,
      autoReload: autoReload,
      capReached: !!(eu && eu.spend_limit_reached === true) || !!(limit && usedVal >= limit.value),
      severity: sp ? str(sp.severity) : null,
      disabledReason: str(sp && sp.disabled_reason) || str(eu && eu.disabled_reason)
    };
  }

  // The three windows of a raw payload, in the shape the rest of the extension
  // has always spoken, plus the full list and the credits. Exported because the
  // Settings account-picker reads raw rows too.
  function summarize(data){
    var limits = readLimits(data);
    function win(id){
      for (var i = 0; i < limits.length; i++){
        if (limits[i].id === id) return { available: true, pct: limits[i].pct, resetAt: limits[i].resetAt };
      }
      return { available: false, pct: null, resetAt: null };
    }
    return {
      session: win("session"), allModels: win("allModels"), opus: win("model:opus"),
      limits: limits, credits: readCredits(data)
    };
  }

  function anyWindow(s){ return !!(s.limits && s.limits.length); }
  function maxUtil(s){
    return Math.max.apply(null, (s.limits || []).map(function(l){ return l.pct; }).concat(-1));
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

  // "Max 20x" and friends, for the popup and dashboard headers. The org's
  // rate_limit_tier is the only place the 5x/20x split shows up; the
  // capabilities are the fallback. "" when neither says anything we recognise.
  var PLAN_NAMES = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Free" };
  function tierLabel(tier, caps){
    var t = typeof tier === "string" ? tier.toLowerCase() : "";
    if (/20x/.test(t)) return "Max 20x";
    if (/5x/.test(t)) return "Max 5x";
    if (/max/.test(t)) return "Max";
    if (/enterprise/.test(t)) return "Enterprise";
    if (/team/.test(t)) return "Team";
    if (/pro/.test(t)) return "Pro";
    return PLAN_NAMES[planFromCaps(caps)] || "";
  }

  async function listOrgs(){
    var orgs = await fetchJson(API + "/organizations");
    if (!Array.isArray(orgs) || !orgs.length){ var e=new Error("NO_ORGS"); e.code="NO_ORGS"; throw e; }
    return orgs;
  }

  function tierOf(o){ return str(o && (o.rate_limit_tier || o.rateLimitTier)); }

  // Fetch usage for every org. Returns rich rows for the popup AND the best pick.
  // The probes run together: serially, an account with several orgs paid one full
  // round-trip per org before anything could paint.
  async function scanOrgs(){
    var orgs = await listOrgs();
    var rows = await Promise.all(orgs.map(async function(o){
      var row = { uuid:o.uuid, name:o.name || "(unnamed)", caps:o.capabilities || null, tier:tierOf(o),
                  plan:planFromCaps(o.capabilities), ok:false, raw:null, windows:null, error:null };
      try {
        row.raw = await fetchJson(API + "/organizations/" + o.uuid + "/usage");
        row.windows = summarize(row.raw);
        row.ok = true;
      }
      catch (e) { row.error = e.code || "ERR"; }
      return row;
    }));

    // An org with limits beats one with only spend, which beats one with
    // neither; the busiest wins among equals. Spend-only is an enterprise org on
    // usage-based billing: real, just with no percentage to compare.
    var best = null, bestScore = -2;
    rows.forEach(function(row){
      if (!row.ok) return;
      var mu = maxUtil(row.windows);
      var score = (anyWindow(row.windows) ? 1000 : row.windows.credits ? 500 : 0) + (mu >= 0 ? mu : 0);
      if (score > bestScore){
        bestScore = score;
        best = { id:row.uuid, name:row.name, caps:row.caps, tier:row.tier, usage:row.raw };
      }
    });

    if (!best){
      var chat = orgs.find(function(o){ return Array.isArray(o.capabilities) && o.capabilities.indexOf("chat")!==-1; }) || orgs[0];
      best = { id: chat.uuid, name: chat.name || "", caps: chat.capabilities || null, tier: tierOf(chat), usage: null,
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
      return { id: st[MANUAL_KEY], name: cached ? cached.name : "", caps: cached ? cached.caps : null,
               tier: cached ? cached.tier || null : null, manual: true };
    }
    if (st[AUTO_KEY] && st[AUTO_KEY].id && (Date.now() - st[AUTO_KEY].ts) < ORG_TTL_MS){
      return { id: st[AUTO_KEY].id, name: st[AUTO_KEY].name, caps: st[AUTO_KEY].caps, tier: st[AUTO_KEY].tier || null };
    }
    var scan = await scanOrgs();
    await sset({ [AUTO_KEY]: { id: scan.best.id, name: scan.best.name, caps: scan.best.caps, tier: scan.best.tier, ts: Date.now() } });
    return { id: scan.best.id, name: scan.best.name, caps: scan.best.caps, tier: scan.best.tier,
             prefetched: scan.best.usage, reason: scan.best.reason };
  }

  function toResult(data, org, reason){
    var w = summarize(data);
    var plan = planFromCaps(org.caps);
    // An enterprise org on usage-based billing has no allowance to go over, so
    // the money is the whole bill rather than something "extra".
    if (w.credits) w.credits.label = plan === "enterprise" ? "Spend" : "Extra usage";
    // Spend counts as an answer: an account billed by usage with no windows is
    // a paying account with something to show, not a free one to count for.
    var reported = anyWindow(w) || !!w.credits;
    return {
      session: w.session, allModels: w.allModels, opus: w.opus,
      limits: w.limits, credits: w.credits,
      // false = Claude answered with no usage in it (the free plan). The bar
      // shows the locally-counted session instead of a row of dashes.
      reported: reported,
      reason: reported ? null : (reason || "NO_WINDOWS"),
      plan: plan, tier: tierLabel(org.tier, org.caps),
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
          org = { id: scan.best.id, name: scan.best.name, caps: scan.best.caps, tier: scan.best.tier };
          await sset({ [AUTO_KEY]: { id: org.id, name: org.name, caps: org.caps, tier: org.tier, ts: Date.now() } });
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

  // ---- Reading a stored result ---------------------------------------------

  // The limits a stored reading carries. A reading saved before 1.4 has only the
  // three fixed windows, so the list is rebuilt from those rather than drawing
  // nothing until the next fetch lands.
  function limitsOf(result){
    if (!result) return [];
    if (Array.isArray(result.limits)) return result.limits;
    var out = [];
    [[result.session, LEGACY_SESSION], [result.allModels, LEGACY_WEEK], [result.opus, LEGACY_SCOPED[0]]]
      .forEach(function(pair){
        var w = pair[0], d = pair[1];
        if (!w || !w.available || w.pct == null) return;
        out.push({ id: d.id, label: d.label, sub: subOf(d.group), group: d.group, pct: w.pct,
                   resetAt: w.resetAt || null, severity: null, scoped: !!d.scoped, tip: d.tip });
      });
    return out;
  }

  // The one limit closest to running out, or null.
  function tightest(list){
    var best = null;
    (list || []).forEach(function(l){ if (!best || l.pct > best.pct) best = l; });
    return best;
  }

  // A limit is used up and extra usage is switched on: what gets sent now is
  // paid for, at API rates, until the limit resets or the cap is reached.
  function creditsInUse(result){
    var c = result && result.credits;
    if (!c || !c.enabled || c.capReached) return false;
    return limitsOf(result).some(function(l){ return l.pct >= 100; });
  }

  // ---- Colours -------------------------------------------------------------
  // Blue below `mid`, Claude orange from `mid`, red above `high`. The defaults
  // are the 30/80 the bar has always used; Settings can move them, and an
  // unusable pair (red before orange, out of range) falls back to the defaults
  // rather than painting everything one colour.
  var DEFAULT_COLORS = { mid: 30, high: 80 };
  function colorsOf(prefs){
    var c = (prefs && prefs.colors) || {};
    var mid = num(c.mid), high = num(c.high);
    if (mid == null || high == null || mid < 1 || high > 100 || high <= mid) return { mid: DEFAULT_COLORS.mid, high: DEFAULT_COLORS.high };
    return { mid: mid, high: high };
  }
  function colorLevel(pct, prefs){
    if (pct == null) return "";
    var c = colorsOf(prefs);
    return pct > c.high ? "high" : pct >= c.mid ? "mid" : "low";
  }

  // ---- Pace and forecast ---------------------------------------------------

  // Where an even pace would have this limit by now, from how much of its window
  // has gone by. The window starts a fixed span before it resets, so the reset
  // time is all it takes. null when there is nothing honest to mark: no reset
  // time, a window length we do not know, or a reset already in the past.
  function paceOf(limit, now){
    if (!limit || !limit.resetAt) return null;
    var span = WINDOW_MS[limit.group];
    if (!span) return null;
    var left = new Date(limit.resetAt).getTime() - (now || Date.now());
    if (!(left > 0) || left > span) return null;
    var expected = (1 - left / span) * 100;
    return { expected: expected, delta: limit.pct - expected };
  }

  function paceText(p){
    if (!p) return "";
    var d = Math.round(p.delta);
    if (Math.abs(d) < 3) return "Right on an even pace";
    return Math.abs(d) + "% " + (d > 0 ? "over" : "under") + " an even pace";
  }

  // What the burn rate says about a limit, from the insight the service worker
  // worked out of the history (history.js). Warns when the limit will run out
  // before it resets; otherwise says where it is heading. null when there is no
  // fresh insight for this window, or nothing is moving.
  function forecastOf(limit, insight, now){
    if (!limit || !insight || !(insight.rate > 0) || limit.pct >= 100) return null;
    if (insight.resetAt && limit.resetAt && insight.resetAt !== limit.resetAt) return null;   // another window's
    now = now || Date.now();
    var reset = limit.resetAt ? new Date(limit.resetAt).getTime() : NaN;
    if (insight.fullAt && insight.fullAt > now && (!(reset > now) || insight.fullAt < reset - 60000)){
      return { warn: true, fullAt: insight.fullAt,
               text: "At this pace: full in ~" + fmtSpan(insight.fullAt - now) +
                     (reset > now ? " (resets in " + fmtSpan(reset - now) + ")" : "") };
    }
    if (insight.projected != null && reset > now){
      return { warn: false, text: "At this pace: ~" + Math.round(insight.projected) + "% by the reset" };
    }
    return null;
  }

  // ---- Formatting ----------------------------------------------------------

  // "3h 5m" for a span of time.
  function fmtSpan(ms){
    if (!(ms > 0)) return "now";
    var h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000);
    if (h >= 24){ var d=Math.floor(h/24); return d+"d "+(h%24)+"h"; }
    if (h > 0) return h+"h "+m+"m";
    return Math.max(1, m)+"m";
  }

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

  // The badge has room for about four characters: "45m", "2h", "3d".
  function fmtShortSpan(ms){
    if (!(ms > 0)) return "0m";
    var m = Math.ceil(ms / 60000);
    if (m < 60) return m + "m";
    var h = Math.round(ms / 3600000);
    if (h < 24) return h + "h";
    return Math.round(ms / 86400000) + "d";
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

  // "$12.40", in the account's currency and the user's locale. `whole` drops
  // the cents from a round amount, for caps: "of $50" reads better than
  // "of $50.00".
  function fmtMoney(v, cur, whole){
    if (v == null || !isFinite(v)) return "–";
    var opts = { style: "currency", currency: cur || "USD" };
    if (whole && Math.round(v) === v){ opts.minimumFractionDigits = 0; opts.maximumFractionDigits = 0; }
    try { return new Intl.NumberFormat(undefined, opts).format(v); }
    catch (e){ return (cur && cur !== "USD" ? cur + " " : "$") + (whole && Math.round(v) === v ? String(v) : v.toFixed(2)); }
  }

  // The narrow symbol on its own ("$", "€"), or "" when the currency only has a
  // long one -- "CA$12" would not fit on the badge anyway.
  function currencySymbol(cur){
    try {
      var parts = new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD", currencyDisplay: "narrowSymbol" }).formatToParts(0);
      for (var i = 0; i < parts.length; i++) if (parts[i].type === "currency") return parts[i].value.length === 1 ? parts[i].value : "";
    } catch (e) {}
    return cur && cur !== "USD" ? "" : "$";
  }

  // Badge-sized money: "$12", "$408", "$4k", "$12k", "123k".
  function fmtShortMoney(v, cur){
    if (v == null || !isFinite(v)) return "";
    var sym = currencySymbol(cur);
    var n = v < 1000 ? String(Math.round(v)) : Math.floor(v / 1000) + "k";
    return (sym + n).length <= 4 ? sym + n : n;
  }

  return { getUsage:getUsage, scanOrgs:scanOrgs, setManualOrg:setManualOrg, clearOrg:clearOrg,
           summarize:summarize, readLimits:readLimits, readCredits:readCredits,
           planFromCaps:planFromCaps, tierLabel:tierLabel,
           freeHold:freeHold, FREE_RECHECK_MS:FREE_RECHECK_MS, WINDOW_MS:WINDOW_MS,
           limitsOf:limitsOf, tightest:tightest, creditsInUse:creditsInUse,
           colorsOf:colorsOf, colorLevel:colorLevel,
           paceOf:paceOf, paceText:paceText, forecastOf:forecastOf,
           fmtReset:fmtReset, fmtResetAt:fmtResetAt, fmtAgo:fmtAgo, fmtSpan:fmtSpan, fmtShortSpan:fmtShortSpan,
           fmtMoney:fmtMoney, fmtShortMoney:fmtShortMoney };
})();
