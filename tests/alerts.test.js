// tests/alerts.test.js: when the extension speaks up (alerts.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load");

const MIN = 60e3, HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-02T12:00:00Z");
function fresh(){ load(["usage.js", "alerts.js"]); return globalThis.CUBA; }

const ON = { on: true, at: [80, 95], resets: true, credits: true };
function reading(t, session, opts){
  opts = opts || {};
  return {
    reported: true, fetchedAt: t,
    limits: [
      { id: "session", label: "Session", sub: "5h", group: "session", pct: session, resetAt: opts.reset || new Date(NOW + 3 * HOUR).toISOString() },
      { id: "allModels", label: "All models", sub: "7d", group: "weekly", pct: opts.weekly || 10, resetAt: new Date(NOW + 72 * HOUR).toISOString() }
    ],
    credits: opts.credits || null
  };
}

test("settings: defaults, cleaned thresholds", function(){
  const A = fresh();
  assert.deepEqual(A.settingsOf(null), { on: false, at: [80, 95], resets: true, credits: true, desktop: false });
  assert.deepEqual(A.settingsOf({ at: [95, "80", 80, 0, 300] }).at, [80, 95]);
});

test("off says nothing", function(){
  const A = fresh();
  const out = A.evaluate(reading(NOW, 99), { on: false }, {}, NOW);
  assert.equal(out.alerts.length, 0);
  assert.equal(out.resets.length, 0);
});

test("each threshold once per window, the highest crossed", function(){
  const A = fresh();
  let st = {};
  let out = A.evaluate(reading(NOW, 50), ON, st, NOW); st = out.state;
  assert.equal(out.alerts.length, 0);
  out = A.evaluate(reading(NOW + MIN, 82), ON, st, NOW + MIN); st = out.state;
  assert.deepEqual(out.alerts.map(function(a){ return a.title; }), ["Session (5h) at 82%"]);
  out = A.evaluate(reading(NOW + 2 * MIN, 86), ON, st, NOW + 2 * MIN); st = out.state;
  assert.equal(out.alerts.length, 0, "80 was already said");
  out = A.evaluate(reading(NOW + 3 * MIN, 100), ON, st, NOW + 3 * MIN); st = out.state;
  assert.equal(out.alerts.length, 1);
  assert.match(out.alerts[0].message, /^Limit reached\. Resets in/);
  // a jump straight past both names only the higher one
  const jump = A.evaluate(reading(NOW, 97), ON, {}, NOW);
  assert.equal(jump.alerts.length, 1);
  assert.equal(jump.state.w.session.fired, 95);
});

test("a new window re-arms the thresholds", function(){
  const A = fresh();
  let out = A.evaluate(reading(NOW, 85), ON, {}, NOW);
  const later = new Date(NOW + 8 * HOUR).toISOString();
  out = A.evaluate(reading(NOW + 6 * HOUR, 81, { reset: later }), ON, out.state, NOW + 6 * HOUR);
  assert.equal(out.alerts.length, 1);
});

test("an older reading landing late is ignored", function(){
  const A = fresh();
  let out = A.evaluate(reading(NOW, 50), ON, {}, NOW);
  out = A.evaluate(reading(NOW - MIN, 90), ON, out.state, NOW);
  assert.equal(out.alerts.length, 0);
});

test("resets are scheduled only for windows that got close", function(){
  const A = fresh();
  let out = A.evaluate(reading(NOW, 40), ON, {}, NOW);
  assert.equal(out.resets.length, 0);
  out = A.evaluate(reading(NOW + MIN, 85), ON, out.state, NOW + MIN);
  assert.deepEqual(out.resets, [{ id: "session", when: NOW + 3 * HOUR }]);
  const noResets = A.evaluate(reading(NOW, 85), Object.assign({}, ON, { resets: false }), {}, NOW);
  assert.equal(noResets.resets.length, 0);
});

test("the reset alarm: told once, not when late, not when off", function(){
  const A = fresh();
  const st = A.evaluate(reading(NOW, 90), ON, {}, NOW).state;
  const when = NOW + 3 * HOUR;
  const hit = A.onReset("session", when, ON, st, when + 5000);
  assert.equal(hit.alert.title, "Session limit has reset");
  assert.match(hit.alert.message, /5-hour session is fresh/);
  assert.equal(A.onReset("session", when, ON, hit.state, when + 6000).alert, null, "only once");
  assert.equal(A.onReset("session", when, ON, st, when + 31 * MIN).alert, null, "too late");
  assert.equal(A.onReset("session", when, { on: false }, st, when).alert, null, "off");
  assert.equal(A.onReset("nope", when, ON, st, when).alert, null, "unknown");
  // once told, the evaluation stops scheduling that window's reset
  const again = A.evaluate(reading(NOW + MIN, 91), ON, hit.state, NOW + MIN);
  assert.equal(again.resets.length, 0);
});

test("extra usage: starts billing, crosses the cap's thresholds, reaches the cap", function(){
  const A = fresh();
  const credits = function(used, cap){ return { enabled: true, used: used, limit: 50, pct: used / 50 * 100, capReached: !!cap, currency: "USD" }; };
  let out = A.evaluate(reading(NOW, 100, { credits: credits(1) }), Object.assign({}, ON, { at: [80] }), {}, NOW);
  assert.deepEqual(out.alerts.map(function(a){ return a.key; }), ["limit:session", "credits"]);
  assert.match(out.alerts[0].message, /keep going at API rates/);
  out = A.evaluate(reading(NOW + MIN, 100, { credits: credits(41) }), Object.assign({}, ON, { at: [80] }), out.state, NOW + MIN);
  assert.deepEqual(out.alerts.map(function(a){ return a.key; }), ["credits-pct"]);
  out = A.evaluate(reading(NOW + 2 * MIN, 100, { credits: credits(50, true) }), Object.assign({}, ON, { at: [80] }), out.state, NOW + 2 * MIN);
  assert.deepEqual(out.alerts.map(function(a){ return a.key; }), ["cap"]);
  // switched off: no credit alerts at all
  const quiet = A.evaluate(reading(NOW, 100, { credits: credits(45) }), Object.assign({}, ON, { at: [80], credits: false }), {}, NOW);
  assert.deepEqual(quiet.alerts.map(function(a){ return a.key; }), ["limit:session"]);
});

test("the free plan has nothing to alert on", function(){
  const A = fresh();
  assert.equal(A.evaluate({ reported: false, fetchedAt: NOW }, ON, {}, NOW).alerts.length, 0);
});

test("several alerts at once become one notice", function(){
  const A = fresh();
  const out = A.evaluate(reading(NOW, 85, { weekly: 96 }), ON, {}, NOW);
  assert.equal(out.alerts.length, 2);
  const one = A.combine(out.alerts);
  assert.equal(one.title, "Claude usage");
  assert.equal(one.message, "Session (5h) at 85% · All models (7d) at 96%");
  assert.equal(A.combine([]), null);
});
