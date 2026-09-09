// content.js: the in-page usage readout. Two looks, chosen at install (or later
// on the Settings page) and stored in cub_design:
//   Design 1 ("1", the fallback until asked): a slim full-width bar under the composer.
//   Design 2 ("2"): a compact widget tucked into the composer toolbar, between
//                   the "+" button and the model picker. Where the composer has no
//                   toolbar row (the chat composer is a single line: "+", the input
//                   and the mic), it takes its own row under the input instead, so
//                   it never sits beside "Write a message...".
// This file also carries the first-run setup box, for anyone who closed the
// install tab without answering; see the section above fetchAndStore().
// Session + All models are user-toggleable; Opus shows automatically only if the
// account has it. Colors: blue < 30%, Claude orange 30-80%, red > 80%.
// On a free account Claude reports no percentages at all (usage.js sets
// `reported: false`), so the widget switches to the count readout instead of
// showing a row of dashes forever: one row, the messages counted in the current
// 5-hour window, and the countdown to when it rolls over. See session.js.

(function () {
  var TOGGLE_KEY = "cub_enabled";
  var LAST_KEY = "cub_last";
  var SHOW_KEY = "cub_show";
  var DESIGN_KEY = "cub_design";
  var BADGE_KEY = "cub_badge";
  var SETUP_KEY = "cub_setup";
  var FREE_KEY = "cub_free_session";

  var TICK_MS = 30000;             // repaint the countdown; also the refetch check
  var POLL_MS = 60000;             // how stale the numbers may get before we refetch
  var FOCUS_MAX_AGE_MS = 30000;    // ... when a tab comes back to the foreground
  var PLACE_MS = 800;              // placement heartbeat (cheap unless misplaced)
  var STALE_MS = 8 * 60 * 1000;    // past this the readout is dimmed as out of date

  var enabled = true, lastData = null, tickTimer = null, placeTimer = null;
  var inFlight = null;   // in-progress fetch, so the poll and the background alarm share one
  var show = { session: true, allModels: true };
  var design = "1";
  var freeStore = null;   // raw cub_free_session; summarized per paint so the window rolls

  // session/opus use a bar in Design 1; in Design 2 the weekly windows use a ring.
  var SEGS = [
    { key: "session",   label: "Session",    sub: "5h", opus: false, ring: false, tip: "Current rolling 5-hour session" },
    { key: "allModels", label: "All models", sub: "7d", opus: false, ring: true,  tip: "Weekly usage, across all models" },
    { key: "opus",      label: "Opus",       sub: "7d", opus: true,  ring: true,  tip: "Weekly Opus allowance" }
  ];

  function colorClass(p){ return p > 80 ? "cub-high" : p >= 30 ? "cub-mid" : "cub-low"; }
  function pctOf(d){ return Math.max(0, Math.min(100, Math.round(d.pct))); }
  function hasData(d){ return !!(d && d.available && d.pct != null); }

  // Claude answered, with no usage in it: the free plan. Explicitly false, so a
  // reading from before this version (which has no `reported` field) still
  // renders the way it always did rather than flipping to the count readout.
  function isFree(){ return !!lastData && lastData.reported === false; }
  function freeNow(){ return CUBS.summarize(freeStore); }
  function plural(n, word){ return n + " " + word + (n === 1 ? "" : "s"); }

  var FREE_NOTE = "Free plan \u00b7 counted locally";
  var FREE_WHY = "Claude publishes no usage percentage on the free plan, so this counts the " +
                 "messages you send in the rolling 5-hour window. Counting starts when the " +
                 "extension is installed, so the first window can read low.";

  function freeTip(){
    var f = freeNow();
    var t = "Session (5h): ";
    t += f.count ? plural(f.count, "message") + " counted in this window" : "no messages counted yet";
    var left = f.resetAt ? CUB.fmtReset(f.resetAt) : "";
    if (left) t += ", resets in " + left + (CUB.fmtResetAt(f.resetAt) ? " (" + CUB.fmtResetAt(f.resetAt) + ")" : "");
    return t + "\n" + FREE_WHY;
  }

  function freeAria(){
    var f = freeNow();
    var left = f.resetAt ? CUB.fmtReset(f.resetAt) : "";
    return "Session: " + plural(f.count, "message") + " counted in this 5-hour window" +
           (left ? ", resets in " + left : "") + ". No percentage on the free plan.";
  }

  // A count is not a meter, so the row stops claiming to be one.
  function setCount(node){
    node.removeAttribute("aria-valuenow");
    node.setAttribute("role", "status");
    node.setAttribute("aria-valuetext", freeAria());
    node.setAttribute("aria-label", freeAria());
    node.setAttribute("title", freeTip());
  }

  // Hover text: the number, the countdown, the wall-clock time it lands on, what
  // the window means, and how old the reading is. Cheap enough to rebuild on
  // every paint, and it saves a trip to the popup.
  function tipFor(s, d){
    var t = s.label + " (" + s.sub + "): ";
    if (!hasData(d)) t += "no data yet";
    else {
      var pct = pctOf(d), left = pct > 0 ? CUB.fmtReset(d.resetAt) : "";
      t += pct + "% used";
      if (left) t += ", resets in " + left + (CUB.fmtResetAt(d.resetAt) ? " (" + CUB.fmtResetAt(d.resetAt) + ")" : "");
    }
    t += "\n" + s.tip;
    if (lastData && lastData.fetchedAt) t += "\nUpdated " + CUB.fmtAgo(lastData.fetchedAt);
    return t;
  }

  function ariaFor(s, d){
    if (!hasData(d)) return s.label + ": no data";
    var pct = pctOf(d), left = pct > 0 ? CUB.fmtReset(d.resetAt) : "";
    return s.label + ": " + pct + "% used" + (left ? ", resets in " + left : "");
  }

  // ARIA progress state, so a screen reader reads a meter rather than loose text.
  function setProgress(node, d, s){
    node.setAttribute("role", "progressbar");
    if (!hasData(d)){ node.removeAttribute("aria-valuenow"); }
    else node.setAttribute("aria-valuenow", String(pctOf(d)));
    node.setAttribute("aria-valuetext", ariaFor(s, d));
    node.setAttribute("aria-label", ariaFor(s, d));
    node.setAttribute("title", tipFor(s, d));
  }

  // Dimmed as out of date once the numbers are genuinely old, or sooner if the
  // last fetch failed outright: a single miss on a minute-old reading is not
  // worth flagging, a miss on top of a five-minute-old one is.
  var fetchFailed = false;
  function isStale(){
    if (!lastData || !lastData.fetchedAt) return false;
    var age = Date.now() - lastData.fetchedAt;
    return age > STALE_MS || (fetchFailed && age > 2 * 60 * 1000);
  }

  // ===================================================================
  // Theme. claude.ai has its own light/dark setting, which does not have to
  // match the OS, so keying our colors off prefers-color-scheme alone painted a
  // light bar on a dark page (and the reverse) for anyone who overrides it.
  // Read the page's own theme, and fall back to the media query only when the
  // page tells us nothing (which includes claude.ai's own "system" setting).
  // ===================================================================
  var theme = "";   // "dark" | "light" | "" (unknown -> CSS follows the OS)

  function themeFromHints(){
    var el = document.documentElement;
    var attr = (el.getAttribute("data-theme") || el.getAttribute("data-mode") ||
                el.getAttribute("data-color-scheme") || el.style.colorScheme || "").toLowerCase();
    if (attr.indexOf("dark") !== -1 && attr.indexOf("light") === -1) return "dark";
    if (attr.indexOf("light") !== -1 && attr.indexOf("dark") === -1) return "light";
    var cls = " " + (el.className || "") + " " + ((document.body && document.body.className) || "") + " ";
    if (/\sdark\s/.test(cls)) return "dark";
    if (/\slight\s/.test(cls)) return "light";
    return "";
  }

  // Last resort: the page's actual painted background. Works whatever mechanism
  // the site uses, at the cost of one style read (so: only on theme changes).
  function themeFromPaint(){
    var target = document.body || document.documentElement;
    if (!target) return "";
    var m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(target).backgroundColor || "");
    if (!m) return "";
    var p = m[1].split(",").map(Number);
    if (p.length < 3 || (p.length > 3 && p[3] < 0.5)) return "";   // transparent: tells us nothing
    return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) < 128 ? "dark" : "light";
  }

  function applyTheme(){
    [barEl, inlineEl, setupEl].forEach(function(el){
      if (!el) return;
      el.classList.toggle("cub-theme-dark", theme === "dark");
      el.classList.toggle("cub-theme-light", theme === "light");
    });
  }

  function detectTheme(){
    var next = themeFromHints() || themeFromPaint();
    if (next === theme) return;
    theme = next;
    applyTheme();
  }

  function watchTheme(){
    var pending = false;
    var recheck = function(){
      if (pending) return;
      pending = true;
      setTimeout(function(){ pending = false; detectTheme(); }, 250);
    };
    new MutationObserver(recheck).observe(document.documentElement, {
      attributes: true, attributeFilter: ["class", "style", "data-theme", "data-mode", "data-color-scheme"]
    });
    if (document.body) new MutationObserver(recheck).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", recheck); } catch (e) {}
    detectTheme();
  }

  // ===================================================================
  // Design 1: slim full-width bar under the composer.
  // ===================================================================
  var barEl = null;
  var barObserver = null, barObservedParent = null, barObservedComposer = null, barReinserts = [];

  function segHtml(s){
    return '<div class="cub-seg" role="progressbar" aria-valuemin="0" aria-valuemax="100" data-seg="'+s.key+'">'+
      '<span class="cub-label"><span class="cub-name">'+s.label+'</span> <span class="cub-sub">'+s.sub+'</span></span>'+
      '<span class="cub-track"><span class="cub-fill"></span></span>'+
      '<span class="cub-note" hidden></span>'+
      '<span class="cub-val">–</span>'+
      '<span class="cub-reset"></span>'+
    '</div>';
  }

  function buildBar(){
    var bar = document.createElement("div");
    bar.id = "cub-bar"; bar.className = "cub-bar";
    bar.innerHTML = SEGS.map(segHtml).join("");
    return bar;
  }

  // The free readout, in the same four columns: the note stands in for the bar
  // (exactly one of the two is ever in the grid, so nothing shifts).
  function fillCountSeg(node){
    var f = freeNow();
    node.querySelector(".cub-track").hidden = true;
    var note = node.querySelector(".cub-note");
    note.hidden = false; note.textContent = FREE_NOTE;
    node.querySelector(".cub-val").textContent = f.count + " msg";
    node.querySelector(".cub-reset").textContent = f.resetAt ? CUB.fmtReset(f.resetAt) : "";
    setCount(node);
  }

  function fillSeg(node, d, s){
    var val = node.querySelector(".cub-val");
    var fill = node.querySelector(".cub-fill");
    var reset = node.querySelector(".cub-reset");
    node.querySelector(".cub-track").hidden = false;
    node.querySelector(".cub-note").hidden = true;
    if (!hasData(d)){
      val.textContent = "–"; fill.style.width = "0%"; fill.className = "cub-fill"; reset.textContent = "";
      setProgress(node, d, s);
      return;
    }
    var pct = pctOf(d);
    val.textContent = pct + "%";
    fill.style.width = pct + "%";
    fill.className = "cub-fill " + colorClass(pct);
    reset.textContent = pct > 0 ? CUB.fmtReset(d.resetAt) : "";
    setProgress(node, d, s);
  }

  function renderBar(){
    if (!barEl) return;
    var free = isFree();
    var any = false;
    SEGS.forEach(function(s){
      var node = barEl.querySelector('[data-seg="'+s.key+'"]');
      if (!node) return;
      var d = lastData ? lastData[s.key] : null;
      // Free: only the session row, and only as a count. The weekly windows do
      // not exist on that plan, so there is nothing honest to put in them.
      var canShow = free ? (s.key === "session" && show.session !== false)
                  : s.opus ? hasData(d) : (show[s.key] !== false);
      node.hidden = !canShow;
      if (canShow){ any = true; free ? fillCountSeg(node) : fillSeg(node, d, s); }
    });
    barEl.classList.toggle("cub-stale", isStale());
    barEl.style.display = any ? "" : "none";
  }

  // The chat input differs across surfaces (contenteditable on /new & chats, and
  // the Claude Code app on /code). From the bottom-most input, walk up while each
  // parent only wraps the input line (same height). A horizontal row (input beside
  // a send button) never adds height, so we skip past it; we stop at the first
  // composer-width parent that is TALLER, the vertical stack that also holds the
  // toolbar. Inserting the bar after `node` there makes it a full-width row between
  // the input and the toolbar, so it can never land beside/over the input.
  function findComposer(){
    var editor = findEditor();
    if (!editor) return null;
    var node = editor, firstWide = null;
    for (var j=0; j<8; j++){
      var parent = node.parentElement;
      if (!parent) break;
      var pr = parent.getBoundingClientRect();
      if (pr.width >= 320){
        if (!firstWide) firstWide = node;
        if (pr.height > node.getBoundingClientRect().height + 12) return node;
      }
      node = parent;
    }
    return firstWide || editor.parentElement;
  }

  function insertBar(composer){
    composer.insertAdjacentElement("afterend", barEl);
    barEl.classList.remove("cub-fixed");
  }

  // Allow bursts of re-insertion but back off if a surface fights us every frame,
  // so we never spin in a tight loop against React (the heartbeat re-acquires instead).
  function barReinsertAllowed(){
    var now = Date.now();
    barReinserts.push(now);
    while (barReinserts.length && now - barReinserts[0] > 1000) barReinserts.shift();
    return barReinserts.length <= 5;
  }

  function stopBarWatching(){
    if (barObserver) barObserver.disconnect();
    barObserver = null; barObservedParent = null; barObservedComposer = null;
  }

  // Watch the composer's parent so that if a re-render detaches the bar we put it
  // back synchronously (before paint) instead of waiting for the next heartbeat.
  function watchBarParent(parent, composer){
    if (barObservedParent === parent && barObservedComposer === composer) return;
    stopBarWatching();
    barObservedParent = parent; barObservedComposer = composer;
    barObserver = new MutationObserver(function(){
      if (!enabled || design !== "1" || !barEl || barEl.isConnected) return;
      if (!composer.isConnected) return;      // composer replaced -> let the heartbeat re-acquire
      if (!barReinsertAllowed()) return;      // thrashing -> back off
      insertBar(composer);
      renderBar();
    });
    barObserver.observe(parent, { childList: true });
  }

  function placeBar(){
    if (!barEl){ barEl = buildBar(); applyTheme(); }
    var composer = findComposer();
    if (composer && composer.parentElement){
      anchor = composer;
      if (!(barEl.parentElement === composer.parentElement && barEl.previousElementSibling === composer)) insertBar(composer);
      watchBarParent(composer.parentElement, composer);
      renderBar();
      return true;
    }
    anchor = null;
    stopBarWatching();
    if (!barEl.isConnected){ barEl.classList.add("cub-fixed"); document.body.appendChild(barEl); }
    renderBar();
    return false;   // still hunting for a composer: keep checking, with backoff
  }

  // ===================================================================
  // Design 2: compact widget inside the composer toolbar.
  // ===================================================================
  var inlineEl = null;
  var inlineObserver = null, inlineObservedParent = null, inlineObservedMode = "", inlineReinserts = [];
  var inlineResizeObserver = null, inlineLastMissLog = 0;
  var RING_C = 2 * Math.PI * 8; // circumference of the r=8 ring

  function inlineSegHtml(s){
    var indicator = s.ring
      ? '<span class="cub-i-ring">'+
          '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">'+
            '<circle class="cub-i-ring-bg" cx="10" cy="10" r="8"></circle>'+
            '<circle class="cub-i-ring-fill" cx="10" cy="10" r="8"></circle>'+
          '</svg>'+
        '</span>'
      : '<span class="cub-i-bar"><span class="cub-i-fill"></span></span>';
    var val = '<span class="cub-i-val">–</span>';
    // Bar window reads value-then-bar; ring windows read ring-then-value.
    var inner = s.ring ? (indicator + val) : (val + indicator);
    return '<span class="cub-i-seg" role="progressbar" aria-valuemin="0" aria-valuemax="100" data-seg="'+s.key+'">'+
      inner + '<span class="cub-i-reset" hidden></span></span>';
  }

  function buildInline(){
    var el = document.createElement("div");
    el.id = "cub-inline"; el.className = "cub-inline";
    el.innerHTML = SEGS.map(inlineSegHtml).join("");
    return el;
  }

  // Free, compact: "12 msg \u00b7 2h 41m". No indicator, because there is no
  // percentage to indicate.
  function fillCountInlineSeg(node){
    var f = freeNow();
    var ind = node.querySelector(".cub-i-ring") || node.querySelector(".cub-i-bar");
    if (ind) ind.hidden = true;
    node.querySelector(".cub-i-val").textContent = f.count + " msg";
    var reset = node.querySelector(".cub-i-reset");
    reset.hidden = false;
    reset.textContent = f.resetAt ? CUB.fmtReset(f.resetAt) : "";
    setCount(node);
  }

  function fillInlineSeg(node, d, s){
    var val = node.querySelector(".cub-i-val");
    var ind0 = node.querySelector(".cub-i-ring") || node.querySelector(".cub-i-bar");
    if (ind0) ind0.hidden = false;
    node.querySelector(".cub-i-reset").hidden = true;
    if (!hasData(d)){
      val.textContent = "–";
      if (s.ring){
        var rf0 = node.querySelector(".cub-i-ring-fill");
        rf0.style.strokeDasharray = RING_C; rf0.style.strokeDashoffset = RING_C; rf0.setAttribute("class", "cub-i-ring-fill");
      } else {
        var f0 = node.querySelector(".cub-i-fill");
        f0.style.width = "0%"; f0.className = "cub-i-fill";
      }
      setProgress(node, d, s);
      return;
    }
    var pct = pctOf(d);
    var cc = colorClass(pct);
    val.textContent = pct + "%";
    if (s.ring){
      var rf = node.querySelector(".cub-i-ring-fill");
      rf.style.strokeDasharray = RING_C;
      rf.style.strokeDashoffset = RING_C * (1 - pct / 100);
      rf.setAttribute("class", "cub-i-ring-fill " + cc);
    } else {
      var f = node.querySelector(".cub-i-fill");
      f.style.width = pct + "%";
      f.className = "cub-i-fill " + cc;
    }
    setProgress(node, d, s);
  }

  function renderInline(){
    if (!inlineEl) return;
    var free = isFree();
    var any = false;
    SEGS.forEach(function(s){
      var node = inlineEl.querySelector('[data-seg="'+s.key+'"]');
      if (!node) return;
      var d = lastData ? lastData[s.key] : null;
      var canShow = free ? (s.key === "session" && show.session !== false)
                  : s.opus ? hasData(d) : (show[s.key] !== false);
      node.hidden = !canShow;
      if (canShow){ any = true; free ? fillCountInlineSeg(node) : fillInlineSeg(node, d, s); }
    });
    inlineEl.classList.toggle("cub-stale", isStale());
    inlineEl.style.display = any ? "" : "none";
  }

  // Find the toolbar's "+" button. We can't assume the toolbar lives in any one
  // specific parent (on /new the empty input sits in a min-height wrapper that is
  // already taller than the text, so the composer's toolbar is a sibling row higher
  // up). So walk up from the editor and, at each composer-width ancestor, look for
  // the bottom-most row of controls sitting in the band just below the input; the
  // innermost match is the composer's own toolbar. Purely geometric, so it survives
  // claude.ai's class/label churn like the bar placement does.
  function findPlusButton(){
    var editor = findEditor();
    if (!editor) return null;
    var er = editor.getBoundingClientRect();
    var node = editor;
    for (var j = 0; j < 10; j++){
      var parent = node.parentElement;
      if (!parent) break;
      if (parent.getBoundingClientRect().width >= 280){
        var plus = toolbarPlusIn(parent, er, editor);
        if (plus) return plus;            // innermost match = the composer toolbar
      }
      node = parent;
    }
    return null;
  }

  // A control on the input's own line is not a toolbar. The chat composer is one
  // row -- "+", the input, the mic -- so anchoring to its "+" put the widget beside
  // the text and pushed "Write a message..." over. Two geometric ways to tell, both
  // of which the real toolbar row (a row of its own, under the input) fails: the
  // input's mid-line runs through the control, or the input starts to its right on
  // the same line.
  function sharesLineWithEditor(r, er){
    var overlap = Math.min(er.bottom, r.bottom) - Math.max(er.top, r.top);
    if (overlap <= 0) return false;
    var mid = er.top + er.height / 2;
    if (mid > r.top - 6 && mid < r.bottom + 6) return true;
    return overlap > r.height * 0.6 && er.left >= r.right - 4;
  }

  // The left-most control of the bottom-most row of toolbar controls in `container`,
  // limited to the band at/just below the input so page/sidebar buttons can't sneak
  // in. Broadened past <button> since claude.ai renders some controls as role=button.
  function toolbarPlusIn(container, er, editor){
    var btns = [];
    container.querySelectorAll('button, [role="button"]').forEach(function(b){
      if (b === editor || b.contains(editor)) return;                 // not the input itself
      if (inlineEl && inlineEl.contains(b)) return;                   // and never our own widget
      if (!b.offsetParent && b.getClientRects().length === 0) return; // hidden
      var r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.height > 64) return;   // button-sized only
      if (r.top < er.top - 8 || r.top > er.bottom + 140) return;      // composer toolbar band
      if (sharesLineWithEditor(r, er)) return;                        // the input's own row
      btns.push({ el: b, r: r });
    });
    if (btns.length < 2) return null;
    var maxBottom = Math.max.apply(null, btns.map(function(x){ return x.r.bottom; }));
    var row = btns.filter(function(x){ return maxBottom - x.r.bottom <= 16; }); // bottom-most row
    if (row.length < 2) return null;
    row.sort(function(a, b){ return a.r.left - b.r.left; });
    return row[0].el; // left-most = the "+"
  }

  function inlineReinsertAllowed(){
    var now = Date.now();
    inlineReinserts.push(now);
    while (inlineReinserts.length && now - inlineReinserts[0] > 1000) inlineReinserts.shift();
    return inlineReinserts.length <= 5;
  }

  function stopInlineWatching(){
    if (inlineObserver) inlineObserver.disconnect();
    if (inlineResizeObserver) inlineResizeObserver.disconnect();
    inlineObserver = null; inlineResizeObserver = null; inlineObservedParent = null; inlineObservedMode = "";
  }

  // Re-insert the widget after the "+" if a re-render detaches it, mirroring the
  // bar's watcher and its back-off. The ResizeObserver covers the other half:
  // alignment only ever changes when the toolbar's own box does, so we re-measure
  // then instead of on every heartbeat.
  function watchToolbar(parent){
    if (inlineObservedParent === parent && inlineObservedMode === "toolbar") return;
    stopInlineWatching();
    inlineObservedParent = parent; inlineObservedMode = "toolbar";
    inlineObserver = new MutationObserver(function(){
      if (!enabled || design !== "2" || !inlineEl || inlineEl.isConnected) return;
      if (!parent.isConnected) return;         // toolbar replaced -> let the heartbeat re-acquire
      if (!inlineReinsertAllowed()) return;    // thrashing -> back off
      var plus = findPlusButton();
      if (plus && plus.parentElement === parent){ anchor = plus; plus.insertAdjacentElement("afterend", inlineEl); alignInline(plus); renderInline(); }
    });
    inlineObserver.observe(parent, { childList: true });
    if (typeof ResizeObserver === "function"){
      var queued = false;
      inlineResizeObserver = new ResizeObserver(function(){
        if (queued) return;
        queued = true;
        requestAnimationFrame(function(){ queued = false; if (design === "2" && anchor && anchor.isConnected) alignInline(anchor); });
      });
      inlineResizeObserver.observe(parent);
    }
  }

  // Same job for the fallback row, mirroring the bar's watcher: if a re-render
  // detaches the widget, put it straight back under the input rather than waiting
  // for the next heartbeat. No ResizeObserver here -- a full-width row of its own
  // has nothing to align to.
  function watchInlineRow(parent, composer){
    if (inlineObservedParent === parent && inlineObservedMode === "row") return;
    stopInlineWatching();
    inlineObservedParent = parent; inlineObservedMode = "row";
    inlineObserver = new MutationObserver(function(){
      if (!enabled || design !== "2" || !inlineEl || inlineEl.isConnected) return;
      if (!composer.isConnected) return;        // composer replaced -> let the heartbeat re-acquire
      if (!inlineReinsertAllowed()) return;     // thrashing -> back off
      composer.insertAdjacentElement("afterend", inlineEl);
      renderInline();
    });
    inlineObserver.observe(parent, { childList: true });
  }

  // Vertically center the widget on the "+" button, whatever the toolbar's own
  // alignment happens to be (CSS align-self can't help when we don't control the
  // parent). Clear our transform first so the read is clean, then shift the widget
  // by the difference between the two boxes' centers. This forces a layout, so it
  // runs on (re)insert and on toolbar resize only, never on the heartbeat.
  function alignInline(plus){
    if (!inlineEl || !inlineEl.isConnected || !plus) return;
    inlineEl.style.transform = "none";
    var p = plus.getBoundingClientRect();
    var w = inlineEl.getBoundingClientRect();
    if (!p.height || !w.height){ inlineEl.style.transform = ""; return; }
    var delta = (p.top + p.height / 2) - (w.top + w.height / 2);
    inlineEl.style.transform = Math.abs(delta) > 0.5 ? "translateY(" + delta.toFixed(1) + "px)" : "";
  }

  function placeInline(){
    if (!inlineEl){ inlineEl = buildInline(); applyTheme(); }
    var plus = findPlusButton();
    if (plus && plus.parentElement){
      var parent = plus.parentElement;
      anchor = plus;
      inlineEl.classList.remove("cub-inline-row");
      if (!(inlineEl.parentElement === parent && inlineEl.previousElementSibling === plus)) plus.insertAdjacentElement("afterend", inlineEl);
      alignInline(plus);
      watchToolbar(parent);
      renderInline();
      return true;
    }
    // No toolbar row to sit in (the chat composer is a single line). Take a row of
    // our own directly under the input instead, at the same insertion point Design 1
    // uses, so the readout still reads as "under the message" and the placeholder
    // keeps its place.
    var composer = findComposer();
    if (composer && composer.parentElement){
      anchor = composer;
      inlineEl.classList.add("cub-inline-row");
      inlineEl.style.transform = "";   // drop any leftover shift from alignInline()
      if (!(inlineEl.parentElement === composer.parentElement && inlineEl.previousElementSibling === composer)) composer.insertAdjacentElement("afterend", inlineEl);
      watchInlineRow(composer.parentElement, composer);
      renderInline();
      return true;
    }
    // Inline-only: nothing to attach to at all, so show nothing and retry later.
    anchor = null;
    stopInlineWatching();
    if (inlineEl.isConnected) inlineEl.remove();
    var now = Date.now();
    if (now - inlineLastMissLog > 5000){
      inlineLastMissLog = now;
      try { console.debug("[Claude Usage Bar] Design 2: composer not found; will retry"); } catch (e) {}
    }
    return false;
  }

  // ===================================================================
  // Shared: finding the composer, placement heartbeat, polling, on/off.
  // ===================================================================

  // Find the composer input: the bottom-most visible, non-tiny editor on the page
  // (the composer always sits at the bottom). Shared by both designs, and by both
  // of the walks above within a single pass, hence the one-tick memo: this reads
  // layout for every candidate and used to run twice per placement attempt.
  var editorMemo = null, editorMemoAt = 0;
  function findEditor(){
    if (editorMemo && editorMemo.isConnected && Date.now() - editorMemoAt < 50) return editorMemo;
    var nodes = document.querySelectorAll('div[contenteditable="true"], p[contenteditable="true"], textarea');
    var editor = null, bestBottom = -Infinity;
    for (var i=0; i<nodes.length; i++){
      var n = nodes[i];
      if (!n.offsetParent && n.getClientRects().length === 0) continue; // hidden
      var r = n.getBoundingClientRect();
      if (r.width < 120 || r.height === 0) continue;                    // tiny/collapsed
      if (r.bottom > bestBottom){ bestBottom = r.bottom; editor = n; }
    }
    editorMemo = editor; editorMemoAt = Date.now();
    return editor;
  }

  function render(){ design === "2" ? renderInline() : renderBar(); }

  // Count sends only on an account that has nothing to fetch. A paid account
  // never starts the observer, so it costs nothing there, and the counting
  // stops by itself if a free account upgrades.
  function syncFreeWatch(){
    // Counting writes cub_free_session, and that write reaches the storage
    // listener below in this tab as well as every other one, so the repaint is
    // already handled there -- there is nothing for the callback to do.
    if (enabled && isFree()) CUBS.watch(null);
    else CUBS.unwatch();
  }

  // A failed fetch keeps the last-known numbers on screen (they are still the best
  // information we have) and lets the stale styling and the tooltip say so. Only a
  // failure with nothing cached shows the bare error mark.
  function markError(){
    var el = design === "2" ? inlineEl : barEl;
    if (!el) return;
    if (lastData){ render(); return; }   // keep the numbers; isStale() decides on the dimming
    el.querySelectorAll(design === "2" ? ".cub-i-val" : ".cub-val").forEach(function(v){ v.textContent = "!"; });
  }

  function removeWidgets(){
    stopBarWatching();
    stopInlineWatching();
    if (barEl && barEl.isConnected) barEl.remove();
    if (inlineEl && inlineEl.isConnected) inlineEl.remove();
    anchor = null;
  }

  // The widget is placed correctly if it still sits right after the node we
  // anchored it to. Every check here is a plain property read, no layout, which is
  // what makes it safe to run on a short heartbeat: the geometric search below
  // (querySelectorAll plus a getBoundingClientRect per candidate) only runs when
  // this fails, instead of several times a second for the life of the tab.
  var anchor = null, misses = 0, nextTryAt = 0;

  function placedCorrectly(){
    var el = design === "2" ? inlineEl : barEl;
    if (!el || !el.isConnected || !anchor || !anchor.isConnected) return false;
    return el.previousElementSibling === anchor;
  }

  function place(force){
    if (!enabled){ removeWidgets(); return; }
    if (!force && placedCorrectly()) return;
    var now = Date.now();
    if (!force && now < nextTryAt) return;
    var ok = design === "2" ? placeInline() : placeBar();
    if (ok){ misses = 0; nextTryAt = 0; maybeShowSetup(); }
    else {
      // Nothing to attach to (a page with no composer, or a surface mid-render).
      // Ease off rather than paying for the full search 75 times a minute, but
      // stay responsive enough that a composer appearing is picked up quickly.
      misses++;
      nextTryAt = now + Math.min(3200, PLACE_MS * Math.pow(2, Math.min(misses, 2)));
    }
  }

  function switchDesign(next){
    if (next === design) return;
    removeWidgets();          // tear down the old look (widget + observer)
    design = next;
    misses = 0; nextTryAt = 0;
    if (enabled){ place(true); render(); }
  }

  // ===================================================================
  // First-run setup box. background.js opens welcome.html in a tab the moment
  // the extension is installed; this is the second chance, for anyone who
  // closed that tab without answering. Asking here has one thing the tab
  // cannot do: clicking a design writes cub_design, the storage listener below
  // calls switchDesign(), and the real widget swaps on the page behind the box.
  //
  // Both surfaces write cub_setup, so answering in either one settles it.
  // ===================================================================
  var setupEl = null;
  var setupPending = false;      // asked for, not yet shown or answered here
  var setupAnsweredHere = false; // ignore the cub_setup change we caused ourselves

  function setupTile(v, name, desc){
    return '<button class="cub-su-tile" type="button" data-design="' + v + '" aria-pressed="false">' +
        '<img class="cub-su-shot" src="' + chrome.runtime.getURL("previews/design-" + v + ".png") + '" alt="" />' +
        '<span class="cub-su-name">' + name + '</span>' +
        '<span class="cub-su-desc">' + desc + '</span>' +
      '</button>';
  }

  function buildSetup(){
    var el = document.createElement("div");
    el.id = "cub-setup"; el.className = "cub-setup";
    el.innerHTML =
      '<div class="cub-su-backdrop"></div>' +
      '<div class="cub-su-box" role="dialog" aria-label="Set up Claude Usage Bar">' +
        '<button class="cub-su-x" type="button" aria-label="Close">×</button>' +
        '<div class="cub-su-title">Pick a design</div>' +
        '<div class="cub-su-sub">Claude Usage Bar is installed. Choose a look — it changes on the page behind this box as you click.</div>' +
        '<div class="cub-su-designs">' +
          setupTile("1", "Design 1", "Full bar under the chat") +
          setupTile("2", "Design 2", "Compact, in the toolbar") +
        '</div>' +
        '<div class="cub-su-badge">' +
          '<span class="cub-su-badge-text">' +
            '<span class="cub-su-badge-label">Show usage on the toolbar icon</span>' +
            '<span class="cub-su-badge-sub">A colored usage number on the extension icon.</span>' +
          '</span>' +
          '<button class="cub-su-switch" type="button" role="switch" aria-checked="false" ' +
            'aria-label="Show usage on the toolbar icon"></button>' +
        '</div>' +
        '<button class="cub-su-done" type="button" disabled>Pick a design to continue</button>' +
        '<div class="cub-su-foot">Both can be changed later in Settings.</div>' +
      '</div>';
    return el;
  }

  // Answered: nothing more to ask, on this tab or any other one that has a box open.
  function answerSetup(){
    setupAnsweredHere = true;
    chrome.storage.local.set({ [SETUP_KEY]: { done: true, at: Date.now() } });
  }

  function hideSetup(){
    if (setupEl && setupEl.isConnected) setupEl.remove();
    setupEl = null;
  }

  function endSetup(){ setupPending = false; hideSetup(); }

  function markSetupPicked(v){
    if (!setupEl) return;
    setupEl.querySelectorAll(".cub-su-tile").forEach(function(t){
      t.setAttribute("aria-pressed", String(t.getAttribute("data-design") === v));
    });
    var done = setupEl.querySelector(".cub-su-done");
    done.disabled = false;
    done.textContent = "Done";
  }

  function wireSetup(el){
    el.querySelectorAll(".cub-su-tile").forEach(function(tile){
      tile.addEventListener("click", function(){
        var v = tile.getAttribute("data-design");
        markSetupPicked(v);
        chrome.storage.local.set({ [DESIGN_KEY]: v });   // switchDesign() repaints from onChanged
        answerSetup();                                   // the design is the answer we asked for
      });
    });

    // Reads through to the badge the same way the Settings page does, rather
    // than assuming the stored shape: the source stays whatever it already was.
    el.querySelector(".cub-su-switch").addEventListener("click", function(){
      var sw = this;
      var next = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", String(next));
      chrome.storage.local.get([BADGE_KEY], function(o){
        var b = Object.assign({ enabled: false, source: "session" }, o[BADGE_KEY] || {}, { enabled: next });
        chrome.storage.local.set({ [BADGE_KEY]: b });
      });
    });

    // Dismissing settles it too, so the box is asked once and never nags on
    // every page load. Settings keeps both choices reachable either way.
    el.querySelector(".cub-su-x").addEventListener("click", function(){ answerSetup(); endSetup(); });
    el.querySelector(".cub-su-done").addEventListener("click", function(){ answerSetup(); endSetup(); });
    el.querySelector(".cub-su-backdrop").addEventListener("click", function(){ answerSetup(); endSetup(); });
  }

  // Called from place() on a successful placement, so the box only ever appears
  // on a surface that actually has a composer: never over the login screen, and
  // never before there is something for the live preview to change.
  function maybeShowSetup(){
    if (!setupPending || setupEl || !enabled || !document.body) return;
    setupEl = buildSetup();
    wireSetup(setupEl);
    applyTheme();
    document.body.appendChild(setupEl);
    chrome.storage.local.get([BADGE_KEY], function(o){
      if (!setupEl) return;
      var b = o[BADGE_KEY] || {};
      setupEl.querySelector(".cub-su-switch").setAttribute("aria-checked", String(!!b.enabled));
    });
  }

  // The fetch-and-store half of refresh(), independent of `enabled` and of the
  // DOM, so the background alarm can borrow this tab's same-origin session even
  // when the bar itself is switched off. Concurrent callers share one request.
  function fetchAndStore(){
    if (inFlight) return inFlight;
    inFlight = CUB.getUsage().then(function (data){
      lastData = data; fetchFailed = false;
      chrome.storage.local.set({ [LAST_KEY]: data });
      syncFreeWatch();
      if (enabled) render();
      return data;
    });
    // Clear the slot either way, without swallowing the rejection the caller sees.
    inFlight.catch(function(){}).then(function(){ inFlight = null; });
    return inFlight;
  }

  // Skip the network when the numbers we already have are younger than maxAge.
  // Every claude.ai tab used to poll on its own timer, so N open tabs meant N
  // requests a minute for one answer; storage.onChanged already fans the result
  // out to all of them, so whichever tab asks first now serves the rest.
  async function refresh(maxAge){
    if (!enabled) return;
    if (maxAge && lastData && lastData.fetchedAt && Date.now() - lastData.fetchedAt < maxAge) return;
    try { await fetchAndStore(); } catch (e) { fetchFailed = true; markError(); }
  }

  // One heartbeat for both jobs: repaint the countdown from cached data (so
  // "resets in 2h 14m" ticks down on its own) and refetch only once the numbers
  // are actually old enough to be worth a request.
  function tick(){
    if (document.visibilityState !== "visible") return;
    if (enabled) render();
    refresh(POLL_MS - 5000);
  }

  function startPolling(){
    stopPolling();
    refresh(FOCUS_MAX_AGE_MS);
    tickTimer = setInterval(tick, TICK_MS);
  }
  function stopPolling(){ if (tickTimer) clearInterval(tickTimer); tickTimer = null; }

  // The placement heartbeat is pointless in a background tab: nothing is visible
  // and claude.ai is not re-rendering the composer under us. Stop it there and
  // re-place on the way back in.
  function startPlacing(){
    if (placeTimer) return;
    placeTimer = setInterval(function(){ place(); }, PLACE_MS);
  }
  function stopPlacing(){ if (placeTimer) clearInterval(placeTimer); placeTimer = null; }

  function enable(){
    enabled = true;
    place(true);
    if (document.visibilityState === "visible") startPlacing();
    startPolling();
    syncFreeWatch();
  }
  // The setup box only hides here: the extension being switched off is not an
  // answer, so it comes back with the bar if it is switched on again.
  function disable(){
    enabled = false; stopPolling(); stopPlacing(); removeWidgets(); hideSetup();
    CUBS.unwatch();
  }

  chrome.storage.onChanged.addListener(function (changes, area){
    if (area !== "local") return;
    if (changes[TOGGLE_KEY]) { changes[TOGGLE_KEY].newValue === false ? disable() : enable(); }
    if (changes[LAST_KEY] && changes[LAST_KEY].newValue){
      lastData = changes[LAST_KEY].newValue; syncFreeWatch(); if (enabled) render();
    }
    // Another tab counted a send, or this one did: repaint from the store
    // rather than from whatever the counter handed back.
    if (changes[FREE_KEY]){ freeStore = changes[FREE_KEY].newValue || null; if (enabled) render(); }
    if (changes[SHOW_KEY] && changes[SHOW_KEY].newValue){ show = Object.assign({ session:true, allModels:true }, changes[SHOW_KEY].newValue); if (enabled) render(); }
    if (changes[DESIGN_KEY]) { switchDesign(changes[DESIGN_KEY].newValue === "2" ? "2" : "1"); }
    // Answered somewhere else (the install tab, or another claude.ai tab): close
    // our box. Our own answer is skipped, or picking a design would shut the box
    // before the user got to the toolbar-icon question.
    if (changes[SETUP_KEY] && !setupAnsweredHere){
      var v = changes[SETUP_KEY].newValue;
      if (v && v.done) endSetup();
    }
  });

  // The background alarm prefers to have an open claude.ai tab do the fetching,
  // because from here the request is same-origin: the path we know works. We
  // answer regardless of the master toggle, which only governs the visible bar.
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse){
    if (!msg || msg.type !== "cub:refresh") return;   // not ours: leave the channel alone
    fetchAndStore().then(
      function (d){ sendResponse({ ok: true, fetchedAt: d.fetchedAt }); },
      function (e){ sendResponse({ ok: false, code: (e && e.code) || "ERR", status: (e && e.status) || 0 }); }
    );
    return true;                                      // sendResponse is async
  });

  document.addEventListener("visibilitychange", function(){
    if (document.visibilityState !== "visible"){ stopPlacing(); return; }
    if (!enabled) return;
    detectTheme();          // the page may have been re-themed while we were away
    place(true);
    startPlacing();
    render();
    refresh(FOCUS_MAX_AGE_MS);
  });

  chrome.storage.local.get([TOGGLE_KEY, LAST_KEY, SHOW_KEY, DESIGN_KEY, SETUP_KEY, FREE_KEY], function (o){
    if (o[LAST_KEY]) lastData = o[LAST_KEY];
    if (o[FREE_KEY]) freeStore = o[FREE_KEY];
    if (o[SHOW_KEY]) show = Object.assign(show, o[SHOW_KEY]);
    // Design 1 stays the fallback while setup is pending, so the bar works from
    // the moment of install rather than waiting on an answer that may not come.
    design = o[DESIGN_KEY] === "2" ? "2" : "1";
    enabled = o[TOGGLE_KEY] !== false;
    setupPending = !(o[SETUP_KEY] && o[SETUP_KEY].done);
    watchTheme();
    if (enabled) enable();
  });
})();
