// estimate.js: turning what we can count on a free account into something worth
// showing.
//
// Claude publishes no usage percentage for free accounts, so session.js counts
// messages instead. A count is honest but weak -- it has no denominator, and
// Claude's limit is not really counted in messages anyway.
//
// The denominator is not invented here. It is harvested. claude.ai tells free
// users about their own limit in its own interface -- how many messages are
// left, that they have run out, and the clock time it comes back -- and that is
// a real number from Claude, not a guess of ours. This file reads those notices,
// stores what they imply, and hands the rest of the extension a reading that
// always says how much it actually knows:
//
//   counted    nothing has calibrated us; show the count, as before
//   observed   Claude stated a figure for THIS window; show a real percentage
//   estimated  Claude stated a figure in an earlier window; measure this one
//              against the median of those, hatched and prefixed "~"
//
// What is being measured is not really messages. Claude's limit is spent in
// tokens, and the whole transcript is re-sent every turn, so message 20 of a
// long conversation costs many times message 1 of a fresh one. costOf() weighs
// each send by how much conversation it carried, which is what makes "I only
// sent 8 messages and got cut off" add up.
//
// Three rules hold everywhere below. A notice inside the conversation is the
// user's words or Claude's reply, never a limit notice, and is thrown away
// before it can be read as one. A cap we cannot stand behind is not a
// denominator, and no bar is drawn against one. And anything unparseable
// degrades to `counted`, never to a wrong number.
//
// Loaded by the content script (which scrapes) and imported by the service
// worker (which only reads). Everything under "Reading the page" is DOM-only.

var CUBE = (function () {
  var CALIB_KEY = "cub_free_calib";
  var INSTALL_KEY = "cub_installed_at";
  var WINDOW_MS = 5 * 60 * 60 * 1000;
  var MAX_CAPS = 12;          // how many past windows we keep a cap from
  var CAP_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // past this a learned cap is history, not evidence
  var MAX_TEXT = 400;         // a limit notice is a sentence, not a transcript

  // ===================================================================
  // Parsing (pure -- no DOM, no storage, so it can be tested directly)
  // ===================================================================

  // "4 PM", "4:30pm", "16:00" -> the next moment the clock reads that. Claude
  // states a reset as a bare wall-clock time with no date, so "4 PM" seen at
  // 1:20 PM is today and seen at 5 PM would be tomorrow.
  //
  // A bare number is deliberately not a time: "until 5" in "5 more messages"
  // must not parse as 5 o'clock, so either am/pm or HH:MM is required.
  function clockToIso(clock, now){
    if (typeof clock !== "string") return null;
    var h, min;
    var m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\s*$/i.exec(clock);
    if (m){
      h = parseInt(m[1], 10); min = m[2] ? parseInt(m[2], 10) : 0;
      if (!(h >= 1 && h <= 12) || min > 59) return null;
      if (h === 12) h = 0;
      if (m[3].toLowerCase() === "p") h += 12;
    } else {
      var m2 = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(clock);
      if (!m2) return null;
      h = parseInt(m2[1], 10); min = parseInt(m2[2], 10);
      if (h > 23 || min > 59) return null;
    }
    var d = new Date(now);
    d.setHours(h, min, 0, 0);
    var t = d.getTime();
    if (t <= now - 60000) t += 24 * 60 * 60 * 1000;   // already gone today
    return new Date(t).toISOString();
  }

  // Deliberately narrow. These have to survive claude.ai rewording without ever
  // matching ordinary prose, so they ask for the shape of a limit notice rather
  // than for one exact sentence. When the copy moves far enough that none of
  // them match, the readout falls back to a count -- never to a wrong number.
  var MAX_N = 200;   // a free window is tens of messages; past this we misread something

  // "3 of 5 messages" states the total outright, which is worth its own pattern:
  // a stated cap is trustworthy even when we did not watch the window from its
  // start, and a derived one is not. See estimate().
  // The (?<!\d)...(?!\d) around each number is load-bearing, not tidiness: with a
  // plain \d{1,3}, "1000 messages remaining" matches its last three digits and
  // reads as 000 -- a made-up zero, presented as Claude's own figure. The bound
  // has to reject the whole number, not clip it.
  var RE_USED_OF   = /(?<!\d)(\d{1,3})(?!\d)\s*(?:\/|of)\s*(?<!\d)(\d{1,3})(?!\d)\s+(?:messages?|prompts?)\b/i;
  var RE_REMAINING = /(?<!\d)(\d{1,3})(?!\d)\s+(?:messages?|prompts?|replies)\s+(?:remaining|left)/i;
  var RE_EXHAUST   = /(?:out of (?:your )?(?:free )?(?:messages|prompts)|(?:message|usage|daily) limit reached|reached your (?:message|usage) limit|no (?:messages|prompts) (?:remaining|left))/i;
  var RE_RESET     = /(?:until|resets?(?:\s+at)?|back (?:at|on)|try again (?:at|after)|available (?:again )?at)\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s?m\.?)?)/i;

  function inRange(n){ return isFinite(n) && n >= 0 && n <= MAX_N; }

  // What a string says about the limit, or null. `kind` is what we learned:
  //   usedOf      Claude stated both the used count and the total
  //   remaining   Claude named how many are left
  //   exhausted   Claude says there are none left
  //   reset       only the reset time was stated
  function parseLimitText(str, now){
    if (typeof str !== "string" || !str || str.length > MAX_TEXT) return null;
    now = now || Date.now();

    var out = null;
    var mU = RE_USED_OF.exec(str);
    if (mU){
      var used = parseInt(mU[1], 10), cap = parseInt(mU[2], 10);
      if (inRange(used) && inRange(cap) && cap > 0 && used <= cap){
        out = { kind: "usedOf", n: cap - used, used: used, cap: cap, resetAt: null };
      }
    }
    if (!out){
      var mR = RE_REMAINING.exec(str);
      if (mR){
        var n = parseInt(mR[1], 10);
        if (inRange(n)) out = { kind: "remaining", n: n, resetAt: null };
      }
    }
    if (!out && RE_EXHAUST.test(str)) out = { kind: "exhausted", n: 0, resetAt: null };

    var mT = RE_RESET.exec(str);
    if (mT){
      var iso = clockToIso(mT[1], now);
      if (iso){
        var t = new Date(iso).getTime();
        // A five-hour window cannot reset more than five hours out. Anything
        // further is some other time printed on the page, not our reset.
        if (t > now && t - now <= WINDOW_MS + 60000){
          if (out) out.resetAt = iso;
          else out = { kind: "reset", n: null, resetAt: iso };
        }
      }
    }
    return out;
  }

  // ===================================================================
  // What an observation implies (pure)
  // ===================================================================

  // A cap for the window an observation was made in, given what we had counted
  // at that moment.
  //
  //   exhausted   the count when Claude cut us off IS the cap -- the strongest
  //               signal there is, and the only exact one
  //   remaining   cap = what we had sent + what Claude says is left
  //
  // `whole` records whether we watched the window from its start. If we did not,
  // our count is short by whatever happened before we were installed and the cap
  // is biased low, so it is kept as a lower bound and never used as a
  // denominator. See capOf() in the estimator.
  function capFrom(obs, summary, installedAt){
    if (!obs || !summary) return null;
    if (obs.kind !== "exhausted" && obs.kind !== "remaining" && obs.kind !== "usedOf") return null;
    var count = summary.count || 0;
    var cap = obs.kind === "usedOf" ? obs.cap
            : obs.kind === "exhausted" ? count
            : count + obs.n;
    if (!isFinite(cap) || cap <= 0 || cap > MAX_N) return null;
    var startedAt = summary.startedAt;
    // Did we watch this window from the start? Installing midway is one way to
    // miss its opening; so is the browser being shut for an hour, which
    // session.js records as a gap. Either way our count is a floor.
    var whole = !!startedAt && typeof installedAt === "number" && startedAt >= installedAt &&
                !summary.gap;
    // The same cap expressed in cost units, which is what the limit is really
    // spent in. A hard stop measures it exactly -- the units in the window at the
    // moment Claude cut us off ARE the cap. Anything else has to assume the
    // messages we have not sent yet cost like the ones we have, which is a much
    // weaker claim and is why usableCaps() prefers hard stops when it has them.
    var units = summary.units || 0;
    var unitsCap = obs.kind === "exhausted" ? units
                 : (count > 0 && units > 0) ? Math.round(units * cap / count)
                 : 0;
    return { at: Date.now(), cap: cap, count: count, units: units,
             unitsCap: unitsCap || 0,
             used: obs.kind === "usedOf" ? obs.used : null,
             // A cap Claude stated outright holds whether or not we saw the whole
             // window. One we derived from our own count does not.
             stated: obs.kind === "usedOf",
             kind: obs.kind, whole: whole, startedAt: startedAt || null };
  }

  // ===================================================================
  // What a send costs (pure)
  // ===================================================================
  //
  // Claude's free limit is spent in tokens, not messages. The whole transcript
  // is re-sent every turn, so message 20 of a long conversation costs many times
  // message 1 of a fresh one -- which is why "I only sent 8 messages and got cut
  // off" is a real experience that a message counter can never explain.
  //
  // We cannot see tokens. We can see how much text is on the page, and characters
  // over CHARS_PER_TOKEN is close enough to make a long chat count like a long
  // chat. That relative truth is the point; the absolute number means nothing
  // until an observed cap gives it a scale.
  //
  // Every constant here is a shape, not a measurement. They are named PRIOR_ for
  // that reason, and they are why the readout they feed is always marked as an
  // estimate.
  var PRIOR_CHARS_PER_TOKEN = 3.9;   // English prose; code is denser, so this over-counts code
  var PRIOR_OUTPUT_WEIGHT = 5;       // output costs materially more than input
  var PRIOR_TURN_TOKENS = 2000;      // system prompt and tooling, which we cannot see
  var PRIOR_IMAGE_TOKENS = 1500;     // a typical image; we see the element, never its size

  function tok(chars){ return Math.max(0, chars || 0) / PRIOR_CHARS_PER_TOKEN; }

  // m: { ctxChars, replyChars, images }
  //   ctxChars    the whole transcript as it stood when this send was made --
  //               this is the term that makes turn 20 expensive
  //   replyChars  the reply to the PREVIOUS send, which has settled by now
  //   images      images in the conversation we had not already accounted for
  function costOf(m){
    m = m || {};
    var input = tok(m.ctxChars) + PRIOR_TURN_TOKENS + PRIOR_IMAGE_TOKENS * (m.images || 0);
    var output = PRIOR_OUTPUT_WEIGHT * tok(m.replyChars);
    var u = Math.round(input + output);
    return isFinite(u) && u > 0 ? u : 0;
  }

  // What a short message in a fresh chat costs, so burn rate has something to be
  // a multiple OF.
  function baseCost(){ return costOf({ ctxChars: 200, replyChars: 900, images: 0 }); }

  function median(xs){
    var v = xs.filter(function (x){ return typeof x === "number" && isFinite(x) && x > 0; })
              .sort(function (a, b){ return a - b; });
    if (!v.length) return null;
    var mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  // The observation that applies to the window in progress, if any. An
  // observation from a previous window says nothing about this one: the free cap
  // moves with demand, so yesterday's reading is history, not fact.
  function currentObs(calib, summary){
    if (!calib || !Array.isArray(calib.caps) || !summary || summary.startedAt == null) return null;
    var best = null;
    for (var i = 0; i < calib.caps.length; i++){
      var c = calib.caps[i];
      if (!c || typeof c.at !== "number") continue;
      if (c.at < summary.startedAt) continue;                    // an earlier window
      if (c.at > summary.startedAt + WINDOW_MS + 60000) continue; // a later one
      if (!best || c.at > best.at) best = c;
    }
    return best;
  }

  // ===================================================================
  // The estimator (pure)
  // ===================================================================

  // The free readout, and how much it knows:
  //   { confidence, pct, count, units, cap, resetAt, anchored, left }
  //
  // `pct` is null whenever there is no denominator we trust, and that null is
  // what tells every surface to draw something other than a bar. `left` is
  // Claude's own figure when it gave one, and is shown on its own when there is
  // no honest percentage to put it in -- which is no loss, because "5 left" is
  // what a person actually acts on mid-chat.
  function estimate(summary, calib){
    var s = summary || { count: 0, units: 0, startedAt: null, resetAt: null };
    // `exact` is what earns a reading the right to drop the "~". Only a hard
    // stop gets it: Claude said outright there is nothing left, so 100 is a fact
    // rather than a ratio we worked out. Everything else leans on our own count
    // somewhere, and our own count is deliberately biased to undercount
    // (session.js decide()), so it stays approximate and says so.
    var out = { confidence: "counted", pct: null, count: s.count || 0, units: s.units || 0,
                cap: null, resetAt: s.resetAt || null, anchored: !!s.anchored,
                left: null, exact: false,
                // "units" or "count" on an estimate, saying what it was measured
                // against; null when nothing was measured.
                basis: null,
                // This window has already run past every cap we have learned, so
                // the cap moved and there is nothing honest to draw. Worth saying
                // in words even though there is no bar.
                pastLearned: false };

    var obs = currentObs(calib, s);
    if (!obs) return learned(out, s, calib);

    if (obs.kind === "exhausted"){
      // Claude stopped us. Whatever our own count says, this window is spent --
      // so this one reading is right even if we never saw the window open. The
      // 100 here is not a ratio against a denominator we inferred; it is Claude
      // saying there is nothing left, which is why it needs no cap to be honest.
      out.confidence = "observed"; out.pct = 100; out.left = 0; out.exact = true;
      out.cap = obs.cap > 0 ? obs.cap : null;
      return out;
    }

    // Claude named a figure at a moment when we had counted obs.count. Anything
    // we have counted since comes off it.
    if (!(obs.cap > 0)) return out;
    var thenLeft = obs.cap - obs.count;              // what Claude said was left
    var since = Math.max(0, out.count - obs.count);  // what we have sent since
    var left = Math.max(0, thenLeft - since);

    // Sent more than Claude said we had, and never stopped: the figure has been
    // overtaken by events. The cap moves with demand, so this is not a
    // contradiction, it just means we no longer know the total -- and saying
    // "0 left" to someone still happily chatting is worse than saying nothing.
    // Fall back to the count until Claude says something else.
    if (since > thenLeft) return learned(out, s, calib);
    out.left = left;

    // Whether that figure can also be drawn as a bar is a different question.
    //
    // "5 left" says what remains and nothing about the total. To make it a
    // percentage we need cap = what we had sent + what is left, and that only
    // holds if our count was complete. Install midway through a window, or have
    // the browser shut for an hour of it, and our count is a floor: the derived
    // cap comes out too small and the percentage too BIG -- telling someone they
    // are nearly out when they are not. That is the wrong direction to be wrong
    // in, so we do not draw it at all. The row shows "5 left" instead, which is
    // the more useful half of the reading anyway.
    //
    // A cap Claude stated outright ("3 of 5") is not derived from our count and
    // so does not depend on any of this.
    if (!obs.whole && !obs.stated){
      out.confidence = "observed";
      return out;
    }
    out.confidence = "observed";
    out.cap = obs.cap;
    out.pct = clamp(100 * (obs.cap - left) / obs.cap);
    return out;
  }

  // Claude has said nothing in this window, but it has said things in previous
  // ones. That is not fact about today -- the free cap moves with demand -- so it
  // is a weaker reading than an observation and is labelled `estimated`: hatched,
  // prefixed "~", and drawn against the median of what we have actually seen
  // rather than against any number shipped in this file.
  //
  // Preferred basis is units, because that is what the limit is really spent in:
  // a window of twenty long messages is not the same as twenty short ones, and
  // only the unit figure knows the difference. Counts are the fallback for caps
  // learned before there was a cost model.
  function learned(out, s, calib){
    var rows = usableCaps(calib);
    if (!rows.length) return out;

    var capU = median(rows.map(function (r){ return r.unitsCap; }));
    var capN = median(rows.map(function (r){ return r.cap; }));

    // An un-hit cap is a lower bound, not a cap. If this window has already gone
    // past what previous ones allowed and Claude has not stopped us, the limit
    // moved -- it does, with demand -- and the number we learned is simply too
    // small. Drawing it would pin the bar at 100% for someone still happily
    // chatting, which is the same cry-wolf failure as deriving a cap from an
    // incomplete count. So we say what we know instead: the count, and that this
    // window has run longer than the ones we have seen.
    var over = (capU && s.units > 0) ? s.units > capU
             : (capN ? (s.count || 0) > capN : false);
    if (over){ out.pastLearned = true; return out; }

    if (capU && s.units > 0){
      out.confidence = "estimated";
      out.cap = Math.round(capN || 0) || null;
      out.pct = clamp(100 * s.units / capU);
      out.basis = "units";
      return out;
    }
    if (capN){
      out.confidence = "estimated";
      out.cap = Math.round(capN);
      out.pct = clamp(100 * (s.count || 0) / capN);
      out.basis = "count";
      return out;
    }
    return out;
  }

  // Only caps we can stand behind: from a window we watched all of (or that
  // Claude stated outright), and recent enough that the free tier has probably
  // not moved under them. A cap from last month is not evidence about today.
  function usableCaps(calib){
    if (!calib || !Array.isArray(calib.caps)) return [];
    var cut = Date.now() - CAP_TTL_MS;
    var out = [];
    for (var i = 0; i < calib.caps.length; i++){
      var c = calib.caps[i];
      if (!c || typeof c.at !== "number" || c.at < cut) continue;
      if (!c.whole && !c.stated) continue;
      if (!(c.cap > 0)) continue;
      out.push(c);
    }
    // A hard stop measures the cap exactly; everything else extrapolates from it.
    // If we have any of the former, the latter is not worth averaging in.
    var hard = out.filter(function (c){ return c.kind === "exhausted"; });
    return hard.length ? hard : out;
  }

  function clamp(p){
    if (typeof p !== "number" || !isFinite(p)) return null;
    return Math.max(0, Math.min(100, p));
  }

  // ===================================================================
  // Storage
  // ===================================================================

  function readCalib(cb){
    chrome.storage.local.get([CALIB_KEY], function (o){ cb(o[CALIB_KEY] || null); });
  }

  // Record what an observation implies, unless we already have it. The same
  // banner is seen on many mutations, so the dedupe is what keeps this from
  // writing to storage on every keystroke-sized DOM change.
  function recordCap(row, cb){
    chrome.storage.local.get([CALIB_KEY], function (o){
      var cur = o[CALIB_KEY] || {};
      var caps = Array.isArray(cur.caps) ? cur.caps.slice() : [];
      var dup = caps.some(function (c){
        return c && c.kind === row.kind && c.cap === row.cap && c.count === row.count &&
               typeof c.at === "number" && Math.abs(c.at - row.at) < WINDOW_MS;
      });
      if (dup){ if (cb) cb(cur); return; }
      caps.push(row);
      caps = caps.slice(-MAX_CAPS);
      var next = { caps: caps, updatedAt: Date.now() };
      chrome.storage.local.set({ [CALIB_KEY]: next }, function (){ if (cb) cb(next); });
    });
  }

  function clearCalib(cb){ chrome.storage.local.remove([CALIB_KEY], function (){ if (cb) cb(); }); }

  function installedAt(cb){
    chrome.storage.local.get([INSTALL_KEY], function (o){
      var t = o[INSTALL_KEY];
      cb(typeof t === "number" && isFinite(t) ? t : null);
    });
  }

  // ===================================================================
  // Reading the page (content script only)
  // ===================================================================

  // A person can type "5 messages left" into the chat, and Claude can write it
  // back in a reply. Everything inside the conversation, and everything inside
  // the composer, is their words rather than claude.ai's own chrome, and is
  // dropped before the patterns ever run. This is the one guard that keeps a
  // sentence about limits from being read as a limit.
  var rootCache = null, rootCacheAt = 0;

  // The transcript, found from the message bubbles rather than named outright:
  // claude.ai renames its classes, but a bubble's ancestry still says where the
  // conversation lives. With two or more turns the lowest common ancestor is
  // exactly the transcript; with one there is nothing to intersect, so we walk
  // up a few levels and accept a slightly wider exclusion.
  function transcriptRoot(){
    var now = Date.now();
    if (rootCache !== null && now - rootCacheAt < 1000) return rootCache;
    rootCacheAt = now;
    var list = CUBS.bubbles();
    if (!list || !list.length) return (rootCache = null);
    var a = list[0];
    if (list.length > 1){
      for (var i = 1; i < list.length; i++){
        while (a && !(a.contains && a.contains(list[i]))) a = a.parentElement;
        if (!a) return (rootCache = null);
      }
    } else {
      for (var j = 0; j < 3 && a.parentElement; j++) a = a.parentElement;
    }
    // Never let the exclusion grow to the whole page, or nothing could ever be
    // read: a root that holds the composer too is no longer the transcript.
    if (a === document.body || a === document.documentElement) return (rootCache = null);
    return (rootCache = a);
  }

  function insideConversation(el){
    if (!el || !el.closest) return true;   // cannot tell: assume it is, and skip
    if (el.closest('[data-testid="user-message"], .font-user-message')) return true;
    if (el.closest('[contenteditable="true"], textarea, input, form')) return true;
    var root = transcriptRoot();
    return !!(root && root.contains && root.contains(el));
  }

  var onObs = null;
  var lastSeen = "";      // the last notice acted on, so one banner is read once
  var capturing = false;  // cub_debug_on: log limit-ish text we did not match

  // ---- Measuring the conversation ------------------------------------------
  //
  // PRIVACY, stated where the code is rather than only in the policy: the two
  // functions below take the LENGTH of what is on the page and nothing else. The
  // string is measured and dropped inside a single expression, no part of it is
  // kept, compared, hashed or sent, and the only thing that reaches storage is an
  // integer count of characters. Nothing here can reconstruct a word of what was
  // said -- but it is still reading the page, which is why the README and the
  // privacy policy say so in as many words.
  var costKey = "";       // the conversation these totals belong to
  var costTotal = 0;      // its length when we last looked

  function totalChars(){
    var root = transcriptRoot();
    // .length on the spot: the string is never bound to a name that outlives it.
    return root && root.textContent ? root.textContent.length : 0;
  }

  function imagesIn(){
    var root = transcriptRoot();
    if (!root || !root.querySelectorAll) return 0;
    return root.querySelectorAll("img").length;
  }

  // Called by session.js the moment a send is counted, so it sees the transcript
  // with the new message in it but before any reply has streamed.
  //
  // One measurement yields both halves of the cost. The transcript as it now
  // stands is what this send re-sends, and everything it grew by since the last
  // send -- minus this message itself -- is the reply to the previous one. So a
  // single read per send covers input and output both, with no timer and no
  // second observer.
  function costOfSend(bubbles){
    var key = (typeof location !== "undefined") ? location.pathname : "";
    var total = totalChars();
    var fresh = costKey !== key;
    var grew = fresh ? 0 : Math.max(0, total - costTotal);
    var last = bubbles && bubbles.length ? bubbles[bubbles.length - 1] : null;
    var sendChars = (last && last.textContent) ? last.textContent.length : 0;
    // Switching conversations grows the transcript by a whole history that was
    // never sent by us, so nothing is attributed on the first look at one.
    var replyChars = fresh ? 0 : Math.max(0, grew - sendChars);
    costKey = key; costTotal = total;
    return costOf({ ctxChars: total, replyChars: replyChars, images: imagesIn() });
  }

  // The last reply of a window has no send after it to be measured by, and it is
  // often the longest. The existing 30-second heartbeat catches up: whatever the
  // transcript grew by since we last looked is that reply, and it is added to the
  // send that asked for it.
  function costIdle(){
    var key = (typeof location !== "undefined") ? location.pathname : "";
    if (costKey !== key) return 0;
    var total = totalChars();
    var grew = total - costTotal;
    if (grew <= 0) return 0;
    costTotal = total;
    var u = Math.round(PRIOR_OUTPUT_WEIGHT * tok(grew));
    if (u > 0) CUBS.addUnits(u);
    return u;
  }

  // Test one element. Cheap by construction: a limit notice is a short sentence,
  // so anything with more text than that is not one and is never measured
  // further. Called from session.js's observer, so there is no second observer
  // on the page.
  function scanNode(el){
    if (!el || el.nodeType !== 1) return null;
    var txt = el.textContent;
    if (!txt || txt.length > MAX_TEXT) return null;
    txt = txt.trim();
    if (!txt || !/\d|limit|out of/i.test(txt)) return null;
    if (insideConversation(el)) return null;

    var now = Date.now();
    var obs = parseLimitText(txt, now);
    if (!obs){
      if (capturing && /limit|messages? (?:left|remaining)|out of/i.test(txt)){
        try { console.debug("[Claude Usage Bar] unmatched limit-ish text:", txt); } catch (e) {}
      }
      return null;
    }
    var sig = obs.kind + "|" + obs.n + "|" + (obs.resetAt || "");
    if (sig === lastSeen) return obs;
    lastSeen = sig;
    apply(obs);
    return obs;
  }

  // Act on a notice: a stated reset time anchors the window (the only way to
  // learn one that opened before we were watching), and a stated figure becomes
  // a cap for it.
  function apply(obs){
    if (obs.resetAt){
      var start = new Date(obs.resetAt).getTime() - WINDOW_MS;
      if (isFinite(start)) CUBS.setWindowStart(start);
    }
    if (obs.kind !== "remaining" && obs.kind !== "exhausted") return;
    installedAt(function (inst){
      CUBS.read(function (summary){
        var row = capFrom(obs, summary, inst);
        if (!row) return;
        recordCap(row, function (calib){ if (onObs) onObs(calib); });
      });
    });
  }

  // A notice can be on the page before we start watching (a reload after
  // hitting the limit), and can be rendered without adding a node we see. One
  // bounded pass over the short text blocks on the page covers both; it is
  // called from the existing 30s heartbeat, not on a timer of its own.
  function sweep(){
    if (typeof document === "undefined") return;
    var nodes = document.querySelectorAll("div, p, span, section, aside");
    var checked = 0;
    for (var i = nodes.length - 1; i >= 0 && checked < 400; i--){
      var el = nodes[i];
      var txt = el.textContent;
      if (!txt || txt.length > MAX_TEXT || txt.length < 8) continue;
      if (!/limit|out of|messages? (?:left|remaining)/i.test(txt)) continue;
      checked++;
      if (scanNode(el)) return;
    }
  }

  function start(opts){
    onObs = (opts && typeof opts.onObs === "function") ? opts.onObs : null;
    chrome.storage.local.get(["cub_debug_on"], function (o){ capturing = !!o.cub_debug_on; });
  }
  function stop(){ onObs = null; lastSeen = ""; rootCache = null; }

  return { CALIB_KEY: CALIB_KEY, INSTALL_KEY: INSTALL_KEY, WINDOW_MS: WINDOW_MS,
           clockToIso: clockToIso, parseLimitText: parseLimitText,
           capFrom: capFrom, median: median, currentObs: currentObs, estimate: estimate,
           costOf: costOf, baseCost: baseCost, usableCaps: usableCaps,
           costOfSend: costOfSend, costIdle: costIdle,
           CAP_TTL_MS: CAP_TTL_MS,
           readCalib: readCalib, recordCap: recordCap, clearCalib: clearCalib,
           installedAt: installedAt,
           scanNode: scanNode, sweep: sweep, start: start, stop: stop };
})();
