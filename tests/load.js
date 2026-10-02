// tests/load.js: loads the extension's classic scripts the way the browser does
// -- plain scripts sharing one global scope -- with an in-memory chrome.*
// standing in for the extension APIs. No dependencies: run the suite with
//
//   node --test tests/
//
// Each test file runs in its own process, so loading the scripts again in a
// later file starts from a clean global scope.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "claude-extension");

function clone(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// chrome.storage.local with real Chrome's quirks that the code relies on:
// callbacks run asynchronously, values are copied on the way in and out, and
// every write fans out to onChanged listeners as {key: {oldValue, newValue}}.
function makeStorage(){
  const data = {};
  const listeners = [];
  function names(keys){
    if (keys == null) return Object.keys(data);
    if (typeof keys === "string") return [keys];
    if (Array.isArray(keys)) return keys;
    return Object.keys(keys);
  }
  function later(fn){ return new Promise(function(resolve){ setImmediate(function(){ resolve(fn()); }); }); }
  function done(p, cb){ if (cb){ p.then(cb); return undefined; } return p; }
  const local = {
    get(keys, cb){
      return done(later(function(){
        const out = {};
        const defaults = keys && typeof keys === "object" && !Array.isArray(keys) ? keys : null;
        names(keys).forEach(function(k){
          if (k in data) out[k] = clone(data[k]);
          else if (defaults) out[k] = clone(defaults[k]);
        });
        return out;
      }), cb);
    },
    set(obj, cb){
      const changes = {};
      Object.keys(obj).forEach(function(k){
        changes[k] = { oldValue: clone(data[k]), newValue: clone(obj[k]) };
        data[k] = clone(obj[k]);
      });
      return done(later(function(){ listeners.forEach(function(fn){ fn(changes, "local"); }); }), cb);
    },
    remove(keys, cb){
      const changes = {};
      names(keys).forEach(function(k){
        if (k in data){ changes[k] = { oldValue: clone(data[k]) }; delete data[k]; }
      });
      return done(later(function(){
        if (Object.keys(changes).length) listeners.forEach(function(fn){ fn(changes, "local"); });
      }), cb);
    },
    getBytesInUse(keys, cb){
      return done(later(function(){
        let n = 0;
        names(keys).forEach(function(k){ if (k in data) n += k.length + JSON.stringify(data[k]).length; });
        return n;
      }), cb);
    }
  };
  return { local: local, onChanged: { addListener(fn){ listeners.push(fn); } }, _data: data };
}

function event(){
  const fns = [];
  return { addListener(fn){ fns.push(fn); }, _fire(){ const a = arguments; fns.forEach(function(fn){ fn.apply(null, a); }); }, _fns: fns };
}

function makeChrome(){
  const alarms = {};
  const created = [];
  const chrome = {
    storage: makeStorage(),
    runtime: {
      id: "test", lastError: undefined,
      getURL(p){ return "chrome-extension://test/" + p; },
      onMessage: event(), onInstalled: event(), onStartup: event(),
      openOptionsPage(){}
    },
    alarms: {
      _alarms: alarms,
      create(name, info){ alarms[name] = Object.assign({ name: name }, info); },
      get(name, cb){ setImmediate(function(){ cb(alarms[name]); }); },
      getAll(cb){ setImmediate(function(){ cb(Object.values(alarms)); }); },
      clear(name, cb){ const had = name in alarms; delete alarms[name]; if (cb) setImmediate(function(){ cb(had); }); },
      onAlarm: event()
    },
    action: {
      _state: { text: "", color: null, title: "" },
      setBadgeText(o){ this._state.text = o.text; },
      setBadgeBackgroundColor(o){ this._state.color = o.color; },
      setBadgeTextColor(){},
      setTitle(o){ this._state.title = o.title; }
    },
    tabs: {
      _created: created,
      query(q, cb){ setImmediate(function(){ cb([]); }); },
      create(o){ created.push(o); },
      sendMessage(id, msg, cb){ chrome.runtime.lastError = { message: "no receiver" }; cb(); chrome.runtime.lastError = undefined; }
    },
    commands: { onCommand: event(), getAll(cb){ cb([]); } },
    contextMenus: { _items: [], create(o){ this._items.push(o); }, removeAll(cb){ this._items = []; if (cb) cb(); }, onClicked: event() },
    permissions: {
      _granted: false,
      contains(p, cb){ const g = this._granted; setImmediate(function(){ cb(g); }); },
      request(p, cb){ this._granted = true; setImmediate(function(){ cb(true); }); },
      remove(p, cb){ this._granted = false; if (cb) setImmediate(function(){ cb(true); }); },
      onAdded: event(), onRemoved: event()
    }
  };
  return chrome;
}

// Run extension scripts, in order, in this process's global scope (each test
// file is its own process). Returns the fresh chrome stub so tests can look at
// what the scripts stored.
function load(files, opts){
  opts = opts || {};
  globalThis.chrome = makeChrome();
  globalThis.importScripts = function(){
    Array.prototype.forEach.call(arguments, function(f){ run(f); });
  };
  if (opts.fetch) globalThis.fetch = opts.fetch;
  function run(f){
    vm.runInThisContext(fs.readFileSync(path.join(EXT, f), "utf8"), { filename: f });
  }
  files.forEach(run);
  return globalThis.chrome;
}

// Wait for every queued setImmediate callback (storage writes, listeners).
function settle(rounds){
  let p = Promise.resolve();
  for (let i = 0; i < (rounds || 6); i++) p = p.then(function(){ return new Promise(function(r){ setImmediate(r); }); });
  return p;
}

// A fetch that answers from a table of URL -> body (or a function of the URL).
function fakeFetch(routes){
  return async function(url){
    const key = Object.keys(routes).find(function(k){ return url.indexOf(k) !== -1; });
    if (!key) return { ok: false, status: 404, json: async function(){ return {}; } };
    let body = routes[key];
    if (typeof body === "function") body = body(url);
    if (body && body.__status) return { ok: false, status: body.__status, json: async function(){ return {}; } };
    return { ok: true, status: 200, json: async function(){ return clone(body); } };
  };
}

module.exports = { load, settle, fakeFetch, clone, EXT };
