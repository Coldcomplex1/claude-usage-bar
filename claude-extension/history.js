// history.js: a local record of how usage moved, kept so the extension can say
// where a limit is heading (the forecast), draw where it has been (the
// dashboard), and show when Claude gets used (the activity stats).
//
// One writer. The service worker records every new reading that lands in
// cub_last, whichever surface fetched it; tabs, the popup and the dashboard
// only ever read. That is what keeps ten open tabs from racing each other into
// the same day's list.
//
// Storage, one key per local day so that a write rewrites a day rather than the
// whole history:
//   cub_h_index         { days:["2026-10-01",...], last:<sample>, compactedThrough:"YYYY-MM-DD" }
//   cub_h_meta          { <limit id>: { label, sub, group } }   names for the dashboard legend
//   cub_h_<YYYY-MM-DD>  [ <sample>, ... ]  oldest first
//   cub_events          [ { t, k:"hit"|"reset"|"credits"|"cap", id }, ... ]  oldest first
//   cub_insights        { at, limits:{ <id>: { rate, fullAt, projected, resetAt } } }
// A sample is { t, p:{ <id>: pct }, r:{ <id>: resetAt ms }, c: spent, cl: cap,
// u: 1 while a full limit bills to extra usage, cr: 1 once the cap is reached }.
//
// Bounded on purpose: a sample only when something moved (at most one a minute,
// and an hourly one when nothing does), full detail for a week, one sample per
// ten minutes after that, nothing past sixty days. A heavy month stays well
// under storage.local's quota.
//
// Everything stays in chrome.storage.local, on this device. Nothing here is
// ever sent anywhere.

var CUBH = (function () {
  var INDEX_KEY = "cub_h_index";
  var META_KEY = "cub_h_meta";
  var EVENTS_KEY = "cub_events";
  var INSIGHTS_KEY = "cub_insights";
  var PREFS_KEY = "cub_prefs";
  var DAY_PREFIX = "cub_h_";

  var MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  var MIN_GAP_MS = 55 * 1000;        // at most one sample a minute...
  var KEEPALIVE_MS = HOUR;           // ...and one an hour even when nothing moves
  var KEEP_DAYS = 60;
  var FULL_DAYS = 7;                 // full detail this long, then compacted
  var COMPACT_MS = 10 * MIN;
  var MAX_EVENTS = 500;
  var INSIGHT_EVERY_MS = 10 * MIN;
  var DROP = 5;                      // a fall of more than this many points is a reset

  // How far back the burn rate looks, how much of that it needs, and how long
  // without a change before the limit counts as idle (a burst an hour ago says
  // nothing about the next ten minutes). Claude reports whole percentages, so a
  // weekly limit needs a longer stretch and more than a single one-point step
  // before its rate means anything: one point in forty minutes would otherwise
  // "run out" in a day.
  var LOOKBACK = { session: HOUR, weekly: DAY };
  var IDLE = { session: 20 * MIN, weekly: 3 * HOUR };
  var MIN_SPAN = { session: 10 * MIN, weekly: HOUR };
  var MIN_RISE = { session: 1, weekly: 2 };

  function sget(k){ return new Promise(function(r){ chrome.storage.local.get(k, r); }); }
  function sset(o){ return new Promise(function(r){ chrome.storage.local.set(o, r); }); }
  function sdel(k){ return new Promise(function(r){ chrome.storage.local.remove(k, r); }); }

  function pad(n){ return (n < 10 ? "0" : "") + n; }
  // The local calendar day a time falls on, which is what "Tuesday" means to
  // the person reading the dashboard.
  function dayKey(t){
    var d = new Date(t);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  // ---- Samples -------------------------------------------------------------

  function sampleOf(result){
    if (!result || result.reported === false) return null;
    var limits = CUB.limitsOf(result), c = result.credits;
    if (!limits.length && !c) return null;
    var s = { t: result.fetchedAt || Date.now(), p: {}, r: {} };
    limits.forEach(function(l){
      s.p[l.id] = Math.round(l.pct * 10) / 10;
      var r = l.resetAt ? new Date(l.resetAt).getTime() : NaN;
      if (isFinite(r)) s.r[l.id] = r;
    });
    if (c){
      s.c = Math.round(c.used * 100) / 100;
      if (c.limit) s.cl = c.limit;
      if (c.capReached) s.cr = 1;
    }
    if (CUB.creditsInUse(result)) s.u = 1;
    return s;
  }

  // The same reading, give or take: every limit within half a point and on the
  // same window, the same spend, the same states.
  function sameAs(a, b){
    if (!a || !b) return false;
    var ka = Object.keys(a.p), kb = Object.keys(b.p);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++){
      var k = ka[i];
      if (!(k in b.p) || Math.abs(a.p[k] - b.p[k]) >= 0.5) return false;
      if (Math.abs((a.r[k] || 0) - (b.r[k] || 0)) > 2 * MIN) return false;
    }
    return (a.c || 0) === (b.c || 0) && (a.cl || 0) === (b.cl || 0) &&
           !a.u === !b.u && !a.cr === !b.cr;
  }

  // What happened between two consecutive readings.
  function eventsBetween(prev, s){
    var out = [];
    Object.keys(s.p).forEach(function(id){
      var now = s.p[id], was = prev && id in prev.p ? prev.p[id] : null;
      if (now >= 99.5 && (was == null || was < 99.5)) out.push({ t: s.t, k: "hit", id: id });
      if (was != null && now < was - DROP) out.push({ t: s.t, k: "reset", id: id });
    });
    if (s.u && !(prev && prev.u)) out.push({ t: s.t, k: "credits" });
    if (s.cr && !(prev && prev.cr)) out.push({ t: s.t, k: "cap" });
    return out;
  }

  // One sample per ten minutes (the last of each), plus the last one before any
  // reset, so a compacted day still shows how high each window got.
  function compact(list){
    var out = [];
    for (var i = 0; i < list.length; i++){
      var s = list[i], next = list[i + 1];
      var lastInBucket = !next || Math.floor(next.t / COMPACT_MS) !== Math.floor(s.t / COMPACT_MS);
      var peak = !!next && Object.keys(s.p).some(function(id){ return id in next.p && next.p[id] < s.p[id] - DROP; });
      if (lastInBucket || peak) out.push(s);
    }
    return out;
  }

  // ---- Reading -------------------------------------------------------------

  async function range(from, to){
    var idx = (await sget([INDEX_KEY]))[INDEX_KEY];
    if (!idx || !idx.days || !idx.days.length) return [];
    var a = dayKey(from), b = dayKey(to);
    var keys = idx.days.filter(function(d){ return d >= a && d <= b; }).map(function(d){ return DAY_PREFIX + d; });
    if (!keys.length) return [];
    var st = await sget(keys);
    var out = [];
    keys.forEach(function(k){
      (st[k] || []).forEach(function(s){ if (s.t >= from && s.t <= to) out.push(s); });
    });
    out.sort(function(x, y){ return x.t - y.t; });
    return out;
  }

  async function events(from){
    var list = (await sget([EVENTS_KEY]))[EVENTS_KEY] || [];
    return from ? list.filter(function(e){ return e.t >= from; }) : list;
  }

  async function meta(){ return (await sget([META_KEY]))[META_KEY] || {}; }

  // ---- Insights ------------------------------------------------------------
  // The burn rate over the stretch since the limit last fell (a reset, or a
  // rolling window letting old usage go), inside the lookback. From that: when
  // the limit fills at this rate, and where it lands by the reset. A limit that
  // has not moved for a while is idle, and gets rate 0 rather than a forecast
  // built out of a burst that is over.
  function insightFor(samples, l, now){
    var look = LOOKBACK[l.group];
    if (!look) return null;
    var run = [];
    for (var i = samples.length - 1; i >= 0; i--){
      var s = samples[i];
      if (s.t < now - look) break;
      if (!(l.id in s.p)) break;
      if (run.length && s.p[l.id] > run[run.length - 1].p[l.id] + 0.5) break;   // it fell after this one
      run.push(s);
    }
    if (run.length < 2) return null;
    var newest = run[0], oldest = run[run.length - 1];
    if (newest.t - oldest.t < MIN_SPAN[l.group]) return null;
    var cur = newest.p[l.id];
    // When it last moved: the oldest sample still at the current value.
    var since = newest.t;
    for (var j = 1; j < run.length && Math.abs(run[j].p[l.id] - cur) < 0.5; j++) since = run[j].t;
    var dp = cur - oldest.p[l.id];
    if (!(dp >= MIN_RISE[l.group]) || now - since > IDLE[l.group]) return { rate: 0, fullAt: null, projected: null, resetAt: l.resetAt || null };
    var perMs = dp / (newest.t - oldest.t);
    var reset = l.resetAt ? new Date(l.resetAt).getTime() : NaN;
    return {
      rate: Math.round(perMs * HOUR * 100) / 100,                        // points per hour
      fullAt: cur < 100 ? Math.round(newest.t + (100 - cur) / perMs) : null,
      projected: isFinite(reset) && reset > newest.t ? Math.min(100, Math.round(cur + perMs * (reset - newest.t))) : null,
      resetAt: l.resetAt || null
    };
  }

  function insightsFrom(samples, result, now){
    var out = {};
    CUB.limitsOf(result).forEach(function(l){
      var ins = insightFor(samples, l, now);
      if (ins) out[l.id] = ins;
    });
    return out;
  }

  // ---- Activity ------------------------------------------------------------
  // When Claude gets used, from how fast the session filled: every rise
  // between two readings is credited to the hour it landed in. A reset in
  // between counts what the new window holds. The spend is counted the same
  // way, by day. No message is read or counted for this.
  function activity(samples){
    var hours = [];
    for (var d = 0; d < 7; d++){ hours.push([]); for (var h = 0; h < 24; h++) hours[d].push(0); }
    var days = {};
    for (var i = 1; i < samples.length; i++){
      var a = samples[i - 1], b = samples[i];
      var id = "session" in b.p ? "session" : "allModels" in b.p ? "allModels" : null;
      var dt = new Date(b.t), day = dayKey(b.t);
      if (id && id in a.p){
        var dp = b.p[id] - a.p[id];
        if (dp < -DROP) dp = b.p[id];
        if (dp > 0){
          hours[dt.getDay()][dt.getHours()] += dp;
          (days[day] || (days[day] = { use: 0, spend: 0 })).use += dp;
        }
      }
      if (a.c != null && b.c != null && b.c > a.c){
        (days[day] || (days[day] = { use: 0, spend: 0 })).spend += b.c - a.c;
      }
    }
    return { hours: hours, days: days, basis: samples.length && "session" in samples[samples.length - 1].p ? "session" : "allModels" };
  }

  // ---- Writing (service worker only) ----------------------------------------

  async function maintain(idx, now){
    var keepFrom = dayKey(now - KEEP_DAYS * DAY), fullFrom = dayKey(now - FULL_DAYS * DAY);
    var gone = idx.days.filter(function(d){ return d < keepFrom; });
    if (gone.length){
      await sdel(gone.map(function(d){ return DAY_PREFIX + d; }));
      idx.days = idx.days.filter(function(d){ return d >= keepFrom; });
    }
    var todo = idx.days.filter(function(d){ return d < fullFrom && (!idx.compactedThrough || d > idx.compactedThrough); });
    if (todo.length){
      var keys = todo.map(function(d){ return DAY_PREFIX + d; });
      var st = await sget(keys), writes = {};
      keys.forEach(function(k){ if (st[k]) writes[k] = compact(st[k]); });
      await sset(writes);
      idx.compactedThrough = todo[todo.length - 1];
    }
    var ev = await events();
    var kept = ev.filter(function(e){ return e.t >= now - KEEP_DAYS * DAY; });
    var writes2 = { [INDEX_KEY]: idx };
    if (kept.length !== ev.length) writes2[EVENTS_KEY] = kept;
    await sset(writes2);
  }

  function sameInsights(a, b){ return JSON.stringify(a || {}) === JSON.stringify(b || {}); }

  // Record one reading. Resolves to { appended, events, sample } (or
  // { skipped } when there was nothing to record). Callers serialize calls; the
  // service worker chains them on one promise.
  async function record(result){
    var st = await sget([INDEX_KEY, PREFS_KEY, META_KEY, INSIGHTS_KEY]);
    if (st[PREFS_KEY] && st[PREFS_KEY].history === false) return { skipped: "off" };
    var s = sampleOf(result);
    if (!s) return { skipped: "none" };
    var idx = st[INDEX_KEY] || { days: [], last: null, compactedThrough: null };
    var last = idx.last;
    if (last && s.t <= last.t) return { skipped: "old" };      // a slower fetch landing after a newer one

    var evs = eventsBetween(last, s);
    var gap = last ? s.t - last.t : Infinity;
    var append = !last || evs.length > 0 ||
                 (sameAs(last, s) ? gap >= KEEPALIVE_MS : gap >= MIN_GAP_MS);
    var writes = {}, newDay = false;

    if (append){
      var day = dayKey(s.t), key = DAY_PREFIX + day;
      var list = (await sget([key]))[key] || [];
      list.push(s);
      writes[key] = list;
      idx.last = s;
      if (idx.days.indexOf(day) === -1){ idx.days.push(day); idx.days.sort(); newDay = true; }
      writes[INDEX_KEY] = idx;
      // Names for the dashboard, so a limit that has since gone still has one.
      var m = st[META_KEY] || {}, changed = false;
      CUB.limitsOf(result).forEach(function(l){
        var cur = m[l.id];
        if (!cur || cur.label !== l.label || cur.sub !== l.sub || cur.group !== l.group){
          m[l.id] = { label: l.label, sub: l.sub, group: l.group }; changed = true;
        }
      });
      if (result.credits && (!m.credits || m.credits.label !== result.credits.label)){
        m.credits = { label: result.credits.label || "Extra usage", currency: result.credits.currency }; changed = true;
      }
      if (changed) writes[META_KEY] = m;
    }
    if (evs.length){
      var ev = await events();
      writes[EVENTS_KEY] = ev.concat(evs).slice(-MAX_EVENTS);
    }
    if (Object.keys(writes).length) await sset(writes);
    if (newDay) await maintain(idx, s.t);

    // Worked out again on every new sample, and every ten minutes regardless,
    // since "idle" depends on how long nothing has moved and no sample says so.
    var prevIns = st[INSIGHTS_KEY];
    var stale = !prevIns || s.t - prevIns.at >= INSIGHT_EVERY_MS;
    if (append || stale){
      var samples = await range(s.t - DAY - HOUR, s.t);
      var ins = insightsFrom(samples, result, s.t);
      if (stale || !sameInsights(prevIns.limits, ins)) await sset({ [INSIGHTS_KEY]: { at: s.t, limits: ins } });
    }
    return { appended: append, events: evs, sample: s };
  }

  async function clear(){
    var idx = (await sget([INDEX_KEY]))[INDEX_KEY];
    var keys = [INDEX_KEY, META_KEY, EVENTS_KEY, INSIGHTS_KEY];
    if (idx && idx.days) idx.days.forEach(function(d){ keys.push(DAY_PREFIX + d); });
    await sdel(keys);
  }

  return { INSIGHTS_KEY: INSIGHTS_KEY, EVENTS_KEY: EVENTS_KEY, INDEX_KEY: INDEX_KEY, KEEP_DAYS: KEEP_DAYS,
           dayKey: dayKey, sampleOf: sampleOf, sameAs: sameAs, eventsBetween: eventsBetween, compact: compact,
           insightFor: insightFor, insightsFrom: insightsFrom, activity: activity,
           range: range, events: events, meta: meta, record: record, clear: clear };
})();
