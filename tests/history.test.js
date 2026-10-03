// tests/history.test.js: the local usage history (history.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load");

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const BASE = new Date(2026, 9, 2, 9, 0, 0).getTime();   // 2 Oct 2026, 09:00 local

function fresh(){ const chrome = load(["usage.js", "history.js"]); return { chrome, CUBH: globalThis.CUBH, data: chrome.storage._data }; }

// A reading as usage.js would store it.
function reading(t, session, weekly, opts){
  opts = opts || {};
  const sReset = opts.sessionReset || BASE + 4 * HOUR;
  const wReset = opts.weeklyReset || BASE + 3 * DAY;
  const limits = [];
  if (session != null) limits.push({ id: "session", label: "Session", sub: "5h", group: "session", pct: session, resetAt: new Date(sReset).toISOString(), scoped: false });
  if (weekly != null) limits.push({ id: "allModels", label: "All models", sub: "7d", group: "weekly", pct: weekly, resetAt: new Date(wReset).toISOString(), scoped: false });
  if (opts.fable != null) limits.push({ id: "model:fable", label: "Fable", sub: "7d", group: "weekly", pct: opts.fable, resetAt: new Date(wReset).toISOString(), scoped: true });
  return { reported: true, limits: limits, credits: opts.credits || null, fetchedAt: t };
}

function day(t){ return globalThis.CUBH.dayKey(t); }

test("a reading becomes a compact sample", function(){
  const { CUBH } = fresh();
  const s = CUBH.sampleOf(reading(BASE, 42.04, 18, { fable: 81, credits: { enabled: true, used: 12.4, limit: 50, capReached: false } }));
  assert.deepEqual(s.p, { session: 42, allModels: 18, "model:fable": 81 });
  assert.equal(s.r.session, BASE + 4 * HOUR);
  assert.equal(s.c, 12.4);
  assert.equal(s.cl, 50);
  assert.equal(s.u, undefined);
  assert.equal(CUBH.sampleOf({ reported: false, fetchedAt: BASE }), null);
  assert.equal(CUBH.sampleOf(null), null);
});

test("only changes are kept, at most one a minute, with an hourly keep-alive", async function(){
  const { CUBH, data } = fresh();
  assert.equal((await CUBH.record(reading(BASE, 10, 5))).appended, true);
  assert.equal((await CUBH.record(reading(BASE + 30e3, 10, 5))).appended, false);   // same, soon
  assert.equal((await CUBH.record(reading(BASE + 40e3, 12, 5))).appended, false);   // moved, but within the minute
  assert.equal((await CUBH.record(reading(BASE + 70e3, 12, 5))).appended, true);    // moved, a minute on
  assert.equal((await CUBH.record(reading(BASE + 30 * MIN, 12, 5))).appended, false);
  assert.equal((await CUBH.record(reading(BASE + 70e3 + HOUR, 12, 5))).appended, true); // keep-alive
  assert.equal((await CUBH.record(reading(BASE + 10e3, 99, 99))).skipped, "old");   // late arrival
  assert.equal(data["cub_h_" + day(BASE)].length, 3);
  assert.deepEqual(data.cub_h_index.days, [day(BASE)]);
  assert.equal(data.cub_h_meta.session.label, "Session");
});

test("history can be switched off", async function(){
  const { CUBH, chrome, data } = fresh();
  await new Promise(function(r){ chrome.storage.local.set({ cub_prefs: { history: false } }, r); });
  assert.equal((await CUBH.record(reading(BASE, 10, 5))).skipped, "off");
  assert.equal(data.cub_h_index, undefined);
});

test("limit hits, resets and extra usage are logged as events", async function(){
  const { CUBH } = fresh();
  const credits = { enabled: true, used: 1, limit: 50, capReached: false };
  await CUBH.record(reading(BASE, 90, 40, { credits: credits }));
  const hit = await CUBH.record(reading(BASE + 5 * MIN, 100, 41, { credits: credits }));
  assert.deepEqual(hit.events.map(function(e){ return e.k + ":" + (e.id || ""); }), ["hit:session", "credits:"]);
  const cap = await CUBH.record(reading(BASE + 10 * MIN, 100, 41, { credits: { enabled: true, used: 50, limit: 50, capReached: true } }));
  assert.deepEqual(cap.events.map(function(e){ return e.k; }), ["cap"]);
  const reset = await CUBH.record(reading(BASE + 5 * HOUR, 0, 42, { sessionReset: BASE + 10 * HOUR }));
  assert.deepEqual(reset.events.map(function(e){ return e.k + ":" + e.id; }), ["reset:session"]);
  const all = await CUBH.events();
  assert.equal(all.length, 4);
  assert.equal((await CUBH.events(BASE + HOUR)).length, 1);
});

test("days are split, compacted after a week and dropped after sixty", async function(){
  const { CUBH, data } = fresh();
  const old = BASE - 61 * DAY, mid = BASE - 10 * DAY;
  // a busy hour on a day ten days back: one sample a minute
  for (let i = 0; i < 60; i++) await CUBH.record(reading(mid + i * MIN, i, 5));
  await CUBH.record(reading(old + DAY * 0, 1, 1));   // ignored: older than the last sample
  assert.equal(data["cub_h_" + day(mid)].length, 60);
  // a new day arriving triggers the upkeep
  await CUBH.record(reading(BASE, 30, 6));
  const kept = data["cub_h_" + day(mid)];
  assert.ok(kept.length <= 7 && kept.length >= 6, "compacted to one per ten minutes, got " + kept.length);
  assert.equal(data.cub_h_index.compactedThrough, day(mid));
  assert.deepEqual(data.cub_h_index.days, [day(mid), day(BASE)]);
});

test("days past the retention window are deleted", async function(){
  const { CUBH, chrome, data } = fresh();
  const gone = BASE - 61 * DAY;
  await CUBH.record(reading(gone, 10, 10));
  assert.ok(data["cub_h_" + day(gone)]);
  await CUBH.record(reading(BASE, 20, 20));
  assert.equal(data["cub_h_" + day(gone)], undefined);
  assert.deepEqual(data.cub_h_index.days, [day(BASE)]);
  void chrome;
});

test("compaction keeps the peak before a reset", function(){
  const { CUBH } = fresh();
  const list = [];
  for (let i = 0; i < 8; i++) list.push({ t: BASE + i * MIN, p: { session: 90 + i }, r: {} });
  list.push({ t: BASE + 8 * MIN, p: { session: 0 }, r: {} });
  const out = CUBH.compact(list);
  assert.ok(out.some(function(s){ return s.p.session === 97; }), "the 97% peak survives");
  assert.equal(out[out.length - 1].p.session, 0);
});

test("insights: a steady climb gives a rate, a fill time and a projection", function(){
  const { CUBH } = fresh();
  const samples = [];
  for (let i = 0; i <= 6; i++) samples.push({ t: BASE + i * 5 * MIN, p: { session: 40 + i * 2 }, r: {} });   // 24 points an hour
  const l = { id: "session", group: "session", pct: 52, resetAt: new Date(BASE + 3 * HOUR).toISOString() };
  const now = BASE + 30 * MIN;
  const ins = CUBH.insightFor(samples, l, now);
  assert.equal(ins.rate, 24);
  assert.equal(ins.fullAt, now + 2 * HOUR);          // 48 points left at 24 an hour
  assert.equal(ins.projected, 100);
  const calm = CUBH.insightFor(samples, Object.assign({}, l, { resetAt: new Date(BASE + 90 * MIN).toISOString() }), now);
  assert.equal(calm.projected, 76);                   // an hour left at 24 an hour
});

test("insights: idle, too short, and the run since a reset", function(){
  const { CUBH } = fresh();
  const l = { id: "session", group: "session", pct: 30, resetAt: new Date(BASE + 3 * HOUR).toISOString() };
  // climbed, then nothing for 40 minutes: idle
  const idle = [{ t: BASE, p: { session: 10 }, r: {} }, { t: BASE + 10 * MIN, p: { session: 30 }, r: {} }, { t: BASE + 50 * MIN, p: { session: 30 }, r: {} }];
  assert.equal(CUBH.insightFor(idle, l, BASE + 50 * MIN).rate, 0);
  // five minutes of data is not enough to call a rate
  const short = [{ t: BASE, p: { session: 10 }, r: {} }, { t: BASE + 5 * MIN, p: { session: 30 }, r: {} }];
  assert.equal(CUBH.insightFor(short, l, BASE + 5 * MIN), null);
  // a reset in the middle: only what came after it counts
  const reset = [
    { t: BASE, p: { session: 90 }, r: {} }, { t: BASE + 10 * MIN, p: { session: 95 }, r: {} },
    { t: BASE + 20 * MIN, p: { session: 2 }, r: {} }, { t: BASE + 40 * MIN, p: { session: 12 }, r: {} }
  ];
  const ins = CUBH.insightFor(reset, Object.assign({}, l, { pct: 12 }), BASE + 40 * MIN);
  assert.equal(ins.rate, 30);
  // outside the lookback, or a limit with no known window length
  assert.equal(CUBH.insightFor(reset, Object.assign({}, l, { group: "monthly" }), BASE + 40 * MIN), null);
});

test("insights are stored for the surfaces to read", async function(){
  const { CUBH, data } = fresh();
  for (let i = 0; i <= 6; i++) await CUBH.record(reading(BASE + i * 5 * MIN, 40 + i * 2, 10));
  const ins = data.cub_insights;
  assert.ok(ins && ins.limits.session, "session insight stored");
  assert.equal(ins.limits.session.rate, 24);
  assert.equal(ins.limits.session.resetAt, new Date(BASE + 4 * HOUR).toISOString());
  // half an hour is not enough to call a weekly rate
  assert.equal(ins.limits.allModels, undefined);
});

test("activity: rises are credited to the hour they land in", function(){
  const { CUBH } = fresh();
  const at = function(h, m){ return new Date(2026, 9, 2, h, m).getTime(); };
  const samples = [
    { t: at(9, 0), p: { session: 0 }, r: {}, c: 1 },
    { t: at(9, 30), p: { session: 20 }, r: {}, c: 1 },
    { t: at(10, 15), p: { session: 50 }, r: {}, c: 3.5 },
    { t: at(15, 0), p: { session: 8 }, r: {}, c: 3.5 }        // a reset: the new window holds 8
  ];
  const a = CUBH.activity(samples);
  const dow = new Date(at(9, 0)).getDay();
  assert.equal(a.hours[dow][9], 20);
  assert.equal(a.hours[dow][10], 30);
  assert.equal(a.hours[dow][15], 8);
  const d = a.days[CUBH.dayKey(at(9, 0))];
  assert.equal(d.use, 58);
  assert.equal(d.spend, 2.5);
  assert.equal(a.basis, "session");
});

test("clear removes every history key", async function(){
  const { CUBH, data } = fresh();
  await CUBH.record(reading(BASE, 10, 5));
  await CUBH.record(reading(BASE + DAY, 20, 6));
  await CUBH.clear();
  assert.deepEqual(Object.keys(data).filter(function(k){ return k.indexOf("cub_h") === 0 || k === "cub_events" || k === "cub_insights"; }), []);
});

test("range reads across days in time order", async function(){
  const { CUBH } = fresh();
  await CUBH.record(reading(BASE, 10, 5));
  await CUBH.record(reading(BASE + DAY, 20, 6));
  await CUBH.record(reading(BASE + 2 * DAY, 30, 7));
  const r = await CUBH.range(BASE + HOUR, BASE + 2 * DAY);
  assert.deepEqual(r.map(function(s){ return s.p.session; }), [20, 30]);
});

test("insights: a weekly limit needs an hour and more than one point", function(){
  const { CUBH } = fresh();
  const l = { id: "allModels", group: "weekly", pct: 61, resetAt: new Date(BASE + 3 * DAY).toISOString() };
  const onePoint = [{ t: BASE, p: { allModels: 60 }, r: {} }, { t: BASE + 2 * HOUR, p: { allModels: 61 }, r: {} }];
  assert.equal(CUBH.insightFor(onePoint, l, BASE + 2 * HOUR).rate, 0);
  const tooShort = [{ t: BASE, p: { allModels: 55 }, r: {} }, { t: BASE + 40 * MIN, p: { allModels: 61 }, r: {} }];
  assert.equal(CUBH.insightFor(tooShort, l, BASE + 40 * MIN), null);
  const real = [{ t: BASE, p: { allModels: 55 }, r: {} }, { t: BASE + 3 * HOUR, p: { allModels: 61 }, r: {} }];
  assert.equal(CUBH.insightFor(real, l, BASE + 3 * HOUR).rate, 2);
});
