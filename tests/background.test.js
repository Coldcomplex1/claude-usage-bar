// tests/background.test.js: the toolbar badge (background.js), loaded the way
// the browser loads the service worker, against the chrome.* stub.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load");

const HOUR = 3600e3, NOW = Date.parse("2026-10-02T12:00:00Z");
const LOW = "#378add", MID = "#d85a30", HIGH = "#e2564d";

function fresh(){ const chrome = load(["background.js"]); return { chrome, badgeFor: globalThis.badgeFor }; }

function reading(opts){
  const limits = [];
  if (opts.session != null) limits.push({ id: "session", label: "Session", group: "session", pct: opts.session, resetAt: new Date(NOW + 2 * HOUR).toISOString() });
  if (opts.weekly != null) limits.push({ id: "allModels", label: "All models", group: "weekly", pct: opts.weekly, resetAt: new Date(NOW + 72 * HOUR).toISOString() });
  if (opts.fable != null) limits.push({ id: "model:fable", label: "Fable", group: "weekly", pct: opts.fable, resetAt: new Date(NOW + 72 * HOUR).toISOString(), scoped: true });
  return { reported: true, limits: limits, credits: opts.credits || null, fetchedAt: NOW };
}

test("the chosen window, in the bar's colours", function(){
  const { badgeFor } = fresh();
  assert.deepEqual(badgeFor(reading({ session: 42, weekly: 18 }), { source: "session" }, {}, NOW), { text: "42", color: MID });
  assert.deepEqual(badgeFor(reading({ session: 12, weekly: 18 }), { source: "allModels" }, {}, NOW), { text: "18", color: LOW });
  assert.deepEqual(badgeFor(reading({ session: 12, weekly: 85 }), { source: "highest" }, {}, NOW), { text: "85", color: HIGH });
  // custom thresholds move the colours
  assert.equal(badgeFor(reading({ session: 42 }), { source: "session" }, { colors: { mid: 50, high: 90 } }, NOW).color, LOW);
});

test("tightest looks at every limit, per-model ones included", function(){
  const { badgeFor } = fresh();
  assert.equal(badgeFor(reading({ session: 20, weekly: 48, fable: 81 }), { source: "tightest" }, {}, NOW).text, "81");
});

test("a full limit counts down to its reset", function(){
  const { badgeFor } = fresh();
  assert.deepEqual(badgeFor(reading({ session: 100, weekly: 40 }), { source: "session" }, {}, NOW), { text: "2h", color: HIGH });
  assert.deepEqual(badgeFor(reading({ session: 100 }), { source: "session" }, {}, NOW + 2 * HOUR - 20 * 60e3), { text: "20m", color: HIGH });
});

test("extra usage spend on the badge", function(){
  const { badgeFor } = fresh();
  const credits = function(o){ return Object.assign({ enabled: true, used: 12.4, limit: 50, pct: 24.8, capReached: false, currency: "USD" }, o); };
  assert.deepEqual(badgeFor(reading({ session: 40, credits: credits() }), { source: "credits" }, {}, NOW), { text: "$12", color: LOW });
  assert.equal(badgeFor(reading({ session: 100, credits: credits() }), { source: "credits" }, {}, NOW).color, MID);   // billing now
  assert.equal(badgeFor(reading({ session: 100, credits: credits({ used: 50, pct: 100, capReached: true }) }), { source: "credits" }, {}, NOW).color, HIGH);
  assert.equal(badgeFor(reading({ session: 40, credits: credits({ limit: null, pct: null, used: 408.43 }) }), { source: "credits" }, {}, NOW).text, "$408");
});

test("a source with nothing to show falls back instead of going blank", function(){
  const { badgeFor } = fresh();
  // spend-only enterprise account, badge left on "session"
  const spendOnly = reading({ credits: { enabled: true, used: 987.65, limit: null, pct: null, capReached: false, currency: "USD" } });
  assert.equal(badgeFor(spendOnly, { source: "session" }, {}, NOW).text, "$988");
  // asked for credits on an account without any: the tightest limit
  assert.equal(badgeFor(reading({ session: 30, weekly: 60 }), { source: "credits" }, {}, NOW).text, "60");
  assert.equal(badgeFor(null, { source: "session" }, {}, NOW), null);
  assert.equal(badgeFor(reading({}), { source: "session" }, {}, NOW), null);
});

test("renderBadge paints through chrome.action, and clears when off", function(){
  const { chrome } = fresh();
  globalThis.renderBadge(true, { enabled: true, source: "session" }, reading({ session: 55 }), null, {});
  assert.equal(chrome.action._state.text, "55");
  assert.equal(chrome.action._state.color, MID);
  globalThis.renderBadge(true, { enabled: false, source: "session" }, reading({ session: 55 }), null, {});
  assert.equal(chrome.action._state.text, "");
  // free plan: the counted messages, in the neutral colour
  globalThis.renderBadge(true, { enabled: true, source: "session" }, { reported: false }, { count: 7 }, {});
  assert.equal(chrome.action._state.text, "7");
  assert.equal(chrome.action._state.color, LOW);
});

test("the right-click menu is created on install", function(){
  const { chrome } = fresh();
  chrome.runtime.onInstalled._fire({ reason: "update" });
  assert.deepEqual(chrome.contextMenus._items.map(function(m){ return m.id; }), ["cub-refresh", "cub-dashboard"]);
  assert.ok(chrome.contextMenus._items.every(function(m){ return m.contexts[0] === "action"; }));
});
