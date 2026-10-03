// charts.js: the few charts the extension draws, as plain SVG. No library: an
// extension may not load remote code, and these need only a few hundred lines.
//
//   sparkline(points)                 tiny trend line (popup rows)
//   lineChart(host, series, opts)     multi-series line, crosshair readout, legend
//   heatmap(host, grid, opts)         weekday x hour cells on one-hue steps
//   bars(host, items, opts)           one series of columns
//
// Each chart that takes a host also builds its table twin (`.table`), so every
// value is reachable without hovering. Colours are CSS custom properties
// (--cubc-s1..8, --cubc-h1..6, ink and grid tokens) set by the page, so light
// and dark are the page's business. Labels and series names are set with
// textContent: limit names come from the API.

var CUBC = (function () {
  var NS = "http://www.w3.org/2000/svg";

  function svg(tag, attrs){
    var n = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function(k){ n.setAttribute(k, attrs[k]); });
    return n;
  }
  function el(tag, cls, text){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(n){ while (n.firstChild) n.removeChild(n.firstChild); }

  // Clean axis steps: 0, 5, 10... or 0, 25, 50... -- at most `count` of them.
  function niceTicks(max, count){
    if (!(max > 0)) return [0, 1];
    var raw = max / (count || 4);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 2.5, 5, 10].map(function(m){ return m * mag; }).find(function(s){ return s >= raw; }) || raw;
    var out = [];
    for (var v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
    if (out[out.length - 1] < max) out.push(Math.round((out[out.length - 1] + step) * 1e6) / 1e6);
    return out;
  }

  // ---- Sparkline ------------------------------------------------------------
  // The last day of one limit, on the same 0-100 scale as its bar, so a full
  // sparkline means a full limit. Muted ink, with the current reading as a dot.
  function sparkline(points, opts){
    opts = opts || {};
    var w = opts.width || 56, h = opts.height || 16, pad = 2.5;
    var s = svg("svg", { "class": "cubc-spark", width: w, height: h, viewBox: "0 0 " + w + " " + h, "aria-hidden": "true" });
    if (!points || points.length < 2) return s;
    var t0 = opts.from != null ? opts.from : points[0].t, t1 = opts.to != null ? opts.to : points[points.length - 1].t;
    var span = Math.max(1, t1 - t0), max = opts.max || 100;
    function X(t){ return pad + (w - 2 * pad) * (t - t0) / span; }
    function Y(v){ return h - pad - (h - 2 * pad) * Math.max(0, Math.min(max, v)) / max; }
    var d = points.map(function(p, i){ return (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1); }).join("");
    s.appendChild(svg("path", { d: d, "class": "cubc-spark-line" }));
    var last = points[points.length - 1];
    s.appendChild(svg("circle", { cx: X(last.t).toFixed(1), cy: Y(last.v).toFixed(1), r: 2, "class": "cubc-spark-dot" }));
    return s;
  }

  // ---- Shared bits ----------------------------------------------------------

  function tooltip(host){
    var tip = el("div", "cubc-tip");
    tip.setAttribute("role", "status");
    tip.hidden = true;
    host.appendChild(tip);
    return tip;
  }

  function placeTip(tip, host, x, y){
    tip.hidden = false;
    var hw = host.clientWidth, tw = tip.offsetWidth;
    var left = x + 14;
    if (left + tw > hw - 4) left = Math.max(4, x - tw - 14);
    tip.style.left = left + "px";
    tip.style.top = Math.max(0, y - tip.offsetHeight / 2) + "px";
  }

  function row(tip, color, value, label){
    var r = el("div", "cubc-tip-row");
    if (color){ var k = el("span", "cubc-key"); k.style.background = color; r.appendChild(k); }
    r.appendChild(el("b", null, value));
    if (label) r.appendChild(el("span", "cubc-tip-label", label));
    tip.appendChild(r);
  }

  // The latest point at or before t, within maxGap of it.
  function valueAt(points, t, maxGap){
    var lo = 0, hi = points.length - 1, best = -1;
    while (lo <= hi){
      var mid = (lo + hi) >> 1;
      if (points[mid].t <= t){ best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0 || t - points[best].t > maxGap) return null;
    return points[best];
  }

  // Keep the shape at screen resolution: per bucket of time, the lowest and the
  // highest point in time order, so peaks and resets both survive the thinning.
  function thin(points, buckets){
    if (points.length <= buckets * 2) return points;
    var t0 = points[0].t, span = Math.max(1, points[points.length - 1].t - t0);
    var out = [], cur = -1, lo = null, hi = null;
    function flush(){
      if (!lo) return;
      if (lo === hi) out.push(lo);
      else if (lo.t < hi.t){ out.push(lo); out.push(hi); }
      else { out.push(hi); out.push(lo); }
    }
    points.forEach(function(p){
      var b = Math.min(buckets - 1, Math.floor((p.t - t0) / span * buckets));
      if (b !== cur){ flush(); cur = b; lo = hi = p; }
      else { if (p.v < lo.v) lo = p; if (p.v > hi.v) hi = p; }
    });
    flush();
    return out;
  }

  function timeTicks(from, to){
    var span = to - from, out = [], HOUR = 3600e3, DAY = 24 * HOUR;
    var d = new Date(from);
    if (span <= 36 * HOUR){
      var stepH = span <= 12 * HOUR ? 2 : span <= 24 * HOUR ? 4 : 6;
      d.setMinutes(0, 0, 0);
      while (d.getHours() % stepH) d.setHours(d.getHours() + 1);
      if (d.getTime() < from) d.setHours(d.getHours() + stepH);
      for (; d.getTime() <= to; d.setHours(d.getHours() + stepH)){
        out.push({ t: d.getTime(), label: d.toLocaleTimeString([], { hour: "numeric" }) });
      }
    } else {
      var stepD = span <= 9 * DAY ? 1 : span <= 20 * DAY ? 3 : 7;
      d.setHours(0, 0, 0, 0);
      if (d.getTime() < from) d.setDate(d.getDate() + 1);
      for (; d.getTime() <= to; d.setDate(d.getDate() + stepD)){
        out.push({ t: d.getTime(), label: stepD === 1 ? d.toLocaleDateString([], { weekday: "short" })
                                                       : d.toLocaleDateString([], { month: "short", day: "numeric" }) });
      }
    }
    return out;
  }

  function fmtTime(t, span){
    var d = new Date(t);
    var opts = span > 36 * 3600e3 ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
                                  : { weekday: "short", hour: "numeric", minute: "2-digit" };
    return d.toLocaleString([], opts);
  }

  // ---- Line chart -----------------------------------------------------------
  // series: [{ id, label, color, points:[{t,v}], markers:[{t,v,label}] }]
  // opts: { from, to, yMax, yFormat, height, gapMs, title }
  // Returns { node, table } -- the chart, and its table twin to swap in.
  function lineChart(host, series, opts){
    opts = opts || {};
    clear(host);
    var from = opts.from, to = opts.to, gapMs = opts.gapMs || 3 * 3600e3;
    var yFmt = opts.yFormat || function(v){ return Math.round(v) + "%"; };
    var hidden = {};

    var wrap = el("div", "cubc-line");
    var legend = null;
    if (series.length >= 2){
      legend = el("div", "cubc-legend");
      series.forEach(function(s){
        var b = el("button", "cubc-legend-item");
        b.type = "button";
        b.setAttribute("aria-pressed", "true");
        var k = el("span", "cubc-key cubc-key-line"); k.style.background = s.color;
        b.appendChild(k);
        b.appendChild(el("span", null, s.label));
        b.title = "Show or hide " + s.label;
        b.addEventListener("click", function(){
          hidden[s.id] = !hidden[s.id];
          b.setAttribute("aria-pressed", String(!hidden[s.id]));
          draw();
        });
        legend.appendChild(b);
      });
      wrap.appendChild(legend);
    }
    var plotHost = el("div", "cubc-plot");
    plotHost.tabIndex = 0;
    plotHost.setAttribute("role", "img");
    plotHost.setAttribute("aria-label", (opts.title || "Chart") + ". Use the left and right arrow keys to read values, or switch to the table.");
    wrap.appendChild(plotHost);
    host.appendChild(wrap);

    var H = opts.height || 220, PAD = { l: 40, r: 10, t: 10, b: 24 };
    var yMax = opts.yMax || 100;
    var ticks = opts.yTicks || niceTicks(yMax, 4);
    yMax = ticks[ticks.length - 1];
    var tip, times = [], cursor = -1, geom = null;

    function draw(){
      clear(plotHost);
      var W = Math.max(280, plotHost.clientWidth || host.clientWidth || 600);
      var pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
      function X(t){ return PAD.l + pw * (t - from) / Math.max(1, to - from); }
      function Y(v){ return PAD.t + ph - ph * Math.max(0, Math.min(yMax, v)) / yMax; }
      geom = { X: X, Y: Y, W: W, pw: pw, ph: ph };
      var s = svg("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, "class": "cubc-svg" });

      ticks.forEach(function(v){
        var y = Y(v).toFixed(1);
        s.appendChild(svg("line", { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, "class": v === 0 ? "cubc-axis" : "cubc-grid" }));
        var lab = svg("text", { x: PAD.l - 6, y: y, "class": "cubc-tick", "text-anchor": "end", "dominant-baseline": "middle" });
        lab.textContent = yFmt(v);
        s.appendChild(lab);
      });
      timeTicks(from, to).forEach(function(tk){
        var x = X(tk.t);
        if (x < PAD.l + 12 || x > W - PAD.r - 12) return;
        var lab = svg("text", { x: x.toFixed(1), y: H - 6, "class": "cubc-tick", "text-anchor": "middle" });
        lab.textContent = tk.label;
        s.appendChild(lab);
      });

      var all = {};
      series.forEach(function(se){
        if (hidden[se.id]) return;
        var pts = thin(se.points, Math.max(50, Math.round(pw)));
        var d = "", prev = null;
        pts.forEach(function(p){
          d += (prev && p.t - prev.t <= gapMs ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1);
          prev = p;
          all[p.t] = true;
        });
        // Colours go on style, not the attributes: presentation attributes do
        // not resolve var(), and the series colours are custom properties.
        if (d){ var path = svg("path", { d: d, "class": "cubc-path" }); path.style.stroke = se.color; s.appendChild(path); }
        (se.markers || []).forEach(function(m){
          var dot = svg("circle", { cx: X(m.t).toFixed(1), cy: Y(m.v).toFixed(1), r: 4, "class": "cubc-marker" });
          dot.style.fill = se.color;
          s.appendChild(dot);
        });
      });
      times = Object.keys(all).map(Number).sort(function(a, b){ return a - b; });

      var cross = svg("line", { x1: 0, x2: 0, y1: PAD.t, y2: PAD.t + ph, "class": "cubc-cross", visibility: "hidden" });
      s.appendChild(cross);
      var hit = svg("rect", { x: PAD.l, y: PAD.t, width: pw, height: ph, "class": "cubc-hit" });
      s.appendChild(hit);
      plotHost.appendChild(s);
      tip = tooltip(plotHost);

      function show(t){
        if (!times.length) return;
        // Snap to the nearest real reading.
        var i = 0, best = Infinity;
        for (var j = 0; j < times.length; j++){ var dd = Math.abs(times[j] - t); if (dd < best){ best = dd; i = j; } }
        cursor = i;
        var at = times[i], x = X(at);
        cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
        clear(tip);
        tip.appendChild(el("div", "cubc-tip-head", fmtTime(at, to - from)));
        var any = false;
        series.forEach(function(se){
          if (hidden[se.id]) return;
          var p = valueAt(se.points, at, gapMs);
          if (!p) return;
          any = true;
          row(tip, se.color, yFmt(p.v), series.length > 1 ? se.label : "");
        });
        if (!any) row(tip, null, "No reading", "");
        placeTip(tip, plotHost, x, PAD.t + ph / 2);
      }
      function hide(){ cross.setAttribute("visibility", "hidden"); tip.hidden = true; }
      hit.addEventListener("pointermove", function(e){
        var r = s.getBoundingClientRect();
        var x = e.clientX - r.left;
        show(from + (x - PAD.l) / pw * (to - from));
      });
      hit.addEventListener("pointerleave", hide);
      plotHost.onfocus = function(){ if (times.length) show(times[cursor >= 0 ? cursor : times.length - 1]); };
      plotHost.onblur = hide;
      plotHost.onkeydown = function(e){
        if (!times.length) return;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight"){
          e.preventDefault();
          cursor = Math.max(0, Math.min(times.length - 1, (cursor < 0 ? times.length - 1 : cursor) + (e.key === "ArrowLeft" ? -1 : 1)));
          show(times[cursor]);
        }
      };
    }
    draw();

    // The table twin: one row per reading (thinned to a readable count), one
    // column per series.
    var table = el("table", "cubc-table");
    var thead = el("thead"), hr = el("tr");
    hr.appendChild(el("th", null, "Time"));
    series.forEach(function(se){ hr.appendChild(el("th", null, se.label)); });
    thead.appendChild(hr); table.appendChild(thead);
    var tbody = el("tbody");
    var stamps = {};
    series.forEach(function(se){ thin(se.points, 100).forEach(function(p){ stamps[p.t] = true; }); });
    Object.keys(stamps).map(Number).sort(function(a, b){ return b - a; }).slice(0, 200).forEach(function(t){
      var tr = el("tr");
      tr.appendChild(el("td", null, fmtTime(t, to - from)));
      series.forEach(function(se){
        var p = valueAt(se.points, t, gapMs);
        tr.appendChild(el("td", null, p ? yFmt(p.v) : "–"));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    return { node: wrap, table: table, redraw: draw };
  }

  // ---- Heatmap --------------------------------------------------------------
  // grid[row][col] of magnitudes, coloured on six one-hue steps (light to dark,
  // flipped by the page in dark mode), zero left as an empty cell.
  // opts: { rows:[labels], cols:[labels], format(v), cellTip(r,c,v) }
  function heatmap(host, grid, opts){
    clear(host);
    var max = 0;
    grid.forEach(function(r){ r.forEach(function(v){ if (v > max) max = v; }); });
    var wrap = el("div", "cubc-heat");
    var W = Math.max(300, host.clientWidth || 600), LAB = 38, GAP = 2;
    var cols = grid[0].length, cell = Math.max(8, Math.floor((W - LAB) / cols) - GAP), CH = 18;
    var H = grid.length * (CH + GAP) + 20;
    var s = svg("svg", { width: LAB + cols * (cell + GAP), height: H, "class": "cubc-svg" });
    var tipHost = el("div", "cubc-plot");
    function bin(v){ return v <= 0 || !max ? 0 : Math.min(6, 1 + Math.floor((v / max) * 5.999)); }
    var tip;
    grid.forEach(function(r, ri){
      var lab = svg("text", { x: LAB - 6, y: ri * (CH + GAP) + CH / 2, "class": "cubc-tick", "text-anchor": "end", "dominant-baseline": "middle" });
      lab.textContent = opts.rows[ri];
      s.appendChild(lab);
      r.forEach(function(v, ci){
        var x = LAB + ci * (cell + GAP), y = ri * (CH + GAP);
        var c = svg("rect", { x: x, y: y, width: cell, height: CH, rx: 3, "class": "cubc-cell cubc-h" + bin(v), tabindex: "-1" });
        c.addEventListener("pointerenter", function(){
          clear(tip);
          tip.appendChild(el("div", "cubc-tip-head", opts.rows[ri] + " " + opts.cols[ci]));
          row(tip, null, opts.format(v), opts.unit || "");
          placeTip(tip, tipHost, x + cell, y + CH / 2);
        });
        c.addEventListener("pointerleave", function(){ tip.hidden = true; });
        s.appendChild(c);
      });
    });
    for (var ci = 0; ci < cols; ci += 3){
      var t = svg("text", { x: LAB + ci * (cell + GAP) + cell / 2, y: H - 4, "class": "cubc-tick", "text-anchor": "middle" });
      t.textContent = opts.cols[ci];
      s.appendChild(t);
    }
    tipHost.appendChild(s);
    tip = tooltip(tipHost);
    wrap.appendChild(tipHost);

    // The scale, so the steps mean something.
    var scale = el("div", "cubc-scale");
    scale.appendChild(el("span", null, "Less"));
    for (var b = 0; b <= 6; b++){ var sw = el("span", "cubc-swatch cubc-h" + b); scale.appendChild(sw); }
    scale.appendChild(el("span", null, "More"));
    wrap.appendChild(scale);
    host.appendChild(wrap);

    var table = el("table", "cubc-table cubc-table-wide");
    var hr = el("tr");
    hr.appendChild(el("th", null, ""));
    opts.cols.forEach(function(c){ hr.appendChild(el("th", null, c)); });
    var thead = el("thead"); thead.appendChild(hr); table.appendChild(thead);
    var tbody = el("tbody");
    grid.forEach(function(r, ri){
      var tr = el("tr");
      tr.appendChild(el("th", null, opts.rows[ri]));
      r.forEach(function(v){ tr.appendChild(el("td", null, v ? opts.format(v) : "")); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return { node: wrap, table: table };
  }

  // ---- Columns --------------------------------------------------------------
  // items: [{ label, v, tip }]. One series, so one colour for every column;
  // only the tallest is labelled, the axis and the tooltip carry the rest.
  function bars(host, items, opts){
    opts = opts || {};
    clear(host);
    var fmt = opts.format || String;
    var W = Math.max(280, host.clientWidth || 600), H = opts.height || 160, PAD = { l: 40, r: 8, t: 16, b: 22 };
    var pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
    var max = Math.max.apply(null, items.map(function(i){ return i.v; }).concat(0));
    var ticks = niceTicks(max || 1, 3), top = ticks[ticks.length - 1];
    var slot = pw / Math.max(1, items.length), bw = Math.min(24, Math.max(3, slot * 0.6));
    var s = svg("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, "class": "cubc-svg" });
    function Y(v){ return PAD.t + ph - ph * v / top; }
    ticks.forEach(function(v){
      var y = Y(v).toFixed(1);
      s.appendChild(svg("line", { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, "class": v === 0 ? "cubc-axis" : "cubc-grid" }));
      var lab = svg("text", { x: PAD.l - 6, y: y, "class": "cubc-tick", "text-anchor": "end", "dominant-baseline": "middle" });
      lab.textContent = fmt(v);
      s.appendChild(lab);
    });
    var plot = el("div", "cubc-plot");
    var tip;
    var maxIdx = -1;
    items.forEach(function(it, i){ if (it.v > 0 && (maxIdx < 0 || it.v > items[maxIdx].v)) maxIdx = i; });
    var every = Math.ceil(items.length / Math.max(1, Math.floor(pw / 44)));
    items.forEach(function(it, i){
      var cx = PAD.l + slot * i + slot / 2, x = cx - bw / 2;
      if (it.v > 0){
        var y = Y(it.v), h = PAD.t + ph - y, r = Math.min(4, bw / 2, h);
        // Rounded at the data end, square on the baseline.
        var d = "M" + x + " " + (PAD.t + ph) + "V" + (y + r) + "Q" + x + " " + y + " " + (x + r) + " " + y +
                "H" + (x + bw - r) + "Q" + (x + bw) + " " + y + " " + (x + bw) + " " + (y + r) + "V" + (PAD.t + ph) + "Z";
        s.appendChild(svg("path", { d: d, "class": "cubc-bar" }));
        if (i === maxIdx){
          var v = svg("text", { x: cx, y: y - 4, "class": "cubc-tick cubc-val", "text-anchor": "middle" });
          v.textContent = fmt(it.v);
          s.appendChild(v);
        }
      }
      var hit = svg("rect", { x: PAD.l + slot * i, y: PAD.t, width: slot, height: ph, "class": "cubc-hit" });
      hit.addEventListener("pointerenter", function(){
        clear(tip);
        tip.appendChild(el("div", "cubc-tip-head", it.tip || it.label));
        row(tip, null, fmt(it.v), opts.unit || "");
        placeTip(tip, plot, cx, PAD.t + ph / 2);
      });
      hit.addEventListener("pointerleave", function(){ tip.hidden = true; });
      s.appendChild(hit);
      if (i % every === 0){
        var lab = svg("text", { x: cx, y: H - 6, "class": "cubc-tick", "text-anchor": "middle" });
        lab.textContent = it.label;
        s.appendChild(lab);
      }
    });
    plot.appendChild(s);
    tip = tooltip(plot);
    host.appendChild(plot);

    var table = el("table", "cubc-table");
    var thead = el("thead"), hr = el("tr");
    hr.appendChild(el("th", null, opts.labelHead || "Day"));
    hr.appendChild(el("th", null, opts.valueHead || "Value"));
    thead.appendChild(hr); table.appendChild(thead);
    var tbody = el("tbody");
    items.slice().reverse().forEach(function(it){
      var tr = el("tr");
      tr.appendChild(el("td", null, it.tip || it.label));
      tr.appendChild(el("td", null, fmt(it.v)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return { node: plot, table: table };
  }

  return { sparkline: sparkline, lineChart: lineChart, heatmap: heatmap, bars: bars,
           niceTicks: niceTicks, thin: thin, valueAt: valueAt };
})();
