// options.js: the Settings page. Master on/off, toolbar-badge options,
// account switch, and the hotkey. Shares CUB (usage.js) with the popup.
var TOGGLE_KEY = "cub_enabled";
var LAST_KEY = "cub_last";
var BADGE_KEY = "cub_badge";
var MANUAL_KEY = "cub_org_manual";
var DESIGN_KEY = "cub_design";
var SETUP_KEY = "cub_setup";
var DEFAULT_BADGE = { enabled: false, source: "session" };

// ---- Master on/off -------------------------------------------------------
function loadToggle(){
  chrome.storage.local.get([TOGGLE_KEY], function(o){
    document.getElementById("toggle").checked = o[TOGGLE_KEY] !== false;
  });
}

// ---- Design (bar vs inline) ----------------------------------------------
function loadDesign(){
  chrome.storage.local.get([DESIGN_KEY], function(o){
    var d = o[DESIGN_KEY] === "2" ? "2" : "1";
    document.querySelectorAll('input[name="design"]').forEach(function(r){
      r.checked = r.value === d;
    });
  });
}

// ---- Toolbar badge -------------------------------------------------------
function applyBadgeDisabled(enabled){
  document.getElementById("badge-opts").classList.toggle("o-disabled", !enabled);
}
function loadBadge(){
  chrome.storage.local.get([BADGE_KEY], function(o){
    var b = Object.assign({}, DEFAULT_BADGE, o[BADGE_KEY] || {});
    document.getElementById("badge-enabled").checked = b.enabled;
    document.querySelectorAll('input[name="badge-source"]').forEach(function(r){
      r.checked = r.value === b.source;
    });
    applyBadgeDisabled(b.enabled);
  });
}
function saveBadge(patch){
  chrome.storage.local.get([BADGE_KEY], function(o){
    var b = Object.assign({}, DEFAULT_BADGE, o[BADGE_KEY] || {}, patch);
    chrome.storage.local.set({ [BADGE_KEY]: b });
  });
}

// ---- Account -------------------------------------------------------------
function setAcct(name){ document.getElementById("acct").textContent = name || "(unnamed)"; }

function updateAutoVisibility(){
  chrome.storage.local.get([MANUAL_KEY], function(o){
    document.getElementById("auto").hidden = !o[MANUAL_KEY];
  });
}

// Opening Settings does not need a request of its own: the account name lives in
// the numbers a tab or the alarm already fetched. We only go to the network when
// that cache is old, or when the user just changed which account we read.
async function refreshAccount(force){
  updateAutoVisibility();
  if (!force){
    var st = await new Promise(function(r){ chrome.storage.local.get([LAST_KEY], r); });
    var last = st[LAST_KEY];
    // ... or when it is an account Claude reports no usage for, where the name
    // came from the daily check and opening Settings is no reason to run another.
    if (last && last.orgName &&
        (CUB.freeHold(last) || (last.fetchedAt && Date.now() - last.fetchedAt < 60000))){
      setAcct(last.orgName);
      return;
    }
  }
  try {
    var data = await CUB.getUsage();
    chrome.storage.local.set({ [LAST_KEY]: data });
    setAcct(data.orgName);
  } catch (e){ /* keep the cached name we already showed */ }
}

function pctText(w){ return w && w.available ? Math.round(w.pct)+"%" : "–"; }

// What to say under an account name in the picker. An account Claude reports no
// usage for is the free plan, not a broken pick, so it says so rather than
// offering two dashes and letting the user think they chose wrong.
function orgDetail(r){
  if (!r.ok) return "error: " + (r.error || "?");
  var w = r.windows || {};
  if (!(w.session && w.session.available) && !(w.allModels && w.allModels.available) &&
      !(w.opus && w.opus.available)) return "no usage reported (free plan)";
  return "5h " + pctText(w.session) + " · 7d " + pctText(w.allModels);
}

function el(tag, cls, text){
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;   // never innerHTML: see below
  return n;
}

function note(box, text){
  box.textContent = "";
  box.appendChild(el("div", "p-empty", text));
}

// Account names come back from the API, so they are built as text nodes rather
// than concatenated into innerHTML: this page holds the chrome.* APIs, and an
// org named with markup would otherwise run here.
async function showScan(){
  var box = document.getElementById("scan");
  box.hidden = false;
  note(box, "Scanning accounts…");
  try {
    var res = await CUB.scanOrgs();
    box.textContent = "";
    box.appendChild(el("div", "p-scan-hint", "Pick the account with your real usage:"));
    res.rows.forEach(function(r){
      var row = el("div", "p-org");
      var info = el("div", "p-org-info");
      info.appendChild(el("div", "p-org-name", r.name));
      info.appendChild(el("div", "p-org-detail", orgDetail(r)));
      var btn = el("button", "p-btn p-use", "Use");
      btn.addEventListener("click", async function(){
        await CUB.setManualOrg(r.uuid);
        box.hidden = true; refreshAccount(true);   // different account: must re-read
      });
      row.appendChild(info); row.appendChild(btn);
      box.appendChild(row);
    });
  } catch (e){
    note(box, e.code === "AUTH" ? "Log in to claude.ai first" : "Couldn't list accounts");
  }
}

// ---- Hotkey --------------------------------------------------------------
function loadHotkey(){
  try {
    chrome.commands.getAll(function(cmds){
      var c = (cmds || []).find(function(x){ return x.name === "toggle-bar"; });
      document.getElementById("hk").textContent = (c && c.shortcut) ? c.shortcut : "not set";
    });
  } catch (e){ document.getElementById("hk").textContent = "not set"; }
}

document.addEventListener("DOMContentLoaded", function(){
  loadToggle();
  loadDesign();
  loadBadge();
  loadHotkey();

  chrome.storage.local.get([LAST_KEY], function(o){
    if (o[LAST_KEY] && o[LAST_KEY].orgName) setAcct(o[LAST_KEY].orgName);
    refreshAccount();
  });

  document.getElementById("toggle").addEventListener("change", function(e){
    chrome.storage.local.set({ [TOGGLE_KEY]: e.target.checked });
  });

  document.querySelectorAll('input[name="design"]').forEach(function(r){
    r.addEventListener("change", function(){
      if (!r.checked) return;
      // Picking here answers the first-run question too, so someone who found
      // Settings on their own is not asked again in the page afterwards.
      chrome.storage.local.set({
        [DESIGN_KEY]: r.value,
        [SETUP_KEY]: { done: true, at: Date.now() }
      });
    });
  });

  document.getElementById("badge-enabled").addEventListener("change", function(e){
    applyBadgeDisabled(e.target.checked);
    saveBadge({ enabled: e.target.checked });
  });
  document.querySelectorAll('input[name="badge-source"]').forEach(function(r){
    r.addEventListener("change", function(){ if (r.checked) saveBadge({ source: r.value }); });
  });

  // The install-time setup box, on demand. It reads the stored choices back, so
  // re-running it starts from what is set now rather than from blank.
  document.getElementById("setup").addEventListener("click", function(){
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  });

  document.getElementById("switch").addEventListener("click", showScan);
  document.getElementById("auto").addEventListener("click", async function(){
    await CUB.clearOrg();
    document.getElementById("scan").hidden = true;
    refreshAccount(true);
  });

  document.getElementById("hk-edit").addEventListener("click", function(e){
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
});
