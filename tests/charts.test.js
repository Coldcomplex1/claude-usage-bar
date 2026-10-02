// tests/charts.test.js: the pure helpers behind the dashboard charts (charts.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load");

function fresh(){ load(["charts.js"]); return globalThis.CUBC; }

test("axis ticks are clean steps that cover the maximum", function(){
  const C = fresh();
  assert.deepEqual(C.niceTicks(100, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(C.niceTicks(1.4, 4), [0, 0.5, 1, 1.5]);
  assert.deepEqual(C.niceTicks(190, 3), [0, 100, 200]);
  assert.deepEqual(C.niceTicks(0, 4), [0, 1]);
});

test("thinning keeps the peaks and the resets", function(){
  const C = fresh();
  const pts = [];
  for (let i = 0; i < 1000; i++) pts.push({ t: i * 1000, v: i === 500 ? 100 : i === 700 ? 0 : 50 });
  const out = C.thin(pts, 50);
  assert.ok(out.length <= 100, "thinned to two per bucket, got " + out.length);
  assert.ok(out.some(function(p){ return p.v === 100; }), "peak kept");
  assert.ok(out.some(function(p){ return p.v === 0; }), "dip kept");
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t >= out[i - 1].t, "in time order");
  assert.equal(C.thin(pts.slice(0, 10), 50).length, 10);
});

test("the value at a time is the latest reading, if it is recent enough", function(){
  const C = fresh();
  const pts = [{ t: 0, v: 1 }, { t: 100, v: 2 }, { t: 200, v: 3 }];
  assert.equal(C.valueAt(pts, 150, 1000).v, 2);
  assert.equal(C.valueAt(pts, 200, 1000).v, 3);
  assert.equal(C.valueAt(pts, -1, 1000), null);
  assert.equal(C.valueAt(pts, 5000, 1000), null);
});
