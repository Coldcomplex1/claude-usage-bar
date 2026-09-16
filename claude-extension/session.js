// session.js: the free-plan readout.
//
// Claude does not publish usage percentages for free accounts -- the usage
// endpoint answers with nothing in it -- so there is no number to fetch. What a
// free account never gets from claude.ai, and what actually matters mid-chat, is
// how much of the current window has gone, and when that window rolls over.
//
// So we count. A message is counted by watching the transcript for a new user
// bubble; only the count, the timestamp and a cost estimate are ever stored --
// never a word of what was said, and nothing leaves the browser.
//
// The window is ANCHORED, not sliding. Claude states one reset time and clears
// everything at it; it does not slide along behind you. See normalize().
// estimate.js turns what we count here into a percentage, but only once Claude
// itself has said something that gives it an honest denominator.
//
// Loaded by the content script (which does the counting) and imported by the
// service worker (which only reads). Everything below the read/write helpers is
// DOM-only and is never called from the worker.

var CUBS = (function () {
  var KEY = "cub_free_session";
  var WINDOW_MS = 5 * 60 * 60 * 1000;   // Claude's free window is five hours
  var MAX_STAMPS = 600;                 // a hard cap, so storage can't grow without bound
  var SKEW_MS = 60000;                  // tolerance for a clock that is slightly ahead
  var GAP_MS = 10 * 60 * 1000;          // a break longer than this and we may have missed sends
  var HEARTBEAT_MS = 5 * 60 * 1000;     // how often the gap check is allowed to write

  // An entry is { t, u }: when the send happened, and what it cost in units
  // (estimate.js computes u; it is 0 until then). Entries written before units
  // existed are bare numbers, and are still accepted -- which is the whole
  // migration: the old shape ages out of the window within five hours by itself.
  function entry(e){
    if (typeof e === "number") return isFinite(e) ? { t: e, u: 0 } : null;
    if (!e || typeof e !== "object") return null;
    if (typeof e.t !== "number" || !isFinite(e.t)) return null;
    var u = (typeof e.u === "number" && isFinite(e.u) && e.u > 0) ? e.u : 0;
    return { t: e.t, u: u };
  }

  // Resolve the window in progress and drop everything outside it.
  //
  // The old code slid the window along its oldest surviving stamp, which is not
  // what Claude does and quietly misreported the boundary: messages at 00:00 and
  // 04:00, read at 05:00, came back as "1 message, resets at 09:00" when in fact
  // the window had reset to empty. An anchored window says 0.
  //
  // `windowStart` is that anchor. A stored one wins, because it can have come
  // from Claude's own stated reset time -- the only way to know about a window
  // that opened before we were watching. Otherwise the oldest entry opens it.
  function normalize(store, now){
    var raw = (store && Array.isArray(store.stamps)) ? store.stamps : [];
    var all = [];
    for (var i = 0; i < raw.length; i++){
      var e = entry(raw[i]);
      if (e && e.t <= now + SKEW_MS) all.push(e);
    }
    all.sort(function (a, b){ return a.t - b.t; });

    var start = (store && typeof store.windowStart === "number" && isFinite(store.windowStart))
              ? store.windowStart
              : (all.length ? all[0].t : null);

    // However many windows have elapsed while we were away, each closed at its
    // own reset and took its messages with it. Walk forward until the anchor is
    // a window that is still open, or until nothing is left. Bounded because
    // each pass strictly shrinks `all`.
    var guard = 0;
    while (start != null && now - start >= WINDOW_MS && guard++ < 64){
      var closedAt = start + WINDOW_MS;
      var next = [];
      for (var j = 0; j < all.length; j++) if (all[j].t >= closedAt) next.push(all[j]);
      all = next;
      start = all.length ? all[0].t : null;
    }

    // A stated reset time can anchor the window earlier than our first sighting
    // (good: that is the point) or later (the window rolled over while we were
    // not looking). Either way, only what falls inside it counts.
    var kept = [];
    if (start != null) for (var k = 0; k < all.length; k++) if (all[k].t >= start) kept.push(all[k]);

    return { stamps: kept.slice(-MAX_STAMPS), windowStart: start };
  }

  // Exported for tests; `record` and `summarize` go through normalize directly.
  function prune(stamps, now){ return normalize({ stamps: stamps }, now || Date.now()).stamps; }

  // { count, units, startedAt, resetAt } for the window in progress. count 0
  // means nothing has been sent since it rolled over (or since the extension was
  // installed -- see the note in the tooltip).
  function summarize(store, now){
    now = now || Date.now();
    var n = normalize(store, now);
    var units = 0;
    for (var i = 0; i < n.stamps.length; i++) units += n.stamps[i].u;
    return {
      count: n.stamps.length,
      units: units,
      startedAt: n.windowStart,
      resetAt: n.windowStart != null ? new Date(n.windowStart + WINDOW_MS).toISOString() : null,
      // True when the anchor came from Claude rather than from the first message
      // we happened to see, which is what tells the readout it can trust the
      // countdown. Set by setWindowStart().
      anchored: !!(store && store.anchored) && n.windowStart != null,
      // True when nothing was watching for part of this window, so sends may
      // have happened that we never saw and the count is a floor rather than a
      // total. Only meaningful while the window it was recorded against is still
      // the live one -- a rollover leaves it behind. See heartbeat().
      gap: !!(store && store.gap) && n.windowStart != null && store.windowStart === n.windowStart
    };
  }

  // Note that we are still watching, and notice if we were not. Called from the
  // content script's existing 30-second heartbeat, but writing at most every
  // HEARTBEAT_MS: a disk write every half minute for a liveness flag is exactly
  // the cost this extension went out of its way to avoid elsewhere.
  //
  // The browser being shut, or every claude.ai tab being closed, leaves a hole
  // in the window that messages can have gone into. estimate.js has to know,
  // because a count with a hole in it cannot be a denominator.
  function heartbeat(){
    chrome.storage.local.get([KEY], function (o){
      var now = Date.now();
      var cur = o[KEY] || {};
      var last = typeof cur.lastSeenAt === "number" && isFinite(cur.lastSeenAt) ? cur.lastSeenAt : null;
      if (last != null && now - last < HEARTBEAT_MS) return;
      var gap = !!cur.gap;
      if (last != null && now - last > GAP_MS &&
          typeof cur.windowStart === "number" && cur.windowStart < last) gap = true;
      var next = Object.assign({}, cur, { lastSeenAt: now, gap: gap });
      chrome.storage.local.set({ [KEY]: next });
    });
  }

  function read(cb){
    chrome.storage.local.get([KEY], function (o){ cb(summarize(o[KEY])); });
  }

  // Append n sends costing `units` between them, and hand back the new summary.
  // Read-modify-write, so two tabs counting at the same moment is the one race
  // here; the window is five hours long and the cost of losing one increment to
  // it is a count that is low by one, which is why this is not worth a lock.
  function record(n, units, cb){
    if (typeof units === "function"){ cb = units; units = 0; }
    chrome.storage.local.get([KEY], function (o){
      var now = Date.now();
      var cur = normalize(o[KEY], now);
      var stamps = cur.stamps.slice();
      // The first send after a reset is what opens the next window.
      var fresh = cur.windowStart == null;   // this send opens the next window
      var start = fresh ? now : cur.windowStart;
      var anchored = fresh ? false : !!(o[KEY] && o[KEY].anchored);
      // A new window starts whole: whatever we missed belongs to the old one.
      var gap = fresh ? false : !!(o[KEY] && o[KEY].gap);
      var per = n > 0 ? (units || 0) / n : 0;
      for (var i = 0; i < n; i++) stamps.push({ t: now, u: per });
      var next = { stamps: stamps.slice(-MAX_STAMPS), windowStart: start,
                   anchored: anchored, gap: gap,
                   lastSeenAt: now, updatedAt: now };
      chrome.storage.local.set({ [KEY]: next }, function (){ if (cb) cb(summarize(next, now)); });
    });
  }

  // Claude stated when this window resets. That is ground truth and it wins over
  // our own anchor in both directions: earlier means the window opened before we
  // were watching (the case the README used to apologise for), later means it
  // rolled over while nothing was on screen to see it.
  function setWindowStart(startAt, cb){
    if (typeof startAt !== "number" || !isFinite(startAt)){ if (cb) cb(null); return; }
    chrome.storage.local.get([KEY], function (o){
      var now = Date.now();
      var cur = o[KEY] || {};
      if (cur.windowStart === startAt && cur.anchored){ if (cb) cb(summarize(cur, now)); return; }
      // Learning when the window really opened does not tell us we watched all of
      // it. If anything, an anchor earlier than our first sighting is proof we
      // did not -- but that is installedAt's job to notice, so `gap` is simply
      // carried across rather than cleared.
      var next = Object.assign({}, cur, { stamps: cur.stamps || [], windowStart: startAt,
                                          anchored: true, updatedAt: now });
      chrome.storage.local.set({ [KEY]: next }, function (){ if (cb) cb(summarize(next, now)); });
    });
  }

  function reset(cb){ chrome.storage.local.remove([KEY], function (){ if (cb) cb(); }); }

  // ===================================================================
  // Counting (content script only)
  // ===================================================================

  // claude.ai tags the user's own turns; the class is the older spelling, kept
  // as a fallback. Tried in order, first one that matches anything wins, so the
  // two can never both match and double-count the same turn.
  var SELECTORS = ['[data-testid="user-message"]', '.font-user-message'];
  var selector = "";

  function bubbles(){
    if (selector){
      var found = document.querySelectorAll(selector);
      if (found.length) return found;
    }
    for (var i = 0; i < SELECTORS.length; i++){
      var n = document.querySelectorAll(SELECTORS[i]);
      if (n.length){ selector = SELECTORS[i]; return n; }
    }
    return [];
  }

  // The rule, kept separate from the DOM so it can be reasoned about (and
  // tested) on its own:
  //   prev/key   which conversation the last look was at, and this one
  //   seen       how many user bubbles that last look counted
  //   n          how many there are now
  //   tail       whether this batch added the bubble that is now the last one
  // Returns the new baseline and how many sends to record.
  //
  // "Exactly one" is deliberately strict, and it is the reason a burst is never
  // miscounted: a conversation opening with two turns already in it looks
  // exactly like two sends, and the only thing that tells them apart is that a
  // person cannot send twice inside one 250ms batch. The cost is that if they
  // somehow do, it counts once. Undercounting by one beats counting a whole
  // conversation's history as fresh sends.
  function decide(prev, key, seen, n, tail){
    if (key !== prev) return { seen: n, count: 0 };   // switched: re-baseline, count nothing
    if (n <= seen) return { seen: n, count: 0 };      // shrank: a re-render, not a send
    if (n - seen !== 1) return { seen: n, count: 0 }; // several at once: history arriving
    if (!tail) return { seen: n, count: 0 };          // appeared above the end: history too
    return { seen: n, count: 1 };
  }

  var watching = false;
  var observer = null;
  var seen = -1;          // bubbles counted for the conversation we are on
  var convo = "";         // which conversation that was
  var flushTimer = null;
  var addedEls = [];      // elements added since the last flush (capped)
  var onCounted = null;
  var costFor = null;     // set by estimate.js; returns the units a send costs

  function convoKey(){ return location.pathname; }

  // A batch that adds several user bubbles at once is history arriving (a page
  // load, a conversation switch, scrolling back). A live send adds exactly one,
  // and adds it at the end. Anything else is React re-rendering what is already
  // there, and must not count.
  function flush(){
    flushTimer = null;
    var added = addedEls; addedEls = [];
    var key = convoKey();
    var list = bubbles();
    var n = list.length;
    var last = n ? list[n - 1] : null;
    var tail = !!last && added.some(function (el){ return el === last || (el.contains && el.contains(last)); });

    var out = decide(convo, key, seen, n, tail);
    convo = key; seen = out.seen;
    if (out.count){
      // What this send costs. estimate.js measures it; with no cost model in
      // play the units are 0 and the readout stays a count, exactly as before.
      var units = 0;
      if (costFor){ try { units = costFor(list) || 0; } catch (e) { units = 0; } }
      record(out.count, units, function (summary){ if (onCounted) onCounted(summary); });
    }
  }

  // Short enough that two real sends can never land in the same batch (they are
  // seconds apart), long enough to coalesce the mutation storm a streaming reply
  // produces into a single pass.
  function schedule(){
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 250);
  }

  // Start counting. Safe to call repeatedly. `cb` fires with the new summary
  // each time a send is counted. `opts.cost` prices a send; `opts.onNodes` is
  // handed every element the observer saw, which is how estimate.js reads
  // Claude's own limit notices without a second observer on a busy page.
  function watch(cb, opts){
    onCounted = cb || null;
    costFor = (opts && typeof opts.cost === "function") ? opts.cost : null;
    var onNodes = (opts && typeof opts.onNodes === "function") ? opts.onNodes : null;
    if (watching) return;
    watching = true;
    convo = convoKey();
    seen = bubbles().length;               // whatever is already on screen is history
    observer = new MutationObserver(function (records){
      var sel = selector || SELECTORS[0];
      for (var i = 0; i < records.length; i++){
        var nodes = records[i].addedNodes;
        for (var j = 0; j < nodes.length; j++){
          var el = nodes[j];
          if (!el || el.nodeType !== 1) continue;
          if (onNodes){ try { onNodes(el); } catch (e) {} }
          var isUser = (el.matches && el.matches(sel)) || (el.querySelector && el.querySelector(sel));
          if (!isUser) continue;
          if (addedEls.length < 50) addedEls.push(el);
          schedule();
        }
      }
      // A conversation switch can remove every bubble without adding one, and
      // the baseline has to follow or the next send reads as a bulk arrival.
      if (!flushTimer && convoKey() !== convo) schedule();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function unwatch(){
    if (observer) observer.disconnect();
    observer = null; watching = false; onCounted = null; costFor = null;
    if (flushTimer){ clearTimeout(flushTimer); flushTimer = null; }
    addedEls = [];
  }

  return { KEY: KEY, WINDOW_MS: WINDOW_MS, GAP_MS: GAP_MS,
           prune: prune, normalize: normalize, summarize: summarize,
           read: read, record: record, setWindowStart: setWindowStart, reset: reset,
           heartbeat: heartbeat,
           bubbles: bubbles, decide: decide, watch: watch, unwatch: unwatch };
})();
