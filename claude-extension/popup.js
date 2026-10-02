// popup.js: the slim popup. Usage readout (every limit Claude reports, and the
// extra-usage spend), show-in-bar toggles, Refresh, and a Settings button.
// Everything else (master on/off, badge, account switch, hotkey) lives on the
// options page.
var LAST_KEY = "cub_last";
var SHOW_KEY = "cub_show";
var FREE_KEY = "cub_free_session";
var DEFAULT_SHOW = { session: true, allModels: true, scoped: true, credits: true };
var FRESH_MS = 60000;      // opening the popup on newer numbers than this costs no request

var shown = null;          // what is currently painted, for the "updated" line
var statusTimer = null;

function plural(n, w){ return n + " " + w + (n === 1 ? "" : "s"); }

// Elements are built from text nodes, never innerHTML: limit and account names
// come back from the API, and this page holds the chrome.* APIs.
function el(tag, cls, text){
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function track(pct){
  var t = el("div", "p-track");
  var f = el("div", "p-fill " + CUB.colorLevel(pct));
  f.style.width = (pct == null ? 0 : pct) + "%";
  t.appendChild(f);
  return t;
}

function head(label, sub, value){
  var h = el("div", "p-row-head");
  h.appendChild(el("span", "p-label", label));
  if (sub) h.appendChild(el("span", "p-sub", sub));
  h.appendChild(el("span", "p-val", value));
  return h;
}

// The free-plan row: a count and a countdown, with a line saying why there is no
// percentage. Claude publishes none for free accounts, and inventing one would
// need a cap that moves with demand.
function freeRows(f){
  var frag = document.createDocumentFragment();
  var left = f.resetAt ? CUB.fmtReset(f.resetAt) : "";
  var at = left ? CUB.fmtResetAt(f.resetAt) : "";
  var row = el("div", "p-row");
  row.setAttribute("role", "status");
  row.setAttribute("aria-label", "Session: " + plural(f.count, "message") + " counted in this 5-hour window" +
                   (left ? ", resets in " + left : ""));
  row.appendChild(head("Session", "5h", f.count + " msg"));
  if (left) row.appendChild(el("div", "p-reset", "resets in " + left + (at ? " · " + at : "")));
  frag.appendChild(row);
  frag.appendChild(el("div", "p-note", "Free plan: Claude reports no usage percentage, so this counts " +
    "the messages you send in the rolling 5-hour window. Counting starts at install."));
  return frag;
}

function limitRow(l){
  var pct = l.pct != null ? Math.round(l.pct) : null;
  var left = l.resetAt && pct > 0 ? CUB.fmtReset(l.resetAt) : "";
  var at = left ? CUB.fmtResetAt(l.resetAt) : "";
  var aria = l.label + ": " + (pct == null ? "no data" : pct + "% used" + (left ? ", resets in " + left : ""));
  var row = el("div", "p-row");
  row.setAttribute("role", "progressbar");
  row.setAttribute("aria-valuemin", "0");
  row.setAttribute("aria-valuemax", "100");
  if (pct != null) row.setAttribute("aria-valuenow", String(pct));
  row.setAttribute("aria-valuetext", aria);
  row.setAttribute("aria-label", aria);
  if (l.tip) row.title = l.tip;
  row.appendChild(head(l.label, l.sub, pct == null ? "–" : pct + "%"));
  row.appendChild(track(pct));
  if (left) row.appendChild(el("div", "p-reset", "resets in " + left + (at ? " · " + at : "")));
  return row;
}

// Extra usage: what has been spent, against the monthly cap when there is one,
// with the balance and auto-reload when Claude reports them, and what state the
// spending is in right now.
function creditsCard(data){
  var c = data.credits, cur = c.currency;
  var card = el("div", "p-row p-credits");
  var state = !c.enabled ? ["Off", "off"] : c.capReached ? ["Cap reached", "cap"]
            : CUB.creditsInUse(data) ? ["In use", "live"] : null;
  var h = head(c.label || "Extra usage", "", CUB.fmtMoney(c.used, cur));
  if (state) h.insertBefore(el("span", "p-chip p-chip-" + state[1], state[0]), h.lastChild);
  card.appendChild(h);
  if (c.limit){
    var pct = Math.round(c.pct || 0);
    card.setAttribute("role", "progressbar");
    card.setAttribute("aria-valuemin", "0");
    card.setAttribute("aria-valuemax", "100");
    card.setAttribute("aria-valuenow", String(pct));
    card.appendChild(track(pct));
    card.appendChild(el("div", "p-reset", "of " + CUB.fmtMoney(c.limit, cur, true) + " monthly cap · " + pct + "%"));
  } else {
    card.setAttribute("role", "status");
    card.appendChild(el("div", "p-reset", c.enabled ? "No monthly cap set" : "Spent before it was switched off"));
  }
  card.setAttribute("aria-label", (c.label || "Extra usage") + ": " + CUB.fmtMoney(c.used, cur) +
                    (c.limit ? " of " + CUB.fmtMoney(c.limit, cur, true) : " spent") + (state ? ", " + state[0] : ""));
  var more = [];
  if (c.balance != null) more.push("Balance " + CUB.fmtMoney(c.balance, cur));
  if (c.autoReload != null) more.push("auto-reload " + (c.autoReload ? "on" : "off"));
  if (more.length) card.appendChild(el("div", "p-reset", more.join(" · ")));
  if (state && state[1] === "live"){
    card.appendChild(el("div", "p-note p-note-live", "A limit is full, so what you send now is billed to extra usage at API rates."));
  }
  return card;
}

function renderTier(data){
  var t = document.getElementById("tier");
  var name = data && data.tier ? data.tier : "";
  t.textContent = name;
  t.hidden = !name;
  t.title = data && data.orgName ? data.orgName : "";
}

function render(data, free){
  shown = data || null;
  var rows = document.getElementById("rows");
  rows.textContent = "";
  renderTier(data);
  if (!data){ rows.appendChild(el("div", "p-empty", "No data yet")); return; }
  // Claude answered with nothing in it: the free plan. Show what we counted
  // ourselves rather than three rows of dashes.
  if (data.reported === false){ rows.appendChild(freeRows(free || CUBS.summarize(null))); return; }
  CUB.limitsOf(data).forEach(function(l){ rows.appendChild(limitRow(l)); });
  if (data.credits) rows.appendChild(creditsCard(data));
  if (!rows.firstChild) rows.appendChild(el("div", "p-empty", "No usage reported"));
}

function setStatus(t){ document.getElementById("status").textContent = t; }

// "Updated 3m ago", kept honest while the popup stays open, so a stale reading
// never looks like a fresh one.
function showAge(){
  if (!shown || !shown.fetchedAt) return setStatus("");
  // On the free plan the count above is ours and always current; fetchedAt dates
  // only the once-a-day check for a percentage. "Updated 23h ago" would read as a
  // stale number, so say what was actually checked.
  if (shown.reported === false) return setStatus("Checked " + CUB.fmtAgo(shown.fetchedAt));
  setStatus("Updated " + CUB.fmtAgo(shown.fetchedAt));
}

function setBusy(on){
  var btn = document.getElementById("refresh");
  btn.disabled = on;
  btn.textContent = on ? "…" : "Refresh";
}

async function refresh(force){
  // The popup used to fire a request on every open. The numbers move slowly and
  // an open tab (or the background alarm) is already refreshing them, so unless
  // the user asks we only go to the network when what we have has gone off.
  // Refresh is also the one way past the free plan's day-long hold, so someone
  // who has just upgraded gets their bars back without waiting the day out.
  if (!force && CUB.freeHold(shown)) return showAge();
  if (!force && shown && shown.fetchedAt && Date.now() - shown.fetchedAt < FRESH_MS) return showAge();
  setBusy(true);
  setStatus("Updating…");
  try {
    var data = await CUB.getUsage();
    chrome.storage.local.set({ [LAST_KEY]: data });
    paint(data);
    showAge();
  } catch (e){
    setStatus(e.code==="AUTH" ? "Log in to claude.ai first"
      : e.code==="NO_ORGS" ? "No account found"
      // Logged in, orgs listed, no usage came back: not a login problem, and
      // telling a signed-in free user to sign in is exactly the wrong advice.
      : e.code==="NO_WINDOWS" || e.code==="FORBIDDEN" ? "Claude reported no usage for this account"
      : "Couldn't reach Claude");
  } finally { setBusy(false); }
}

// Paint with the counted free session read alongside, so the popup never has to
// care which of the two readouts it is about to draw.
function paint(data){
  // Set before the free branch's asynchronous read, not only inside render():
  // showAge() and refresh() both run straight after paint() and read `shown`, and
  // on the free plan that read used to land a tick too late -- which showed no
  // "Checked ..." line and sent a request on every popup open.
  shown = data || null;
  if (data && data.reported === false) CUBS.read(function (f){ render(data, f); });
  else render(data);
}

function loadShow(){
  chrome.storage.local.get([SHOW_KEY], function(o){
    var show = Object.assign({}, DEFAULT_SHOW, o[SHOW_KEY] || {});
    document.querySelectorAll("[data-show]").forEach(function(cb){
      cb.checked = show[cb.getAttribute("data-show")] !== false;
    });
  });
}
function wireShow(){
  document.querySelectorAll("[data-show]").forEach(function(cb){
    cb.addEventListener("change", function(){
      chrome.storage.local.get([SHOW_KEY], function(o){
        var show = Object.assign({}, DEFAULT_SHOW, o[SHOW_KEY] || {});
        show[cb.getAttribute("data-show")] = cb.checked;
        chrome.storage.local.set({ [SHOW_KEY]: show });
      });
    });
  });
}

document.addEventListener("DOMContentLoaded", function(){
  chrome.storage.local.get([LAST_KEY], function(o){
    if (o[LAST_KEY]){ paint(o[LAST_KEY]); showAge(); }   // paint the cache first, then decide
    refresh(false);
  });
  loadShow(); wireShow();
  statusTimer = setInterval(showAge, 15000);
  // A tab or the alarm refreshing while the popup is open should show up here too.
  chrome.storage.onChanged.addListener(function(changes, area){
    if (area !== "local") return;
    if (changes[LAST_KEY] && changes[LAST_KEY].newValue){ paint(changes[LAST_KEY].newValue); showAge(); }
    // A tab counted a send while the popup was open.
    if (changes[FREE_KEY] && shown && shown.reported === false) render(shown, CUBS.summarize(changes[FREE_KEY].newValue));
  });
  document.getElementById("refresh").addEventListener("click", function(){ refresh(true); });
  document.getElementById("settings").addEventListener("click", function(){
    chrome.runtime.openOptionsPage();
  });
});
