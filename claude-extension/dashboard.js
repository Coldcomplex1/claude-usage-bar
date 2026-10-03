// dashboard.js: the usage dashboard. Everything on it is read from this
// browser's storage: the latest reading (cub_last), the history, events and
// forecasts the service worker keeps (history.js), and on the free plan the
// hourly send tallies (session.js). The only request it ever makes is the one
// behind the Refresh button.
var LAST_KEY = "cub_last";
var PREFS_KEY = "cub_prefs";
var ACTIVITY_KEY = "cub_activity";
var HOUR = 3600e3, DAY = 24 * HOUR;
var GAP_MS = 3 * HOUR;   // readings further apart than this are not joined by a line

var last = null, insights = {}, prefs = {};
var rangeDays = 7;
var tables = {};          // chart name -> showing its table instead
var cache = null;         // what the range-scoped sections were last drawn from

function el(tag, cls, text){
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function sget(keys){ return new Promise(function(r){ chrome.storage.local.get(keys, r); }); }
function plural(n, w){ return n + " " + w + (n === 1 ? "" : "s"); }
function insightsOf(v){ return v && v.limits && typeof v.limits === "object" ? v.limits : {}; }

function fmtDuration(ms){
  if (!(ms > 0)) return "0m";
  var m = Math.round(ms / 60000);
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}
function fmtWhen(t){
  var d = new Date(t);
  var sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                 : d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function rangeText(){ return rangeDays === 1 ? "last 24 hours" : "last " + rangeDays + " days"; }

// ---- Colours ---------------------------------------------------------------
// Each limit keeps its colour whatever the range or the legend hides: the
// session and the all-models week own the first two slots, everything else
// takes the next free one in the order the extension first saw it.
var metaCache = {};
function slotOf(id){
  if (id === "session") return 1;
  if (id === "allModels") return 2;
  var others = Object.keys(metaCache).filter(function(k){ return k !== "session" && k !== "allModels" && k !== "credits"; });
  var i = others.indexOf(id);
  return i < 0 ? 8 : Math.min(8, 3 + i);
}
function labelOf(id){
  var m = metaCache[id];
  if (m) return m.label + (m.sub ? " " + m.sub : "");
  return id === "session" ? "Session 5h" : id === "allModels" ? "All models 7d" : id;
}

// ---- Right now ---------------------------------------------------------------

function meter(pct, paceAt){
  var m = el("div", "d-meter");
  var f = el("div", "d-meter-fill " + CUB.colorLevel(pct, prefs));
  f.style.width = (pct == null ? 0 : Math.max(0, Math.min(100, pct))) + "%";
  m.appendChild(f);
  if (paceAt != null){ var t = el("div", "d-meter-pace"); t.style.left = paceAt.toFixed(1) + "%"; m.appendChild(t); }
  return m;
}

function limitTile(l){
  var tile = el("div", "d-tile");
  tile.title = l.tip || "";
  var head = el("div", "d-tile-head");
  head.appendChild(el("span", "d-tile-label", l.label));
  if (l.sub) head.appendChild(el("span", "d-tile-sub", l.sub));
  tile.appendChild(head);
  var pct = Math.round(l.pct);
  tile.appendChild(el("div", "d-tile-value", pct + "%"));
  var p = CUB.paceOf(l);
  tile.appendChild(meter(pct, prefs.pace !== false && p && p.expected >= 2 && p.expected <= 98 ? p.expected : null));
  var left = pct > 0 && l.resetAt ? CUB.fmtReset(l.resetAt) : "";
  if (left) tile.appendChild(el("div", "d-line", "Resets in " + left + " · " + CUB.fmtResetAt(l.resetAt)));
  if (p && p.expected >= 2) tile.appendChild(el("div", "d-line", CUB.paceText(p) + " (even pace: " + Math.round(p.expected) + "% by now)"));
  var f = CUB.forecastOf(l, insights[l.id]);
  if (f) tile.appendChild(el("div", "d-line" + (f.warn ? " d-line-warn" : ""), f.text));
  return tile;
}

function creditsTile(data){
  var c = data.credits, cur = c.currency;
  var tile = el("div", "d-tile");
  var head = el("div", "d-tile-head");
  head.appendChild(el("span", "d-tile-label", c.label || "Extra usage"));
  // State always comes as an icon and a word, never as colour alone.
  var state = !c.enabled ? ["○", "Off", "off"] : c.capReached ? ["■", "Cap reached", "cap"]
            : CUB.creditsInUse(data) ? ["●", "In use", "live"] : null;
  if (state){
    var chip = el("span", "d-chip d-chip-" + state[2]);
    chip.appendChild(el("span", null, state[0]));
    chip.appendChild(el("span", null, state[1]));
    head.appendChild(chip);
  }
  tile.appendChild(head);
  tile.appendChild(el("div", "d-tile-value", CUB.fmtMoney(c.used, cur)));
  if (c.limit){
    tile.appendChild(meter(c.pct, null));
    tile.appendChild(el("div", "d-line", "of " + CUB.fmtMoney(c.limit, cur, true) + " monthly cap · " + Math.round(c.pct) + "%"));
  } else {
    tile.appendChild(el("div", "d-line", c.enabled ? "No monthly cap set" : "Spent before it was switched off"));
  }
  var more = [];
  if (c.balance != null) more.push("Balance " + CUB.fmtMoney(c.balance, cur));
  if (c.autoReload != null) more.push("auto-reload " + (c.autoReload ? "on" : "off"));
  if (more.length) tile.appendChild(el("div", "d-line", more.join(" · ")));
  if (state && state[2] === "live") tile.appendChild(el("div", "d-line d-line-warn", "A limit is full, so what you send now is billed to extra usage at API rates."));
  return tile;
}

function renderNow(){
  var box = document.getElementById("now");
  box.textContent = "";
  var tier = document.getElementById("tier");
  tier.textContent = last && last.tier ? last.tier : "";
  tier.hidden = !(last && last.tier);
  document.getElementById("acct").textContent = last && last.orgName ? last.orgName : "";
  if (!last){
    box.appendChild(el("div", "d-empty", "No reading yet. Open claude.ai while signed in, or press Refresh."));
    return;
  }
  if (last.reported === false){
    CUBS.read(function(f){
      box.textContent = "";
      var tile = el("div", "d-tile");
      var head = el("div", "d-tile-head");
      head.appendChild(el("span", "d-tile-label", "Session"));
      head.appendChild(el("span", "d-tile-sub", "5h"));
      tile.appendChild(head);
      var value = el("div", "d-tile-value", String(f.count) + " ");
      value.appendChild(el("span", "d-tile-unit", f.count === 1 ? "message" : "messages"));
      tile.appendChild(value);
      if (f.resetAt) tile.appendChild(el("div", "d-line", "Resets in " + CUB.fmtReset(f.resetAt) + " · " + CUB.fmtResetAt(f.resetAt)));
      tile.appendChild(el("div", "d-line", "Free plan: Claude reports no usage percentage, so this counts the messages you send in the rolling 5-hour window."));
      box.appendChild(tile);
    });
    return;
  }
  CUB.limitsOf(last).forEach(function(l){ box.appendChild(limitTile(l)); });
  if (last.credits) box.appendChild(creditsTile(last));
  if (!box.firstChild) box.appendChild(el("div", "d-empty", "Claude reported no usage for this account."));
}

// ---- Range-scoped sections -------------------------------------------------------

async function load(){
  var to = Date.now(), from = to - rangeDays * DAY;
  var res = await Promise.all([CUBH.range(from, to), CUBH.events(from), CUBH.meta(), sget([ACTIVITY_KEY])]);
  metaCache = res[2] || {};
  return { from: from, to: to, samples: res[0], events: res[1], meta: metaCache, activity: res[3][ACTIVITY_KEY] || {} };
}

function stat(box, label, value, sub){
  var s = el("div", "d-stat");
  s.appendChild(el("div", "d-stat-label", label));
  s.appendChild(el("div", "d-stat-value", value));
  if (sub) s.appendChild(el("div", "d-stat-sub", sub));
  box.appendChild(s);
}

// The highest the session got on each day in range.
function dailyPeaks(samples, id){
  var peaks = {};
  samples.forEach(function(s){
    if (!(id in s.p)) return;
    var k = CUBH.dayKey(s.t);
    if (!(k in peaks) || s.p[id] > peaks[k].v) peaks[k] = { v: s.p[id], t: s.t };
  });
  return peaks;
}

// How long any limit sat full, from consecutive readings (a gap too long to
// vouch for is left out rather than guessed at).
function timeAtLimit(samples){
  var ms = 0;
  for (var i = 1; i < samples.length; i++){
    var a = samples[i - 1], b = samples[i];
    if (b.t - a.t > GAP_MS) continue;
    if (Object.keys(a.p).some(function(id){ return a.p[id] >= 99.5; })) ms += b.t - a.t;
  }
  return ms;
}

// Extra usage spent between the first and last reading: every rise counts, and
// a fall (the monthly meter starting over) counts what the new month holds.
function spentIn(samples){
  var sum = 0, seen = false;
  for (var i = 1; i < samples.length; i++){
    var a = samples[i - 1], b = samples[i];
    if (a.c == null || b.c == null) continue;
    seen = true;
    if (b.c > a.c) sum += b.c - a.c;
    else if (b.c < a.c) sum += b.c;
  }
  return seen ? sum : null;
}

function messagesIn(activity, from, to){
  var a = CUBH.dayKey(from), b = CUBH.dayKey(to), n = 0, any = false;
  Object.keys(activity).forEach(function(k){
    if (k < a || k > b || !Array.isArray(activity[k])) return;
    any = true;
    activity[k].forEach(function(v){ n += v || 0; });
  });
  return any ? n : null;
}

function renderStats(c){
  var box = document.getElementById("stats");
  box.textContent = "";
  var hits = c.events.filter(function(e){ return e.k === "hit"; });
  var byId = {};
  hits.forEach(function(e){ byId[e.id] = (byId[e.id] || 0) + 1; });
  stat(box, "Times a limit ran out", String(hits.length),
       hits.length ? Object.keys(byId).map(function(id){ return labelOf(id) + " " + byId[id]; }).join(" · ") : "In the " + rangeText());
  var peaks = dailyPeaks(c.samples, "session"), keys = Object.keys(peaks);
  if (keys.length){
    var avg = keys.reduce(function(s, k){ return s + peaks[k].v; }, 0) / keys.length;
    var top = keys.reduce(function(b, k){ return !b || peaks[k].v > peaks[b].v ? k : b; }, null);
    stat(box, "Average daily peak", Math.round(avg) + "%", "Session · highest " + Math.round(peaks[top].v) + "% on " +
         new Date(peaks[top].t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }));
  } else {
    var msgs = messagesIn(c.activity, c.from, c.to);
    stat(box, msgs != null ? "Messages sent" : "Average daily peak", msgs != null ? String(msgs) : "–",
         msgs != null ? "From this browser, " + rangeText() : "No readings in range yet");
  }
  stat(box, "Time at a limit", fmtDuration(timeAtLimit(c.samples)), "Any limit at 100%");
  var spent = spentIn(c.samples);
  var cur = (last && last.credits && last.credits.currency) || (c.meta.credits && c.meta.credits.currency) || "USD";
  stat(box, "Extra usage spent", spent != null ? CUB.fmtMoney(spent, cur) : "–",
       spent != null ? "In the " + rangeText() : "No extra usage in range");
}

// Show a chart, or its table twin, in its host.
function mount(name, host, chart){
  if (!tables[name] || !chart) return;
  host.textContent = "";
  var wrap = el("div", "d-table-wrap");
  wrap.appendChild(chart.table);
  host.appendChild(wrap);
}
function syncTableButtons(){
  document.querySelectorAll("[data-table]").forEach(function(b){
    b.textContent = tables[b.getAttribute("data-table")] ? "Show chart" : "Show table";
  });
}

function empty(host, text){ host.textContent = ""; host.appendChild(el("div", "d-empty", text)); }

function renderHistory(c){
  var host = document.getElementById("hist");
  if (c.samples.length < 2){
    empty(host, "No history in the " + rangeText() + " yet. It fills in as you use Claude: a point is kept whenever your usage changes.");
    return;
  }
  var ids = [];
  c.samples.forEach(function(s){ Object.keys(s.p).forEach(function(id){ if (ids.indexOf(id) === -1) ids.push(id); }); });
  ids.sort(function(a, b){ return slotOf(a) - slotOf(b); });
  var series = ids.slice(0, 8).map(function(id){
    return {
      id: id, label: labelOf(id), color: "var(--s" + slotOf(id) + ")",
      points: c.samples.filter(function(s){ return id in s.p; }).map(function(s){ return { t: s.t, v: s.p[id] }; }),
      markers: c.events.filter(function(e){ return e.k === "hit" && e.id === id; }).map(function(e){ return { t: e.t, v: 100 }; })
    };
  });
  var chart = CUBC.lineChart(host, series, { from: c.from, to: c.to, yMax: 100, yTicks: [0, 25, 50, 75, 100],
                                             gapMs: GAP_MS, title: "Usage over time, " + rangeText() });
  mount("hist", host, chart);
}

function renderSpend(c){
  var card = document.getElementById("spend-card"), host = document.getElementById("spend");
  var pts = c.samples.filter(function(s){ return s.c != null; }).map(function(s){ return { t: s.t, v: s.c }; });
  card.hidden = pts.length < 2;
  if (card.hidden) return;
  var cur = (last && last.credits && last.credits.currency) || (c.meta.credits && c.meta.credits.currency) || "USD";
  var max = Math.max.apply(null, pts.map(function(p){ return p.v; }));
  var label = (c.meta.credits && c.meta.credits.label) || "Extra usage";
  document.getElementById("spend-h").textContent = label + " spent";
  var chart = CUBC.lineChart(host, [{ id: "credits", label: label, color: "var(--s1)", points: pts }], {
    from: c.from, to: c.to, yTicks: CUBC.niceTicks(max || 1, 4), gapMs: GAP_MS,
    yFormat: function(v){ return CUB.fmtMoney(v, cur, true); }, height: 180, title: label + " spent, " + rangeText()
  });
  mount("spend", host, chart);
}

// Monday first, labelled in the user's locale.
var WEEKDAYS = [0, 1, 2, 3, 4, 5, 6].map(function(i){ return new Date(2026, 9, 5 + i).toLocaleDateString([], { weekday: "short" }); });
var HOURS = []; for (var hh = 0; hh < 24; hh++) HOURS.push(new Date(2026, 0, 1, hh).toLocaleTimeString([], { hour: "numeric" }));
function mondayFirst(rows){ return [1, 2, 3, 4, 5, 6, 0].map(function(d){ return rows[d]; }); }

// Session points used per bucket of time, from the rise between readings (a
// reset in between counts what the new window holds).
function useBuckets(samples, from, size, n){
  var out = []; for (var i = 0; i < n; i++) out.push(0);
  for (var j = 1; j < samples.length; j++){
    var a = samples[j - 1], b = samples[j];
    var id = "session" in b.p ? "session" : "allModels" in b.p ? "allModels" : null;
    if (!id || !(id in a.p)) continue;
    var dp = b.p[id] - a.p[id];
    if (dp < -5) dp = b.p[id];
    if (dp <= 0) continue;
    var k = Math.floor((b.t - from) / size);
    if (k >= 0 && k < n) out[k] += dp;
  }
  return out;
}

function renderActivity(c){
  var heat = document.getElementById("heat"), days = document.getElementById("days");
  var sub = document.getElementById("act-sub");
  var paid = c.samples.length >= 2;
  var msgs = !paid ? messagesIn(c.activity, c.from, c.to) : null;
  if (!paid && msgs == null){
    sub.textContent = "";
    empty(heat, "Nothing to show yet. This fills in as you use Claude.");
    days.textContent = "";
    return;
  }
  var grid, fmt, unit;
  if (paid){
    var a = CUBH.activity(c.samples);
    grid = mondayFirst(a.hours);
    fmt = function(v){ return Math.round(v) + " pts"; };
    unit = a.basis === "session" ? "of the 5-hour session" : "of the weekly limit";
    sub.textContent = "Points of your " + (a.basis === "session" ? "5-hour session" : "weekly limit") + " used in each hour, " + rangeText() +
      ". Worked out from how fast your usage rose, on every device you use Claude on; no message is read.";
  } else {
    var rows = []; for (var d = 0; d < 7; d++){ rows.push([]); for (var h = 0; h < 24; h++) rows[d].push(0); }
    var lo = CUBH.dayKey(c.from), hi = CUBH.dayKey(c.to);
    Object.keys(c.activity).forEach(function(k){
      if (k < lo || k > hi || !Array.isArray(c.activity[k])) return;
      var parts = k.split("-"), dow = new Date(+parts[0], +parts[1] - 1, +parts[2]).getDay();
      c.activity[k].forEach(function(v, hr){ rows[dow][hr] += v || 0; });
    });
    grid = mondayFirst(rows);
    fmt = function(v){ return plural(v, "message"); };
    unit = "";
    sub.textContent = "Messages sent from this browser in each hour, " + rangeText() + ". Only counts are kept, never what was said.";
  }
  var hm = CUBC.heatmap(heat, grid, { rows: WEEKDAYS, cols: HOURS, format: fmt, unit: unit });
  mount("heat", heat, hm);

  // Per hour over the last day, per day otherwise.
  var items = [];
  document.getElementById("days-h").textContent = rangeDays === 1 ? "Per hour" : "Per day";
  if (rangeDays === 1){
    var start = new Date(c.to - 23 * HOUR); start.setMinutes(0, 0, 0);
    var vals = paid ? useBuckets(c.samples, start.getTime(), HOUR, 24) : null;
    for (var i = 0; i < 24; i++){
      var t = new Date(start.getTime() + i * HOUR);
      var v = paid ? vals[i] : ((c.activity[CUBH.dayKey(t.getTime())] || [])[t.getHours()] || 0);
      items.push({ label: t.toLocaleTimeString([], { hour: "numeric" }), v: v,
                   tip: t.toLocaleString([], { weekday: "short", hour: "numeric" }) });
    }
  } else {
    var a2 = paid ? CUBH.activity(c.samples) : null;
    for (var dd = rangeDays - 1; dd >= 0; dd--){
      var day = new Date(c.to - dd * DAY), key = CUBH.dayKey(day.getTime());
      var val = paid ? (a2.days[key] ? a2.days[key].use : 0)
                     : (c.activity[key] || []).reduce(function(s, x){ return s + (x || 0); }, 0);
      items.push({ label: rangeDays <= 7 ? day.toLocaleDateString([], { weekday: "short" }) : String(day.getDate()), v: val,
                   tip: day.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) });
    }
  }
  var bars = CUBC.bars(days, items, { format: paid ? function(v){ return Math.round(v) + " pts"; } : function(v){ return String(Math.round(v)); },
                                      unit: paid ? unit : "messages", labelHead: rangeDays === 1 ? "Hour" : "Day",
                                      valueHead: paid ? "Points used" : "Messages" });
  mount("days", days, bars);
}

var EVENT_TEXT = {
  hit: function(e){ return labelOf(e.id) + " limit reached"; },
  reset: function(e){ return labelOf(e.id) + " limit reset"; },
  credits: function(){ return "A limit filled up and extra usage started billing"; },
  cap: function(){ return "Extra usage cap reached"; }
};
var EVENT_ICON = { hit: "▲", reset: "↺", credits: "$", cap: "■" };

function renderEvents(c){
  var list = document.getElementById("events");
  list.textContent = "";
  var evs = c.events.slice().sort(function(a, b){ return b.t - a.t; }).slice(0, 30);
  if (!evs.length){ list.appendChild(el("li", "d-empty", "Nothing in the " + rangeText() + ". Limits running out, resets and extra usage show up here.")); return; }
  evs.forEach(function(e){
    if (!EVENT_TEXT[e.k]) return;
    var li = el("li");
    li.appendChild(el("span", "d-ev-icon d-ev-" + e.k, EVENT_ICON[e.k]));
    li.appendChild(el("span", null, EVENT_TEXT[e.k](e)));
    li.appendChild(el("span", "d-ev-time", fmtWhen(e.t)));
    list.appendChild(li);
  });
}

function drawRange(c){
  renderStats(c);
  renderHistory(c);
  renderSpend(c);
  renderActivity(c);
  renderEvents(c);
  syncTableButtons();
}

var loading = null;
async function renderRange(){
  if (loading) return loading;
  document.querySelectorAll(".d-chart").forEach(function(n){ n.classList.add("d-loading"); });
  loading = load().then(function(c){
    cache = c;
    drawRange(c);
  }).finally(function(){
    loading = null;
    document.querySelectorAll(".d-chart").forEach(function(n){ n.classList.remove("d-loading"); });
  });
  return loading;
}

// ---- Data ----------------------------------------------------------------------

function download(name, text, type){
  var url = URL.createObjectURL(new Blob([text], { type: type }));
  var a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
}
function stamp(){ return CUBH.dayKey(Date.now()); }
function csvCell(v){ var s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

async function exportCsv(){
  var all = await CUBH.range(0, Date.now());
  var meta = await CUBH.meta();
  metaCache = meta;
  var ids = [];
  all.forEach(function(s){ Object.keys(s.p).forEach(function(id){ if (ids.indexOf(id) === -1) ids.push(id); }); });
  ids.sort(function(a, b){ return slotOf(a) - slotOf(b); });
  var cur = (meta.credits && meta.credits.currency) || "USD";
  var lines = [["time"].concat(ids.map(function(id){ return labelOf(id) + " %"; })).concat(["extra usage spent (" + cur + ")"]).map(csvCell).join(",")];
  all.forEach(function(s){
    lines.push([new Date(s.t).toISOString()].concat(ids.map(function(id){ return id in s.p ? s.p[id] : ""; }))
      .concat([s.c != null ? s.c : ""]).map(csvCell).join(","));
  });
  download("claude-usage-" + stamp() + ".csv", lines.join("\n") + "\n", "text/csv");
}

async function exportJson(){
  var res = await Promise.all([CUBH.range(0, Date.now()), CUBH.events(), CUBH.meta(), sget([ACTIVITY_KEY])]);
  download("claude-usage-" + stamp() + ".json", JSON.stringify({
    exportedAt: new Date().toISOString(), limits: res[2], samples: res[0], events: res[1], activity: res[3][ACTIVITY_KEY] || {}
  }, null, 2), "application/json");
}

async function clearHistory(){
  if (!confirm("Delete the usage history kept in this browser? Your current numbers stay, and new history starts from now.")) return;
  await CUBH.clear();
  await new Promise(function(r){ chrome.storage.local.remove([ACTIVITY_KEY], r); });
  renderRange();
}

// ---- Status and refresh ------------------------------------------------------------

function showAge(){
  var s = document.getElementById("status");
  s.textContent = last && last.fetchedAt ? (last.reported === false ? "Checked " : "Updated ") + CUB.fmtAgo(last.fetchedAt) : "";
}

async function refresh(){
  var btn = document.getElementById("refresh"), s = document.getElementById("status");
  btn.disabled = true; s.textContent = "Updating…";
  try {
    var data = await CUB.getUsage();
    await new Promise(function(r){ chrome.storage.local.set({ [LAST_KEY]: data }, r); });
  } catch (e){
    s.textContent = e.code === "AUTH" ? "Log in to claude.ai first" : e.code === "NO_ORGS" ? "No account found" : "Couldn't reach Claude";
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
}

// ---- Wiring ----------------------------------------------------------------------------

var redrawTimer = null;
function later(fn, ms){ clearTimeout(redrawTimer); redrawTimer = setTimeout(fn, ms); }

document.addEventListener("DOMContentLoaded", function(){
  sget([LAST_KEY, CUBH.INSIGHTS_KEY, PREFS_KEY]).then(function(o){
    last = o[LAST_KEY] || null;
    insights = insightsOf(o[CUBH.INSIGHTS_KEY]);
    prefs = o[PREFS_KEY] || {};
    renderNow(); showAge();
    renderRange();
  });
  setInterval(function(){ showAge(); renderNow(); }, 30000);

  document.querySelectorAll("#range button").forEach(function(b){
    b.addEventListener("click", function(){
      rangeDays = Number(b.getAttribute("data-range"));
      document.querySelectorAll("#range button").forEach(function(x){ x.setAttribute("aria-pressed", String(x === b)); });
      renderRange();
    });
  });
  document.querySelectorAll("[data-table]").forEach(function(b){
    b.addEventListener("click", function(){
      var name = b.getAttribute("data-table");
      tables[name] = !tables[name];
      if (cache) drawRange(cache);
    });
  });
  document.getElementById("refresh").addEventListener("click", refresh);
  document.getElementById("export-csv").addEventListener("click", exportCsv);
  document.getElementById("export-json").addEventListener("click", exportJson);
  document.getElementById("clear").addEventListener("click", clearHistory);
  document.getElementById("settings").addEventListener("click", function(){ chrome.runtime.openOptionsPage(); });

  // A tab, the alarm or the Refresh button landing a reading, or the worker
  // recording it, repaints the lot. Bursts of writes coalesce into one pass.
  chrome.storage.onChanged.addListener(function(changes, area){
    if (area !== "local") return;
    var touched = false;
    if (changes[LAST_KEY]){ last = changes[LAST_KEY].newValue || null; touched = true; }
    if (changes[CUBH.INSIGHTS_KEY]){ insights = insightsOf(changes[CUBH.INSIGHTS_KEY].newValue); touched = true; }
    if (changes[PREFS_KEY]){ prefs = changes[PREFS_KEY].newValue || {}; touched = true; }
    if (touched){ renderNow(); showAge(); }
    if (changes[CUBH.INDEX_KEY] || changes[CUBH.EVENTS_KEY] || changes[ACTIVITY_KEY]) later(renderRange, 400);
  });

  // Charts are drawn to the width they have.
  var lastWidth = 0;
  window.addEventListener("resize", function(){
    var w = document.querySelector(".d-wrap").clientWidth;
    if (w === lastWidth || !cache) return;
    lastWidth = w;
    later(function(){ drawRange(cache); }, 150);
  });
});
