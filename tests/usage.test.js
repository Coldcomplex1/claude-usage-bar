// tests/usage.test.js: reading Claude's usage payload (usage.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, settle, fakeFetch } = require("./load");

const HOUR = 3600 * 1000;

function freshCUB(opts){ load(["usage.js"], opts); return globalThis.CUB; }

// The shapes below follow payloads published by other open-source usage
// trackers, with the numbers changed.
const LIST_FIXTURE = {
  limits: [
    { kind: "session", group: "session", percent: 15, severity: "normal",
      resets_at: "2026-07-19T03:39:59.570750+00:00", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 48, severity: "normal",
      resets_at: "2026-07-23T14:59:59.570774+00:00", scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 81, severity: "warning",
      resets_at: "2026-07-23T14:59:59.571131+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true }
  ]
};

test("legacy windows only", function(){
  const CUB = freshCUB();
  const limits = CUB.readLimits({
    five_hour: { utilization: 42, resets_at: "2026-10-02T18:00:00Z" },
    seven_day: { utilization: 18.4, resets_at: "2026-10-08T10:00:00Z" },
    seven_day_opus: null
  });
  assert.deepEqual(limits.map(function(l){ return l.id; }), ["session", "allModels"]);
  assert.equal(limits[0].label, "Session");
  assert.equal(limits[0].sub, "5h");
  assert.equal(limits[1].pct, 18.4);
  assert.equal(limits[1].group, "weekly");
  assert.equal(limits[1].scoped, false);
});

test("every legacy scoped key is read, in a fixed order", function(){
  const CUB = freshCUB();
  const w = { utilization: 10, resets_at: "2026-10-08T10:00:00Z" };
  const limits = CUB.readLimits({
    five_hour: w, seven_day: w, seven_day_opus: w, seven_day_sonnet: w,
    seven_day_cowork: w, seven_day_oauth_apps: w
  });
  assert.deepEqual(limits.map(function(l){ return l.id; }),
    ["session", "allModels", "model:opus", "model:sonnet", "surface:cowork", "surface:oauth-apps"]);
  assert.ok(limits.slice(2).every(function(l){ return l.scoped; }));
  assert.equal(limits[5].label, "Apps");
});

test("the limits list names per-model limits", function(){
  const CUB = freshCUB();
  const limits = CUB.readLimits(LIST_FIXTURE);
  assert.deepEqual(limits.map(function(l){ return l.id; }), ["session", "allModels", "model:fable"]);
  const fable = limits[2];
  assert.equal(fable.label, "Fable");
  assert.equal(fable.sub, "7d");
  assert.equal(fable.pct, 81);
  assert.equal(fable.severity, "warning");
  assert.equal(fable.scoped, true);
  assert.match(fable.tip, /Fable only/);
  assert.equal(fable.resetAt, "2026-07-23T14:59:59.571131+00:00");
});

test("the list wins over the old keys, and old scoped keys are not doubled", function(){
  const CUB = freshCUB();
  const data = Object.assign({}, LIST_FIXTURE, {
    five_hour: { utilization: 99, resets_at: "2026-07-19T03:39:59Z" },
    seven_day: { utilization: 99, resets_at: "2026-07-23T14:59:59Z" },
    seven_day_opus: { utilization: 5, resets_at: "2026-07-23T14:59:59Z" }
  });
  const limits = CUB.readLimits(data);
  assert.deepEqual(limits.map(function(l){ return l.id; }), ["session", "allModels", "model:fable"]);
  assert.equal(limits[0].pct, 15);
});

test("an empty list falls back to the old keys", function(){
  const CUB = freshCUB();
  const limits = CUB.readLimits({ limits: [], five_hour: { utilization: 7 }, seven_day_sonnet: { utilization: 3 } });
  assert.deepEqual(limits.map(function(l){ return l.id; }), ["session", "model:sonnet"]);
});

test("a list with only scoped entries still takes session and week from the old keys", function(){
  const CUB = freshCUB();
  const limits = CUB.readLimits({
    limits: [LIST_FIXTURE.limits[2]],
    five_hour: { utilization: 20 }, seven_day: { utilization: 30 }, seven_day_opus: { utilization: 40 }
  });
  assert.deepEqual(limits.map(function(l){ return l.id; }), ["session", "allModels", "model:fable"]);
});

test("surface scopes, unknown kinds, and entries without a percentage", function(){
  const CUB = freshCUB();
  const limits = CUB.readLimits({ limits: [
    { kind: "weekly_scoped", group: "weekly", percent: 30, scope: { model: null, surface: { id: "cowork" } } },
    { kind: "weekly_scoped", group: "weekly", percent: 12, scope: { surface: "claude_code" } },
    { kind: "monthly_all", group: "monthly", percent: 10 },
    { kind: "session", group: "session", utilization: 55 },
    { kind: "weekly_all", group: "weekly" },
    "garbage", null
  ] });
  const byId = {};
  limits.forEach(function(l){ byId[l.id] = l; });
  assert.deepEqual(limits.map(function(l){ return l.id; }),
    ["session", "surface:cowork", "surface:claude-code", "kind:monthly-all"]);
  assert.equal(byId["surface:cowork"].label, "Cowork");
  assert.equal(byId["surface:claude-code"].label, "Claude Code");
  assert.equal(byId["kind:monthly-all"].label, "Monthly all");
  assert.equal(byId["kind:monthly-all"].sub, "");
  assert.equal(byId.session.pct, 55);
});

test("percentages are clamped to 0-100", function(){
  const CUB = freshCUB();
  const limits = CUB.readLimits({ limits: [{ kind: "session", percent: 140 }, { kind: "weekly_all", percent: -5 }] });
  assert.equal(limits[0].pct, 100);
  assert.equal(limits[1].pct, 0);
});

test("credits from the spend block", function(){
  const CUB = freshCUB();
  const c = CUB.readCredits({ spend: {
    used: { amount_minor: 1240, currency: "USD", exponent: 2 },
    limit: { amount_minor: 5000, currency: "USD", exponent: 2 },
    percent: 25, severity: "normal", enabled: true, balance: { amount_minor: 2500, currency: "USD", exponent: 2 },
    auto_reload: { enabled: true }
  } });
  assert.equal(c.enabled, true);
  assert.equal(c.used, 12.4);
  assert.equal(c.limit, 50);
  assert.equal(c.pct, 24.8);
  assert.equal(c.currency, "USD");
  assert.equal(c.balance, 25);
  assert.equal(c.autoReload, true);
  assert.equal(c.capReached, false);
});

test("credits from extra_usage alone: minor units, no cap", function(){
  const CUB = freshCUB();
  const c = CUB.readCredits({ extra_usage: {
    is_enabled: true, monthly_limit: null, used_credits: 40843.0, utilization: null,
    currency: "USD", decimal_places: 2, disabled_reason: null
  } });
  assert.equal(c.used, 408.43);
  assert.equal(c.limit, null);
  assert.equal(c.pct, null);
  assert.equal(c.autoReload, null);
});

test("spend wins, extra_usage fills what it leaves out", function(){
  const CUB = freshCUB();
  const c = CUB.readCredits({
    spend: { used: { amount_minor: 40843, currency: "USD", exponent: 2 }, limit: null, enabled: true },
    extra_usage: { is_enabled: true, monthly_limit: 100000, used_credits: 1, currency: "USD", decimal_places: 2 }
  });
  assert.equal(c.used, 408.43);
  assert.equal(c.limit, 1000);
  assert.ok(Math.abs(c.pct - 40.843) < 1e-9);
});

test("the cap being reached, either way Claude says it", function(){
  const CUB = freshCUB();
  assert.equal(CUB.readCredits({ extra_usage: { is_enabled: true, used_credits: 100, monthly_limit: 5000, spend_limit_reached: true } }).capReached, true);
  assert.equal(CUB.readCredits({ extra_usage: { is_enabled: true, used_credits: 5000, monthly_limit: 5000 } }).capReached, true);
  assert.equal(CUB.readCredits({ extra_usage: { is_enabled: true, used_credits: 5000, monthly_limit: 5000 } }).pct, 100);
});

test("switched off: shown only when something was spent", function(){
  const CUB = freshCUB();
  assert.equal(CUB.readCredits({ extra_usage: { is_enabled: false, used_credits: 0, monthly_limit: 5000 } }), null);
  const c = CUB.readCredits({ extra_usage: { is_enabled: false, used_credits: 320, user_disabled: true, disabled_reason: "user_disabled" } });
  assert.equal(c.enabled, false);
  assert.equal(c.used, 3.2);
  assert.equal(c.disabledReason, "user_disabled");
});

test("garbage credits blocks read as nothing", function(){
  const CUB = freshCUB();
  assert.equal(CUB.readCredits(null), null);
  assert.equal(CUB.readCredits({}), null);
  assert.equal(CUB.readCredits({ spend: "x", extra_usage: 5 }), null);
  assert.equal(CUB.readCredits({ spend: { used: { amount_minor: "abc" } } }), null);
  // a zero cap is no cap, not a permanently full one
  assert.equal(CUB.readCredits({ extra_usage: { is_enabled: true, used_credits: 10, monthly_limit: 0 } }).limit, null);
});

test("plan tier", function(){
  const CUB = freshCUB();
  assert.equal(CUB.tierLabel("default_claude_max_20x", null), "Max 20x");
  assert.equal(CUB.tierLabel("default_claude_max_5x", null), "Max 5x");
  assert.equal(CUB.tierLabel(null, ["chat", "claude_pro"]), "Pro");
  assert.equal(CUB.tierLabel("default_claude_ai", ["chat"]), "Free");
  assert.equal(CUB.tierLabel(null, null), "");
});

test("old cached readings still yield a list of limits", function(){
  const CUB = freshCUB();
  const limits = CUB.limitsOf({
    session: { available: true, pct: 30, resetAt: "2026-10-02T18:00:00Z" },
    allModels: { available: false, pct: null, resetAt: null },
    opus: { available: true, pct: 12, resetAt: "2026-10-08T10:00:00Z" },
    reported: true
  });
  assert.deepEqual(limits.map(function(l){ return l.id; }), ["session", "model:opus"]);
  assert.equal(CUB.limitsOf(null).length, 0);
});

test("credits in use: a full limit with extra usage on and the cap not reached", function(){
  const CUB = freshCUB();
  const full = [{ id: "session", pct: 100 }], half = [{ id: "session", pct: 50 }];
  const on = { enabled: true, capReached: false };
  assert.equal(CUB.creditsInUse({ limits: full, credits: on }), true);
  assert.equal(CUB.creditsInUse({ limits: half, credits: on }), false);
  assert.equal(CUB.creditsInUse({ limits: full, credits: { enabled: false } }), false);
  assert.equal(CUB.creditsInUse({ limits: full, credits: { enabled: true, capReached: true } }), false);
  assert.equal(CUB.creditsInUse({ limits: full, credits: null }), false);
});

test("colour levels, default and custom", function(){
  const CUB = freshCUB();
  assert.equal(CUB.colorLevel(29), "low");
  assert.equal(CUB.colorLevel(30), "mid");
  assert.equal(CUB.colorLevel(80), "mid");
  assert.equal(CUB.colorLevel(81), "high");
  const prefs = { colors: { mid: 50, high: 90 } };
  assert.equal(CUB.colorLevel(49, prefs), "low");
  assert.equal(CUB.colorLevel(90, prefs), "mid");
  assert.equal(CUB.colorLevel(91, prefs), "high");
  // an unusable pair falls back to the defaults
  assert.equal(CUB.colorLevel(40, { colors: { mid: 90, high: 50 } }), "mid");
  assert.equal(CUB.colorLevel(null), "");
});

test("pace: the share of the window gone by", function(){
  const CUB = freshCUB();
  const now = Date.parse("2026-10-02T12:00:00Z");
  const session = { group: "session", pct: 60, resetAt: new Date(now + 2.5 * HOUR).toISOString() };
  const p = CUB.paceOf(session, now);
  assert.equal(Math.round(p.expected), 50);
  assert.equal(Math.round(p.delta), 10);
  assert.equal(CUB.paceText(p), "10% over an even pace");
  const week = { group: "weekly", pct: 10, resetAt: new Date(now + 3.5 * 24 * HOUR).toISOString() };
  assert.equal(CUB.paceText(CUB.paceOf(week, now)), "40% under an even pace");
  assert.equal(CUB.paceOf({ group: "weekly", pct: 1, resetAt: new Date(now - HOUR).toISOString() }, now), null);
  assert.equal(CUB.paceOf({ group: "monthly", pct: 1, resetAt: new Date(now + HOUR).toISOString() }, now), null);
  assert.equal(CUB.paceOf({ group: "session", pct: 1, resetAt: null }, now), null);
});

test("forecast: warns when the limit runs out before it resets", function(){
  const CUB = freshCUB();
  const now = Date.parse("2026-10-02T12:00:00Z");
  const resetAt = new Date(now + 3 * HOUR).toISOString();
  const limit = { id: "session", group: "session", pct: 60, resetAt: resetAt };
  const warn = CUB.forecastOf(limit, { rate: 60, fullAt: now + 40 * 60000, projected: 100, resetAt: resetAt }, now);
  assert.equal(warn.warn, true);
  assert.match(warn.text, /full in ~40m \(resets in 3h 0m\)/);
  const calm = CUB.forecastOf(limit, { rate: 5, fullAt: now + 8 * HOUR, projected: 75, resetAt: resetAt }, now);
  assert.equal(calm.warn, false);
  assert.match(calm.text, /~75% by the reset/);
  // another window's insight says nothing about this one
  assert.equal(CUB.forecastOf(limit, { rate: 60, fullAt: now + 1, resetAt: "2026-10-01T00:00:00Z" }, now), null);
  assert.equal(CUB.forecastOf(Object.assign({}, limit, { pct: 100 }), { rate: 60, fullAt: now + 1 }, now), null);
  assert.equal(CUB.forecastOf(limit, null, now), null);
});

test("money formatting", function(){
  const CUB = freshCUB();
  assert.match(CUB.fmtMoney(12.4, "USD"), /12[.,]40/);
  assert.doesNotMatch(CUB.fmtMoney(50, "USD", true), /[.,]00/);
  assert.equal(CUB.fmtMoney(null, "USD"), "–");
  assert.ok(CUB.fmtMoney(5, "NOT-A-CURRENCY").length > 0);
  assert.equal(CUB.fmtShortMoney(12.4, "USD"), "$12");
  assert.equal(CUB.fmtShortMoney(408.43, "USD"), "$408");
  assert.equal(CUB.fmtShortMoney(4321, "USD"), "$4k");
  assert.equal(CUB.fmtShortMoney(12345, "USD"), "$12k");
  assert.equal(CUB.fmtShortMoney(123456, "USD"), "123k");
});

test("short spans for the badge", function(){
  const CUB = freshCUB();
  assert.equal(CUB.fmtShortSpan(45 * 60000), "45m");
  assert.equal(CUB.fmtShortSpan(59.5 * 60000), "1h");
  assert.equal(CUB.fmtShortSpan(2 * HOUR + 10 * 60000), "2h");
  assert.equal(CUB.fmtShortSpan(3 * 24 * HOUR), "3d");
  assert.equal(CUB.fmtShortSpan(-1), "0m");
});

const ORGS = [
  { uuid: "org-free", name: "Personal", capabilities: ["chat"] },
  { uuid: "org-max", name: "Work", capabilities: ["chat", "claude_max"], rate_limit_tier: "default_claude_max_20x" }
];

test("a fetch end to end: best org, tier, limits and credits", async function(){
  const usage = Object.assign({}, LIST_FIXTURE, {
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1240, currency: "USD", decimal_places: 2 }
  });
  const chrome = load(["usage.js"], { fetch: fakeFetch({
    "/organizations/org-free/usage": {},
    "/organizations/org-max/usage": usage,
    "/organizations": ORGS
  }) });
  const r = await globalThis.CUB.getUsage();
  assert.equal(r.orgId, "org-max");
  assert.equal(r.tier, "Max 20x");
  assert.equal(r.reported, true);
  assert.deepEqual(r.limits.map(function(l){ return l.id; }), ["session", "allModels", "model:fable"]);
  assert.equal(r.credits.used, 12.4);
  assert.equal(r.credits.label, "Extra usage");
  // the old fields are still there for anything that reads them
  assert.equal(r.session.pct, 15);
  assert.equal(r.allModels.pct, 48);
  assert.equal(r.opus.available, false);
  await settle();
  assert.equal(chrome.storage._data.cub_org.tier, "default_claude_max_20x");
});

test("a spend-only enterprise account is a paying one, not a free one", async function(){
  load(["usage.js"], { fetch: fakeFetch({
    "/organizations/org-ent/usage": { spend: { used: { amount_minor: 98765, currency: "USD", exponent: 2 }, limit: null, enabled: true } },
    "/organizations": [{ uuid: "org-ent", name: "Acme", capabilities: ["chat", "claude_enterprise"] }]
  }) });
  const r = await globalThis.CUB.getUsage();
  assert.equal(r.reported, true);
  assert.equal(r.reason, null);
  assert.equal(r.limits.length, 0);
  assert.equal(r.credits.label, "Spend");
  assert.equal(r.credits.used, 987.65);
});

test("a free account still reads as not reported", async function(){
  load(["usage.js"], { fetch: fakeFetch({
    "/organizations/org-free/usage": { five_hour: null, seven_day: null, extra_usage: { is_enabled: false, used_credits: 0 } },
    "/organizations": [ORGS[0]]
  }) });
  const r = await globalThis.CUB.getUsage();
  assert.equal(r.reported, false);
  assert.equal(r.reason, "NO_WINDOWS");
  assert.equal(r.credits, null);
  assert.equal(r.tier, "Free");
});
