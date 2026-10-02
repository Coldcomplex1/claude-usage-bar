// tests/session.test.js: the free-plan send counter (session.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, settle } = require("./load");

function fresh(){ const chrome = load(["session.js"]); return { chrome, CUBS: globalThis.CUBS, data: chrome.storage._data }; }

test("decide: only a single bubble at the end of the same conversation counts", function(){
  const { CUBS } = fresh();
  assert.deepEqual(CUBS.decide("/chat/a", "/chat/a", 3, 4, true), { seen: 4, count: 1 });
  assert.deepEqual(CUBS.decide("/chat/a", "/chat/b", 3, 4, true), { seen: 4, count: 0 });   // switched
  assert.deepEqual(CUBS.decide("/chat/a", "/chat/a", 3, 2, true), { seen: 2, count: 0 });   // shrank
  assert.deepEqual(CUBS.decide("/chat/a", "/chat/a", 3, 6, true), { seen: 6, count: 0 });   // history arriving
  assert.deepEqual(CUBS.decide("/chat/a", "/chat/a", 3, 4, false), { seen: 4, count: 0 });  // not at the end
});

test("the rolling window keeps only the last five hours", function(){
  const { CUBS } = fresh();
  const now = Date.now();
  const s = CUBS.summarize({ stamps: [now - 6 * 3600e3, now - 4 * 3600e3, now - 60e3] }, now);
  assert.equal(s.count, 2);
  assert.equal(s.startedAt, now - 4 * 3600e3);
  assert.equal(new Date(s.resetAt).getTime(), now + 3600e3);
  assert.equal(CUBS.summarize(null, now).count, 0);
});

test("recording a send also tallies it into its hour", async function(){
  const { CUBS, data } = fresh();
  await new Promise(function(r){ CUBS.record(1, r); });
  await new Promise(function(r){ CUBS.record(2, r); });
  await settle();
  assert.equal(data.cub_free_session.stamps.length, 3);
  const d = new Date();
  const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  assert.equal(data.cub_activity[key].length, 24);
  assert.equal(data.cub_activity[key][d.getHours()], 3);
});

test("tallies older than ninety days are dropped", function(){
  const { CUBS } = fresh();
  const now = new Date(2026, 9, 2, 12).getTime();
  const old = {}; old["2026-06-01"] = new Array(24).fill(1); old["2026-09-30"] = new Array(24).fill(0);
  const act = CUBS.tally(old, now, 1);
  assert.equal(act["2026-06-01"], undefined);
  assert.equal(act["2026-09-30"].length, 24);
  assert.equal(act["2026-10-02"][12], 1);
});
