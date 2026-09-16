// tests/run.js -- run with: node --test tests/
//
// No dependencies and no package.json, so the repo keeps its "clone it and load
// it unpacked" property. The extension's files are plain IIFEs that assign to a
// bare `var`, which is exactly what makes this possible: each one is evaluated
// in a vm context holding a stub `chrome`, and the globals it defines come back
// out. Nothing is modified to be testable.
//
// What is covered is the logic that decides what the user is told: the counting
// rule, the anchored window, the limit-notice parser, and the estimator's
// fallbacks. The DOM plumbing around them is verified by hand (see the README).

var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");

var SRC = path.join(__dirname, "..", "claude-extension");

// A storage stub with the two shapes chrome.storage.local is called in: get(keys,
// cb) and set(obj, cb). Synchronous callbacks are fine here -- the code under
// test never depends on them deferring.
function makeChrome(seed){
  var store = Object.assign({}, seed || {});
  return {
    store: store,
    storage: {
      local: {
        get: function (keys, cb){
          var k = Array.isArray(keys) ? keys : (typeof keys === "string" ? [keys] : Object.keys(keys || {}));
          var out = {};
          k.forEach(function (key){ if (key in store) out[key] = store[key]; });
          cb(out);
        },
        set: function (obj, cb){ Object.assign(store, obj); if (cb) cb(); },
        remove: function (keys, cb){
          (Array.isArray(keys) ? keys : [keys]).forEach(function (k){ delete store[k]; });
          if (cb) cb();
        }
      }
    }
  };
}

// Evaluate the sources in THIS realm rather than a vm context. A vm gives each
// context its own Object.prototype, so every object the extension builds comes
// back cross-realm and deepStrictEqual refuses it on prototype grounds alone.
// A Function body is isolation enough here: the files declare their namespaces
// with `var`, so each load gets its own and nothing leaks between tests.
var NAMES = ["CUB", "CUBS", "CUBE"];

function load(files, seed){
  var chrome = makeChrome(seed);
  var src = files.map(function (f){
    return "//# " + f + "\n" + fs.readFileSync(path.join(SRC, f), "utf8");
  }).join("\n;\n");
  var ret = NAMES.map(function (n){
    return n + ": typeof " + n + ' !== "undefined" ? ' + n + " : undefined";
  }).join(", ");
  var out = new Function("chrome", src + "\n;return { " + ret + ", __chrome: chrome };")(chrome);
  return out;
}

var HOUR = 3600000;
var W = 5 * HOUR;

// ===================================================================
// session.js -- the counting rule
// ===================================================================

test("decide: only a single bubble appearing at the end is a send", function (t){
  var CUBS = load(["session.js"]).CUBS;

  // The one case that counts.
  assert.deepStrictEqual(CUBS.decide("/chat/a", "/chat/a", 3, 4, true), { seen: 4, count: 1 });

  // A conversation switch re-baselines and counts nothing, however many arrived.
  assert.deepStrictEqual(CUBS.decide("/chat/a", "/chat/b", 3, 9, true), { seen: 9, count: 0 });
  // A re-render that drops bubbles is not a send.
  assert.deepStrictEqual(CUBS.decide("/chat/a", "/chat/a", 5, 2, true), { seen: 2, count: 0 });
  // Several at once is history arriving, not a burst of sends.
  assert.deepStrictEqual(CUBS.decide("/chat/a", "/chat/a", 1, 4, true), { seen: 4, count: 0 });
  // Appearing above the end is history too.
  assert.deepStrictEqual(CUBS.decide("/chat/a", "/chat/a", 3, 4, false), { seen: 4, count: 0 });
  // No change at all.
  assert.deepStrictEqual(CUBS.decide("/chat/a", "/chat/a", 4, 4, true), { seen: 4, count: 0 });
});

// ===================================================================
// session.js -- the anchored window (the bug this release fixes)
// ===================================================================

test("summarize: the window is anchored, not sliding", function (t){
  var CUBS = load(["session.js"]).CUBS;
  var t0 = 1700000000000;   // window opens here

  // Messages at 0:00 and 4:00, read at 4:30 -- both still inside the window.
  var mid = CUBS.summarize({ stamps: [t0, t0 + 4 * HOUR], windowStart: t0 }, t0 + 4.5 * HOUR);
  assert.strictEqual(mid.count, 2);
  assert.strictEqual(mid.resetAt, new Date(t0 + W).toISOString());

  // Read at 5:00, one minute past the reset. Claude has cleared the window, so
  // the count is 0 -- the old sliding model said "1 message, resets in 4h",
  // which told people they were partway through a window that had restarted.
  var after = CUBS.summarize({ stamps: [t0, t0 + 4 * HOUR], windowStart: t0 }, t0 + W + 60000);
  assert.strictEqual(after.count, 0);
  assert.strictEqual(after.startedAt, null);
  assert.strictEqual(after.resetAt, null);
});

test("summarize: a send after the reset opens the next window", function (t){
  var CUBS = load(["session.js"]).CUBS;
  var t0 = 1700000000000;
  var next = t0 + W + 10 * 60000;   // ten minutes into the new window

  var s = CUBS.summarize({ stamps: [t0, t0 + HOUR, next], windowStart: t0 }, next + 60000);
  assert.strictEqual(s.count, 1, "only the send after the reset survives");
  assert.strictEqual(s.startedAt, next);
  assert.strictEqual(s.resetAt, new Date(next + W).toISOString());
});

test("summarize: several elapsed windows collapse without leaking a count", function (t){
  var CUBS = load(["session.js"]).CUBS;
  var t0 = 1700000000000;
  // Away for three windows; nothing sent since.
  var s = CUBS.summarize({ stamps: [t0, t0 + HOUR], windowStart: t0 }, t0 + 3 * W);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.startedAt, null);
});

test("summarize: an observed anchor can predate anything we counted", function (t){
  var CUBS = load(["session.js"]).CUBS;
  var t0 = 1700000000000;
  // Installed mid-window: our first sighting is at 3:00, but Claude's stated
  // reset says the window actually opened at 0:00. The countdown must follow
  // Claude, not our first sighting -- this is the install-mid-window fix.
  var s = CUBS.summarize({ stamps: [t0 + 3 * HOUR], windowStart: t0, anchored: true }, t0 + 3.5 * HOUR);
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.startedAt, t0);
  assert.strictEqual(s.resetAt, new Date(t0 + W).toISOString());
  assert.strictEqual(s.anchored, true);
});

test("prune: legacy bare numbers and {t,u} entries mix, and MAX_STAMPS holds", function (t){
  var CUBS = load(["session.js"]).CUBS;
  var t0 = 1700000000000;

  // The upgrade needs no migration: an old bare-number entry is still read.
  var mixed = CUBS.prune([t0, { t: t0 + 60000, u: 42 }], t0 + HOUR);
  assert.deepStrictEqual(mixed, [{ t: t0, u: 0 }, { t: t0 + 60000, u: 42 }]);

  // Junk is dropped rather than counted.
  assert.deepStrictEqual(CUBS.prune([null, "x", NaN, {}, { t: "no" }], t0), []);

  // Far-future stamps (a clock skewed forward) are not accepted as sends.
  assert.deepStrictEqual(CUBS.prune([t0 + 10 * 60000], t0), []);

  var many = [];
  for (var i = 0; i < 700; i++) many.push(t0 + i);
  assert.strictEqual(CUBS.prune(many, t0 + HOUR).length, 600);
});

test("summarize: units add up across the window", function (t){
  var CUBS = load(["session.js"]).CUBS;
  var t0 = 1700000000000;
  var s = CUBS.summarize({ stamps: [{ t: t0, u: 100 }, { t: t0 + HOUR, u: 250 }], windowStart: t0 },
                         t0 + 2 * HOUR);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.units, 350);
});

test("record: the first send after a reset opens the window", function (t){
  var ctx = load(["session.js"]);
  var CUBS = ctx.CUBS;
  var done = false;
  CUBS.record(1, 0, function (s){
    assert.strictEqual(s.count, 1);
    assert.strictEqual(typeof s.startedAt, "number");
    assert.ok(Math.abs(s.startedAt - Date.now()) < 5000);
    done = true;
  });
  assert.ok(done, "callback ran");
});

test("setWindowStart: Claude's stated reset wins over our own anchor", function (t){
  var t0 = Date.now() - 3 * HOUR;
  var ctx = load(["session.js"], {
    cub_free_session: { stamps: [{ t: t0 + 2 * HOUR, u: 0 }], windowStart: t0 + 2 * HOUR }
  });
  var got = null;
  ctx.CUBS.setWindowStart(t0, function (s){ got = s; });
  assert.ok(got, "callback ran");
  assert.strictEqual(got.startedAt, t0, "anchor moved back to Claude's");
  assert.strictEqual(got.anchored, true);
  assert.strictEqual(got.count, 1, "the send we counted is still inside it");
});

// ===================================================================
// estimate.js -- clock parsing
// ===================================================================

test("clockToIso: a wall-clock time resolves to the next time it reads that", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var noon = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();

  assert.strictEqual(new Date(CUBE.clockToIso("4 PM", noon)).getHours(), 16);
  assert.strictEqual(new Date(CUBE.clockToIso("4:30pm", noon)).getMinutes(), 30);
  assert.strictEqual(new Date(CUBE.clockToIso("16:00", noon)).getHours(), 16);

  // Midnight and noon are the two the 12-hour clock gets wrong if you are casual.
  assert.strictEqual(new Date(CUBE.clockToIso("12 AM", noon)).getHours(), 0);
  assert.strictEqual(new Date(CUBE.clockToIso("12:30 PM", noon)).getHours(), 12);

  // Already gone today means tomorrow.
  var iso = CUBE.clockToIso("9 AM", noon);
  assert.strictEqual(new Date(iso).getDate(), 16);

  // A bare number is not a time -- this is what stops "5 more messages" from
  // parsing as five o'clock.
  assert.strictEqual(CUBE.clockToIso("5", noon), null);
  assert.strictEqual(CUBE.clockToIso("25:00", noon), null);
  assert.strictEqual(CUBE.clockToIso("13 PM", noon), null);
  assert.strictEqual(CUBE.clockToIso("", noon), null);
  assert.strictEqual(CUBE.clockToIso(null, noon), null);
});

// ===================================================================
// estimate.js -- the limit-notice parser
// ===================================================================

test("parseLimitText: reads the figures Claude states", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var noon = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();

  var a = CUBE.parseLimitText("5 messages remaining until 4 PM", noon);
  assert.strictEqual(a.kind, "remaining");
  assert.strictEqual(a.n, 5);
  assert.strictEqual(new Date(a.resetAt).getHours(), 16);

  assert.strictEqual(CUBE.parseLimitText("You have 12 messages left", noon).n, 12);

  var b = CUBE.parseLimitText("You're out of free messages until 4:00 PM", noon);
  assert.strictEqual(b.kind, "exhausted");
  assert.strictEqual(new Date(b.resetAt).getHours(), 16);

  assert.strictEqual(CUBE.parseLimitText("Message limit reached", noon).kind, "exhausted");

  // A reset time on its own still anchors the window.
  var c = CUBE.parseLimitText("Try again at 2:30 PM", noon);
  assert.strictEqual(c.kind, "reset");
  assert.strictEqual(new Date(c.resetAt).getHours(), 14);
});

test("parseLimitText: refuses what is not a limit notice", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var noon = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();

  assert.strictEqual(CUBE.parseLimitText("Hello there", noon), null);
  assert.strictEqual(CUBE.parseLimitText("42", noon), null);
  assert.strictEqual(CUBE.parseLimitText("", noon), null);
  assert.strictEqual(CUBE.parseLimitText(null, noon), null);

  // Long text is a transcript, not a banner.
  assert.strictEqual(CUBE.parseLimitText("x".repeat(401) + " 5 messages left", noon), null);

  // A reset more than a window away is some other time printed on the page.
  assert.strictEqual(CUBE.parseLimitText("Back at 11 PM", noon), null);

  // "3 messages" with no "left"/"remaining" is not a statement about the limit.
  assert.strictEqual(CUBE.parseLimitText("I sent 3 messages", noon), null);

  // Prose that happens to contain the words. These are the ones that would put a
  // wrong number on screen, so they matter more than the positive cases.
  assert.strictEqual(CUBE.parseLimitText("the 5 message limit was raised", noon), null);
  assert.strictEqual(CUBE.parseLimitText("How many messages do I have?", noon), null);

  // Out of range: a free window is tens of messages, not thousands. A match this
  // size means we read something that was not a limit notice.
  assert.strictEqual(CUBE.parseLimitText("1000 messages remaining", noon), null);
});

test("parseLimitText: a stated total is read as one", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var noon = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();

  var a = CUBE.parseLimitText("3 of 5 messages used", noon);
  assert.strictEqual(a.kind, "usedOf");
  assert.strictEqual(a.used, 3);
  assert.strictEqual(a.cap, 5);
  assert.strictEqual(a.n, 2);

  assert.strictEqual(CUBE.parseLimitText("2/8 messages", noon).cap, 8);

  // Used above the total is not a reading, it is a misparse.
  assert.strictEqual(CUBE.parseLimitText("9 of 5 messages", noon), null);
});

// ===================================================================
// estimate.js -- what an observation implies
// ===================================================================

test("capFrom: a hard stop is an exact cap, a remaining count adds to ours", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var start = Date.now() - HOUR;

  var hard = CUBE.capFrom({ kind: "exhausted", n: 0 },
                          { count: 23, units: 900, startedAt: start }, start - 1000);
  assert.strictEqual(hard.cap, 23);
  assert.strictEqual(hard.whole, true, "we watched this window from its start");

  var soft = CUBE.capFrom({ kind: "remaining", n: 4 },
                          { count: 19, units: 700, startedAt: start }, start - 1000);
  assert.strictEqual(soft.cap, 23);

  // Installed after the window opened: our count is short by whatever happened
  // first, so the cap is a lower bound and is marked as one.
  var partial = CUBE.capFrom({ kind: "exhausted", n: 0 },
                             { count: 8, units: 300, startedAt: start }, start + 60000);
  assert.strictEqual(partial.whole, false);

  // A hole in the watch (browser shut mid-window) is the same problem as
  // installing mid-window, and is marked the same way.
  var holed = CUBE.capFrom({ kind: "exhausted", n: 0 },
                           { count: 8, units: 0, startedAt: start, gap: true }, start - 1000);
  assert.strictEqual(holed.whole, false);

  assert.strictEqual(CUBE.capFrom({ kind: "reset" }, { count: 1 }, 0), null);
  assert.strictEqual(CUBE.capFrom(null, null, 0), null);
});

test("summarize: a watch gap only applies to the window it happened in", function (t){
  var CUBS = load(["session.js"]).CUBS;
  var t0 = 1700000000000;

  var same = CUBS.summarize({ stamps: [t0], windowStart: t0, gap: true }, t0 + HOUR);
  assert.strictEqual(same.gap, true);

  // The window rolled over; the hole belongs to the one that closed.
  var rolled = CUBS.summarize({ stamps: [t0, t0 + W + 60000], windowStart: t0, gap: true },
                              t0 + W + 120000);
  assert.strictEqual(rolled.gap, false);
});

test("the ethic, as an assertion: no percentage without a cap", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var start = Date.now() - HOUR;
  var kinds = ["remaining", "exhausted", "usedOf", "reset", "junk"];
  var checked = 0;

  for (var c = 0; c <= 30; c += 3){
    for (var k = 0; k < kinds.length; k++){
      for (var w = 0; w < 2; w++){
        for (var n = 0; n <= 10; n += 5){
          var calib = kinds[k] === "junk" ? null : { caps: [{
            at: start + 60000, cap: c + n, count: c, used: c, kind: kinds[k],
            whole: !!w, stated: kinds[k] === "usedOf"
          }] };
          var e = CUBE.estimate({ count: c, units: 0, startedAt: start }, calib);
          checked++;
          // The rule the whole feature rests on: a percentage on screen always
          // has a denominator behind it. If a refactor ever invents one, this
          // is what fails.
          // Either a real denominator, or Claude saying outright that there
          // is nothing left. Never a number we made up.
          if (e.pct != null) assert.ok((e.cap != null && e.cap > 0) || e.left === 0,
            "pct " + e.pct + " with no cap, for " + kinds[k] + " whole=" + !!w);
          assert.ok(e.pct === null || (e.pct >= 0 && e.pct <= 100), "pct in range");
        }
      }
    }
  }
  assert.ok(checked > 200, "exercised " + checked + " combinations");
});

test("median: ignores junk, handles even and odd", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  assert.strictEqual(CUBE.median([5, 1, 3]), 3);
  assert.strictEqual(CUBE.median([1, 2, 3, 4]), 2.5);
  assert.strictEqual(CUBE.median([0, -1, NaN, null, 7]), 7);
  assert.strictEqual(CUBE.median([]), null);
});

test("currentObs: an observation from a past window does not apply to this one", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var start = Date.now() - HOUR;
  var calib = { caps: [
    { at: start - 2 * W, cap: 30, count: 30, kind: "exhausted" },   // an old window
    { at: start + 600000, cap: 25, count: 20, kind: "remaining" }   // this one
  ] };
  var obs = CUBE.currentObs(calib, { count: 22, startedAt: start });
  assert.strictEqual(obs.cap, 25);
  // With no window open, nothing applies.
  assert.strictEqual(CUBE.currentObs(calib, { count: 0, startedAt: null }), null);
});

// ===================================================================
// estimate.js -- the estimator
// ===================================================================

test("estimate: no calibration means a count, never a percentage", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var e = CUBE.estimate({ count: 7, units: 0, startedAt: Date.now() - HOUR }, null);
  assert.strictEqual(e.confidence, "counted");
  assert.strictEqual(e.pct, null, "a null pct is what tells the bar to draw a count");
  assert.strictEqual(e.count, 7);
});

test("estimate: Claude's stated figure becomes a real percentage", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var start = Date.now() - HOUR;
  // Claude said 5 left when we had counted 20, so the cap is 25. We have since
  // sent 2 more: 22 of 25.
  var calib = { caps: [{ at: start + 60000, cap: 25, count: 20, kind: "remaining", whole: true }] };
  var e = CUBE.estimate({ count: 22, units: 0, startedAt: start }, calib);
  assert.strictEqual(e.confidence, "observed");
  assert.strictEqual(e.cap, 25);
  assert.strictEqual(e.left, 3);
  assert.strictEqual(e.pct, 88);
});

test("estimate: a cap derived from an incomplete count draws no bar", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var start = Date.now() - HOUR;
  // We did not see this window open, so our count is a floor: cap = count + left
  // comes out too small and the percentage too big. Showing "5 left" with no bar
  // is the honest reading -- a wrong bar would say "nearly out" to someone who
  // is not.
  var calib = { caps: [{ at: start + 60000, cap: 25, count: 20, kind: "remaining", whole: false }] };
  var e = CUBE.estimate({ count: 22, units: 0, startedAt: start }, calib);
  assert.strictEqual(e.confidence, "observed");
  assert.strictEqual(e.pct, null, "no denominator we trust means no bar");
  assert.strictEqual(e.left, 3, "but the figure Claude gave is still shown");
});

test("estimate: a cap Claude stated outright survives an incomplete count", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var start = Date.now() - HOUR;
  // "3 of 5 messages" does not depend on our count at all, so the partial-window
  // problem above does not apply to it.
  var calib = { caps: [{ at: start + 60000, cap: 5, count: 3, used: 3,
                         kind: "usedOf", whole: false, stated: true }] };
  var e = CUBE.estimate({ count: 3, units: 0, startedAt: start }, calib);
  assert.strictEqual(e.pct, 60, "3 used of 5 is 60% used");
  assert.strictEqual(e.left, 2);
});

test("estimate: a hard stop reads 100%, whatever our own count says", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var start = Date.now() - HOUR;
  var calib = { caps: [{ at: start + 60000, cap: 9, count: 9, kind: "exhausted", whole: true }] };
  // Our count is short (messages sent from a phone we never saw) and it does not
  // matter: Claude stopped us, so the window is spent.
  var e = CUBE.estimate({ count: 4, units: 0, startedAt: start }, calib);
  assert.strictEqual(e.confidence, "observed");
  assert.strictEqual(e.pct, 100);
  assert.strictEqual(e.left, 0);
});

test("estimate: exactly spending the stated figure reads 100% and 0 left", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var start = Date.now() - HOUR;
  // Claude said 2 left when we had counted 8; we have sent exactly 2 since.
  var calib = { caps: [{ at: start + 60000, cap: 10, count: 8, kind: "remaining", whole: true }] };
  var e = CUBE.estimate({ count: 10, units: 0, startedAt: start }, calib);
  assert.strictEqual(e.pct, 100);
  assert.strictEqual(e.left, 0);
});

test("estimate: a figure overtaken by events is dropped, not shown as 0 left", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var start = Date.now() - HOUR;
  // Claude said 2 left when we had counted 8. We have since sent 32 more and
  // were never stopped, so the cap moved and that figure no longer describes
  // anything. Saying "0 left" to someone still happily chatting is worse than
  // saying nothing, so it falls back to the count.
  var calib = { caps: [{ at: start + 60000, cap: 10, count: 8, kind: "remaining", whole: true }] };
  var e = CUBE.estimate({ count: 40, units: 0, startedAt: start }, calib);
  assert.strictEqual(e.pct, null);
  assert.strictEqual(e.left, null);
  assert.strictEqual(e.count, 40);
});

test("estimate: survives being handed nothing", function (t){
  var CUBE = load(["session.js", "estimate.js"]).CUBE;
  var e = CUBE.estimate(null, null);
  assert.strictEqual(e.confidence, "counted");
  assert.strictEqual(e.count, 0);
  assert.strictEqual(e.pct, null);
});

// ===================================================================
// usage.js -- the payload reader (written to be tested, never was)
// ===================================================================

test("CUB.summarize: reads utilization, used/limit and remaining/limit alike", function (t){
  var CUB = load(["usage.js"]).CUB;

  var a = CUB.summarize({ five_hour: { utilization: 42, resets_at: "2026-01-15T16:00:00Z" } });
  assert.strictEqual(a.session.available, true);
  assert.strictEqual(a.session.pct, 42);

  assert.strictEqual(CUB.summarize({ seven_day: { used: 30, limit: 120 } }).allModels.pct, 25);
  assert.strictEqual(CUB.summarize({ seven_day: { remaining: 90, limit: 120 } }).allModels.pct, 25);

  // camelCase and the alternative key spellings still land.
  assert.strictEqual(CUB.summarize({ sevenDayOpus: { utilization: 60 } }).opus.pct, 60);

  // Out-of-range percentages are clamped, as the free estimator also clamps.
  assert.strictEqual(CUB.summarize({ five_hour: { utilization: 140 } }).session.pct, 100);

  // Nothing in it is the free plan: every window unavailable, no invented zero.
  var none = CUB.summarize({});
  assert.strictEqual(none.session.available, false);
  assert.strictEqual(none.session.pct, null);
});

test("CUB.summarize: reset times in seconds, milliseconds or ISO", function (t){
  var CUB = load(["usage.js"]).CUB;
  var secs = CUB.summarize({ five_hour: { utilization: 1, resets_at: 1767024000 } });
  var ms   = CUB.summarize({ five_hour: { utilization: 1, resetsAt: 1767024000000 } });
  assert.strictEqual(secs.session.resetAt, ms.session.resetAt);
  assert.strictEqual(CUB.summarize({ five_hour: { utilization: 1, resets_at: "nope" } }).session.resetAt, null);
});

test("CUB.freeHold: armed by a stored result, never by a failure", function (t){
  var CUB = load(["usage.js"]).CUB;
  assert.strictEqual(CUB.freeHold({ reported: false, fetchedAt: Date.now() }), true);
  assert.strictEqual(CUB.freeHold({ reported: false, fetchedAt: Date.now() - 25 * HOUR }), false);
  assert.strictEqual(CUB.freeHold({ reported: true, fetchedAt: Date.now() }), false);
  // No stored result at all -- an outage must never park a paid account on the
  // free readout.
  assert.strictEqual(CUB.freeHold(null), false);
  assert.strictEqual(CUB.freeHold({ reported: false }), false);
});

test("CUB.planFromCaps: wording only, and unknown stays unknown", function (t){
  var CUB = load(["usage.js"]).CUB;
  assert.strictEqual(CUB.planFromCaps(["chat", "claude_max"]), "max");
  assert.strictEqual(CUB.planFromCaps(["chat", "claude_pro"]), "pro");
  assert.strictEqual(CUB.planFromCaps(["chat"]), "free");
  assert.strictEqual(CUB.planFromCaps(["something_new"]), "unknown");
  assert.strictEqual(CUB.planFromCaps(null), "unknown");
});
