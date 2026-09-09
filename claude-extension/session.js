// session.js: the free-plan readout.
//
// Claude does not publish usage percentages for free accounts -- the usage
// endpoint answers with nothing in it -- so there is no number to fetch and no
// denominator to fill a bar against (the free cap moves with demand). What a
// free account never gets from claude.ai, and what actually matters mid-chat,
// is the one thing we can work out on our own: how many messages went into the
// current rolling 5-hour window, and when that window rolls over.
//
// So we count. A message is counted by watching the transcript for a new user
// bubble; only the count and the timestamp are ever stored -- never a word of
// what was said, and nothing leaves the browser.
//
// Loaded by the content script (which does the counting) and imported by the
// service worker (which only reads). Everything below the read/write helpers is
// DOM-only and is never called from the worker.

var CUBS = (function () {
  var KEY = "cub_free_session";
  var WINDOW_MS = 5 * 60 * 60 * 1000;   // Claude's free window is a rolling 5 hours
  var MAX_STAMPS = 600;                 // a hard cap, so storage can't grow without bound

  // Stamps older than the window are gone: the window is rolling, so the
  // reading is always "since the oldest message still inside it".
  function prune(stamps, now){
    var cut = now - WINDOW_MS;
    return (Array.isArray(stamps) ? stamps : [])
      .filter(function (t){ return typeof t === "number" && isFinite(t) && t > cut && t <= now + 60000; })
      .sort(function (a, b){ return a - b; })
      .slice(-MAX_STAMPS);
  }

  // { count, startedAt, resetAt } for the window in progress. count 0 means
  // nothing has been sent since it rolled over (or since the extension was
  // installed -- see the note in the tooltip).
  function summarize(store, now){
    now = now || Date.now();
    var stamps = prune(store && store.stamps, now);
    if (!stamps.length) return { count: 0, startedAt: null, resetAt: null };
    return {
      count: stamps.length,
      startedAt: stamps[0],
      resetAt: new Date(stamps[0] + WINDOW_MS).toISOString()
    };
  }

  function read(cb){
    chrome.storage.local.get([KEY], function (o){ cb(summarize(o[KEY])); });
  }

  // Append n sends and hand back the new summary. Read-modify-write, so two
  // tabs counting at the same moment is the one race here; the window is five
  // hours long and the cost of losing one increment to it is a count that is
  // low by one, which is why this is not worth a lock.
  function record(n, cb){
    chrome.storage.local.get([KEY], function (o){
      var now = Date.now();
      var stamps = prune(o[KEY] && o[KEY].stamps, now);
      for (var i = 0; i < n; i++) stamps.push(now);
      var next = { stamps: stamps.slice(-MAX_STAMPS), updatedAt: now };
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
    if (out.count) record(out.count, function (summary){ if (onCounted) onCounted(summary); });
  }

  // Short enough that two real sends can never land in the same batch (they are
  // seconds apart), long enough to coalesce the mutation storm a streaming reply
  // produces into a single pass.
  function schedule(){
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 250);
  }

  // Start counting. Safe to call repeatedly. `cb` fires with the new summary
  // each time a send is counted.
  function watch(cb){
    onCounted = cb || null;
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
    observer = null; watching = false; onCounted = null;
    if (flushTimer){ clearTimeout(flushTimer); flushTimer = null; }
    addedEls = [];
  }

  return { KEY: KEY, WINDOW_MS: WINDOW_MS,
           prune: prune, summarize: summarize, read: read, record: record, reset: reset,
           decide: decide, watch: watch, unwatch: unwatch };
})();
