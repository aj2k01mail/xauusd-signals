// XAUUSD signal server v2.4 (chart with volume profile and pivot levels). Node 18+, no dependencies.
const http = require('http');

const KEY = process.env.TWELVEDATA_KEY;
const PORT = process.env.PORT || 3000;
const SYMBOL = process.env.SYMBOL || 'XAU/USD';
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT;
const SESSION = (process.env.SESSION_UTC || '7-20').split('-').map(Number);
// Example: NEWS_BLOCKS="2026-11-06 13:00-14:30,2026-11-11 13:00-14:30" (UTC)
const NEWS = (process.env.NEWS_BLOCKS || '').split(',').map(s => s.trim()).filter(Boolean);
const BAR = 15 * 60000;
const PIVOT_LEN = Number(process.env.PIVOT_LEN || 10);        // chart pivot length
const PIVOT_FILTER = Number(process.env.PIVOT_FILTER || 20);  // chart pivot min volume percent
const VP_PERIOD = Number(process.env.VP_PERIOD || 200);       // volume profile candles
const VP_BINS = Number(process.env.VP_BINS || 50);            // volume profile resolution

// Default settings. Backtest and sweep links can override them.
const DEF = {
  maxDist: Number(process.env.MAX_DIST || 30),      // max price distance for SL and TP2
  rr1: Number(process.env.RR1 || 1.5),              // TP1 as multiple of risk
  rr2: Number(process.env.RR2 || 2),                // TP2 as multiple of risk
  spread: Number(process.env.SPREAD || 0.3),        // spread plus slippage in price
  minAtr: Number(process.env.MIN_ATR || 0.8),       // skip dead markets
  h1: Number(process.env.USE_H1 || 0),              // 1 = H1 trend must agree, 0 = ignore H1
  zone: Number(process.env.ZONE || 1),              // level retest zone in ATR
  slbuf: Number(process.env.SL_BUF || 0.3),         // stop buffer in ATR
  maxAtr: Number(process.env.MAX_ATR_MULT || 3),    // stop cannot exceed this many ATR
  maxPerDay: Number(process.env.MAX_PER_DAY || 3),  // max signals per UTC day
  cooldown: Number(process.env.COOLDOWN || 4),      // candles to wait after a signal
  friCutoff: Number(process.env.FRI_CUTOFF_UTC || 18),
  vpf: Number(process.env.VP_FILTER || 0)           // min volume percent at the level, 0 = off
};

if (!KEY) { console.error('Set TWELVEDATA_KEY'); process.exit(1); }

// ---------- indicators ----------
const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; };

function atr(b, n) {
  const tr = [];
  for (let i = 1; i < b.length; i++) {
    tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)));
  }
  let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (let j = n; j < tr.length; j++) a = (a * (n - 1) + tr[j]) / n;
  return a;
}

function pivots(b, k, L) {
  let ph = null, pl = null;
  for (let p = k - L; p >= L; p--) {
    let okH = ph === null, okL = pl === null;
    for (let i = p - L; i <= p + L; i++) {
      if (i === p) continue;
      if (okH && (i < p ? b[i].h > b[p].h : b[i].h >= b[p].h)) okH = false;
      if (okL && (i < p ? b[i].l < b[p].l : b[i].l <= b[p].l)) okL = false;
    }
    if (ph === null && okH) ph = b[p].h;
    if (pl === null && okL) pl = b[p].l;
    if (ph !== null && pl !== null) break;
  }
  return { ph, pl };
}

// All confirmed swing points (used by the chart)
function allPivots(b, L) {
  const out = [];
  for (let p = L; p < b.length - L; p++) {
    let okH = true, okL = true;
    for (let i = p - L; i <= p + L; i++) {
      if (i === p) continue;
      if (i < p ? b[i].h > b[p].h : b[i].h >= b[p].h) okH = false;
      if (i < p ? b[i].l < b[p].l : b[i].l <= b[p].l) okL = false;
    }
    if (okH) out.push({ idx: p, val: b[p].h, high: true });
    if (okL) out.push({ idx: p, val: b[p].l, high: false });
  }
  return out;
}

function trendOf(arr, fast, slow) {
  const c = arr.map(x => x.c), sl = Math.min(slow, c.length - 1);
  const ef = ema(c, fast), es = ema(c, sl), last = c[c.length - 1];
  return ef > es && last > ef ? 'BUY' : ef < es && last < ef ? 'SELL' : 'NONE';
}

// Volume profile (same idea as ChartPrime). Uses API volume if present, else counts candles.
function profile(arr, period, nBins) {
  const w = arr.slice(-period);
  let H = -Infinity, L = Infinity;
  w.forEach(b => { if (b.h > H) H = b.h; if (b.l < L) L = b.l; });
  let size = (H - L) / nBins;
  if (!(size > 0)) size = 0.01;
  const hasVol = w.some(b => b.vol > 0);
  const bins = new Array(nBins).fill(0);
  let delta = 0;
  w.forEach(b => {
    const v = hasVol ? b.vol : 1;
    delta += b.c > b.o ? v : -v;
    for (let i = 0; i < nBins; i++) {
      const lo = L + size * i, hi = lo + size;
      if (b.c >= lo - size && b.c < hi + size) bins[i] += v;
    }
  });
  let max = 0, mi = 0;
  bins.forEach((v, i) => { if (v > max) { max = v; mi = i; } });
  return { low: L, high: H, size, bins, max, poc: L + size * (mi + 0.5), delta, hasVol };
}

function volPct(pr, price) {
  let best = 0;
  if (!(pr.max > 0)) return 0;
  for (let i = 0; i < pr.bins.length; i++) {
    const mid = pr.low + pr.size * (i + 0.5);
    if (Math.abs(mid - price) <= pr.size) best = Math.max(best, pr.bins[i] / pr.max * 100);
  }
  return best;
}

// ---------- data ----------
async function candles(interval, size, ms) {
  const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(SYMBOL) +
    '&interval=' + interval + '&outputsize=' + size + '&timezone=UTC&apikey=' + KEY;
  const r = await fetch(url);
  const j = await r.json();
  if (j.status === 'error' || !j.values) throw new Error(j.message || 'No data from API');
  const now = Date.now();
  return j.values.reverse()
    .map(v => ({
      t: Date.parse(v.datetime.replace(' ', 'T') + 'Z'),
      o: +v.open, h: +v.high, l: +v.low, c: +v.close,
      vol: v.volume !== undefined && isFinite(+v.volume) ? +v.volume : 0
    }))
    .filter(b => b.t + ms <= now); // closed candles only
}

// ---------- strategy (pure function, also used by backtest) ----------
function analyze(B, H4, H1, nowMs, C) {
  const k = B.length - 1, last = B[k], prev = B[k - 1];
  const a = atr(B, 14), zone = a * C.zone, tick = 0.01;
  const dir = trendOf(H4, 50, 200);
  const h1ok = dir !== 'NONE' && (C.h1 ? trendOf(H1, 21, 50) === dir : true);
  const pv = pivots(B, k, 5);

  const body = Math.abs(last.c - last.o);
  const uw = last.h - Math.max(last.o, last.c);
  const lw = Math.min(last.o, last.c) - last.l;
  const bullC = (last.c > last.o && prev.c < prev.o && last.c >= prev.o && last.o <= prev.c) ||
                (lw >= 2 * Math.max(body, tick) && lw >= 2 * uw);
  const bearC = (last.c < last.o && prev.c > prev.o && last.c <= prev.o && last.o >= prev.c) ||
                (uw >= 2 * Math.max(body, tick) && uw >= 2 * lw);

  const sigT = last.t + BAR, d = new Date(sigT), hr = d.getUTCHours(), day = d.getUTCDay();
  const weekdayOk = day >= 1 && day <= 5;
  const fridayOk = !(day === 5 && hr >= C.friCutoff);
  const sessOk = weekdayOk && fridayOk && hr >= SESSION[0] && hr < SESSION[1];
  const newsOk = !NEWS.some(s => {
    const [dd, r] = s.split(' '); const [x, y] = r.split('-');
    return sigT >= Date.parse(dd + 'T' + x + ':00Z') && sigT <= Date.parse(dd + 'T' + y + ':00Z');
  });
  const fresh = nowMs - last.t < 45 * 60000;
  const atrOk = a >= C.minAtr;

  const checks = [];
  checks.push({ name: 'Data fresh', pass: fresh, note: fresh ? 'Live candles' : 'Market closed or stale data' });
  checks.push({ name: 'Trend (H4)', pass: dir !== 'NONE', note: dir === 'BUY' ? 'Uptrend' : dir === 'SELL' ? 'Downtrend' : 'Range' });
  checks.push({ name: 'Trend (H1)', pass: h1ok, note: !C.h1 ? 'Not required' : h1ok ? 'Agrees with H4' : 'Does not agree' });
  checks.push({ name: 'Volatility', pass: atrOk, note: 'ATR ' + a.toFixed(2) + ' (min ' + C.minAtr + ')' });

  let lvl = false, cnd = false, sl = 0, risk = 0, rOk = false, maxRisk = 0;
  const minRisk = C.spread * 5;
  if (dir === 'BUY') {
    lvl = pv.pl !== null && last.l <= pv.pl + zone && last.l >= pv.pl - zone && last.c > pv.pl;
    cnd = bullC;
    sl = Math.min(last.l, pv.pl === null ? last.l : pv.pl) - a * C.slbuf;
    risk = last.c - sl;
  } else if (dir === 'SELL') {
    lvl = pv.ph !== null && last.h >= pv.ph - zone && last.h <= pv.ph + zone && last.c < pv.ph;
    cnd = bearC;
    sl = Math.max(last.h, pv.ph === null ? last.h : pv.ph) + a * C.slbuf;
    risk = sl - last.c;
  }

  // Optional: the swing level must sit on a high-volume zone of the volume profile
  let vpOk = true, vpNote = '';
  if (C.vpf > 0 && dir !== 'NONE') {
    const lv = dir === 'BUY' ? pv.pl : pv.ph;
    const vp = profile(B, B.length, VP_BINS);
    const pct = lv === null ? 0 : volPct(vp, lv);
    vpOk = pct >= C.vpf;
    vpNote = 'Level volume ' + Math.round(pct) + '% (min ' + C.vpf + '%)';
  }

  if (dir !== 'NONE') {
    maxRisk = Math.min(a * C.maxAtr, C.maxDist / C.rr2);
    rOk = risk >= minRisk && risk <= maxRisk;
    checks.push({ name: 'Level retest', pass: lvl, note: dir === 'BUY' ? 'Swing low ' + pv.pl : 'Swing high ' + pv.ph });
    if (C.vpf > 0) checks.push({ name: 'Volume level', pass: vpOk, note: vpNote });
    checks.push({ name: 'Candle', pass: cnd, note: 'Pin bar or engulfing' });
    checks.push({ name: 'Risk size', pass: rOk, note: 'Stop ' + risk.toFixed(2) + ' (min ' + minRisk.toFixed(2) + ', max ' + maxRisk.toFixed(2) + ')' });
  }
  checks.push({ name: 'Session', pass: sessOk, note: !weekdayOk ? 'Weekend, market closed' : !fridayOk ? 'Friday cutoff' : 'UTC ' + SESSION[0] + ':00 to ' + SESSION[1] + ':00' });
  checks.push({ name: 'News', pass: newsOk, note: newsOk ? 'No blocked window' : 'Inside news window' });

  const ok = fresh && dir !== 'NONE' && h1ok && atrOk && lvl && vpOk && cnd && rOk && sessOk && newsOk;
  const e = last.c, s = dir === 'BUY' ? 1 : -1;
  return {
    signal: ok ? dir : 'NO TRADE',
    candleTime: last.t,
    candle: new Date(last.t).toISOString(),
    price: e,
    entry: ok ? e : null,
    sl: ok ? sl : null,
    tp1: ok ? e + s * risk * C.rr1 : null,
    tp2: ok ? e + s * risk * C.rr2 : null,
    riskVal: dir !== 'NONE' ? risk : null,
    maxRisk: maxRisk,
    minRisk: minRisk,
    atrVal: a,
    checks,
    updated: new Date().toISOString()
  };
}

// ---------- trade simulation (live tracking and backtest) ----------
// Plan: close half at TP1, move stop to entry, rest runs to TP2.
function evalTrade(tr, cd, maxBars, C) {
  const s = tr.dir === 'BUY' ? 1 : -1;
  const risk = Math.abs(tr.entry - tr.sl);
  const cost = C.spread / risk;
  const full = 0.5 * C.rr1 + 0.5 * C.rr2;
  const n = Math.min(cd.length, maxBars);
  let stage = 0;
  for (let i = 0; i < n; i++) {
    const b = cd[i];
    const hitSl = s === 1 ? b.l <= tr.sl : b.h >= tr.sl;
    const hit1 = s === 1 ? b.h >= tr.tp1 : b.l <= tr.tp1;
    const hit2 = s === 1 ? b.h >= tr.tp2 : b.l <= tr.tp2;
    const hitBe = s === 1 ? b.l <= tr.entry : b.h >= tr.entry;
    if (stage === 0) {
      if (hitSl) return { done: true, stage, r: -1 - cost, bars: i + 1, out: 'SL' };
      if (hit2) return { done: true, stage, r: full - cost, bars: i + 1, out: 'TP2' };
      if (hit1) stage = 1;
    } else {
      if (hitBe) return { done: true, stage, r: 0.5 * C.rr1 - cost, bars: i + 1, out: 'BE' };
      if (hit2) return { done: true, stage, r: full - cost, bars: i + 1, out: 'TP2' };
    }
  }
  if (cd.length >= maxBars && n > 0) {
    const u = ((cd[n - 1].c - tr.entry) * s) / risk;
    const r = stage === 1 ? 0.5 * C.rr1 + 0.5 * u : u;
    return { done: true, stage, r: r - cost, bars: n, out: 'TIMEOUT' };
  }
  return { done: false, stage };
}

function stats(list) {
  const c = list.filter(t => t.done);
  const rs = c.map(t => t.r);
  const wins = rs.filter(r => r > 0), losses = rs.filter(r => r <= 0);
  const total = rs.reduce((x, y) => x + y, 0);
  const gw = wins.reduce((x, y) => x + y, 0), gl = Math.abs(losses.reduce((x, y) => x + y, 0));
  let peak = 0, eq = 0, dd = 0;
  rs.forEach(r => { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); });
  return {
    trades: c.length,
    winRate: c.length ? +(wins.length / c.length * 100).toFixed(1) : 0,
    totalR: +total.toFixed(2),
    avgR: c.length ? +(total / c.length).toFixed(2) : 0,
    profitFactor: gl ? +(gw / gl).toFixed(2) : null,
    maxDrawdownR: +dd.toFixed(2)
  };
}

// ---------- backtest ----------
const upto = (arr, ms, t, n) => arr.filter(b => b.t + ms <= t).slice(-n);
const pick = (arr, p) => arr.length ? +arr[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(2) : null;
let dataCache = null;
let btCache = {};
let sweepCache = null;

async function loadBtData() {
  if (dataCache && Date.now() - dataCache.at < 3600000) return dataCache;
  const [B, H4, H1] = await Promise.all([
    candles('15min', 5000, BAR),
    candles('4h', 1500, 4 * 3600000),
    candles('1h', 3000, 3600000)
  ]);
  // Pre-slice windows once, so each backtest run is fast.
  const prep = [];
  for (let i = 200; i < B.length - 2; i++) {
    const w = B.slice(i - 149, i + 1);
    const t = w[w.length - 1].t + BAR;
    const h4 = upto(H4, 4 * 3600000, t, 260), h1 = upto(H1, 3600000, t, 120);
    prep.push(h4.length < 60 || h1.length < 60 ? null : { i, w, t, h4, h1 });
  }
  dataCache = { at: Date.now(), B, prep };
  btCache = {};
  sweepCache = null;
  return dataCache;
}

function cfgFromUrl(url) {
  const q = new URL(url, 'http://x').searchParams;
  const cfg = Object.assign({}, DEF);
  const map = { maxdist: 'maxDist', rr1: 'rr1', rr2: 'rr2', spread: 'spread', minatr: 'minAtr', h1: 'h1', zone: 'zone', slbuf: 'slbuf', maxatr: 'maxAtr', vpf: 'vpf' };
  Object.keys(map).forEach(k => {
    if (q.has(k) && q.get(k) !== '' && !isNaN(Number(q.get(k)))) cfg[map[k]] = Number(q.get(k));
  });
  return cfg;
}

function runBt(cfg, d, wantFunnel) {
  const B = d.B, prep = d.prep;
  const trades = [], perDay = {}, riskSamples = [], atrSamples = [];
  const funnel = {
    candlesChecked: 0, sessionCandles: 0,
    trendH4: 0, trendH1: 0, volatility: 0, levelRetest: 0, candlePattern: 0, riskSize: 0,
    levelAndCandle: 0, trendLevelCandle: 0,
    levelCandleButRiskTooBig: 0, levelCandleButRiskTooSmall: 0, levelCandleRiskOk: 0
  };
  let idx = 0;
  while (idx < prep.length) {
    const p = prep[idx];
    if (!p) { idx++; continue; }
    const sg = analyze(p.w, p.h4, p.h1, p.t, cfg);

    if (wantFunnel) {
      funnel.candlesChecked++;
      const pass = n => { const c = sg.checks.find(x => x.name === n); return !!(c && c.pass); };
      if (pass('Session')) {
        funnel.sessionCandles++;
        if (pass('Trend (H4)')) funnel.trendH4++;
        if (pass('Trend (H1)')) funnel.trendH1++;
        if (pass('Volatility')) funnel.volatility++;
        if (pass('Level retest')) funnel.levelRetest++;
        if (pass('Candle')) funnel.candlePattern++;
        if (pass('Risk size')) funnel.riskSize++;
        if (pass('Level retest') && pass('Candle')) {
          funnel.levelAndCandle++;
          riskSamples.push(sg.riskVal);
          atrSamples.push(sg.atrVal);
          if (pass('Trend (H4)') && pass('Trend (H1)')) funnel.trendLevelCandle++;
          if (sg.riskVal > sg.maxRisk) funnel.levelCandleButRiskTooBig++;
          else if (sg.riskVal < sg.minRisk) funnel.levelCandleButRiskTooSmall++;
          else funnel.levelCandleRiskOk++;
        }
      }
    }

    if (sg.signal !== 'NO TRADE') {
      const dk = new Date(p.t).toISOString().slice(0, 10);
      if ((perDay[dk] || 0) < cfg.maxPerDay) {
        const tr = { dir: sg.signal, entry: sg.entry, sl: sg.sl, tp1: sg.tp1, tp2: sg.tp2 };
        const res = evalTrade(tr, B.slice(p.i + 1, p.i + 97), 96, cfg);
        if (!res.done) break;
        perDay[dk] = (perDay[dk] || 0) + 1;
        trades.push({ time: sg.candle, tms: sg.candleTime, dir: tr.dir, entry: +tr.entry.toFixed(2), sl: +tr.sl.toFixed(2), out: res.out, r: +res.r.toFixed(2), done: true });
        idx += res.bars + cfg.cooldown;
        continue;
      }
    }
    idx++;
  }
  return { trades, funnel, riskSamples, atrSamples };
}

async function backtest(cfg) {
  const key = JSON.stringify(cfg);
  const d = await loadBtData();
  if (btCache[key]) return btCache[key];
  const r = runBt(cfg, d, true);
  r.riskSamples.sort((x, y) => x - y);
  r.atrSamples.sort((x, y) => x - y);
  r.funnel.riskStats = {
    note: 'Stop distance of candles that had level retest and candle pattern',
    min: pick(r.riskSamples, 0), median: pick(r.riskSamples, 0.5), p75: pick(r.riskSamples, 0.75), max: pick(r.riskSamples, 0.999),
    atrMedian: pick(r.atrSamples, 0.5)
  };
  const data = {
    note: 'Backtest on recent M15 candles. Includes spread cost. Past results do not guarantee future results. Under 30 trades is too few to trust.',
    config: cfg,
    from: new Date(d.B[0].t).toISOString(),
    to: new Date(d.B[d.B.length - 1].t).toISOString(),
    summary: stats(r.trades),
    funnel: r.funnel,
    last30: r.trades.slice(-30)
  };
  btCache[key] = data;
  return data;
}

// ---------- sweep: many settings at once, with train/test split ----------
const fmt = s => 'n=' + s.trades + ' win' + s.winRate + '% R' + s.totalR + ' PF' + (s.profitFactor === null ? '-' : s.profitFactor) + ' DD' + s.maxDrawdownR;

async function sweep() {
  const d = await loadBtData();
  if (sweepCache) return sweepCache;
  const splitT = d.B[Math.floor(d.B.length * 0.7)].t;
  const rrs = [[1.5, 2], [1, 2], [2, 3]];
  const rows = [];
  [20, 30].forEach(md => [0, 1].forEach(h1 => [0.5, 1, 1.5].forEach(zn => rrs.forEach(rr => {
    const cfg = Object.assign({}, DEF, { maxDist: md, h1: h1, zone: zn, rr1: rr[0], rr2: rr[1] });
    const r = runBt(cfg, d, false);
    const tr = r.trades.filter(x => x.tms < splitT), te = r.trades.filter(x => x.tms >= splitT);
    rows.push({
      q: '?maxdist=' + md + '&h1=' + h1 + '&zone=' + zn + '&rr1=' + rr[0] + '&rr2=' + rr[1],
      label: 'maxdist ' + md + ' | h1 ' + h1 + ' | zone ' + zn + ' | rr ' + rr[0] + '/' + rr[1],
      all: stats(r.trades), train: stats(tr), test: stats(te)
    });
  }))));
  const eligible = rows.filter(r => r.train.trades >= 10 && r.test.trades >= 5);
  eligible.sort((a, b) => Math.min(b.train.totalR, b.test.totalR) - Math.min(a.train.totalR, a.test.totalR));
  const both = eligible.filter(r => r.train.totalR > 0 && r.test.totalR > 0);
  const byAll = rows.slice().sort((a, b) => b.all.totalR - a.all.totalR).slice(0, 5);
  const data = {
    note: 'Ranked by the weaker of train and test result. Train is the first 70% of candles, test is the last 30%. Only settings with at least 10 train and 5 test trades are ranked. Under 30 trades in total is weak evidence.',
    from: new Date(d.B[0].t).toISOString(),
    splitAt: new Date(splitT).toISOString(),
    to: new Date(d.B[d.B.length - 1].t).toISOString(),
    tested: rows.length,
    ranked: eligible.length,
    profitableOnBoth: both.length,
    top: eligible.slice(0, 8).map(r => r.label + ' || TRAIN ' + fmt(r.train) + ' || TEST ' + fmt(r.test)),
    topLinks: eligible.slice(0, 8).map(r => '/api/backtest' + r.q),
    mostTotalRAllTrades: byAll.map(r => r.label + ' || ALL ' + fmt(r.all))
  };
  sweepCache = data;
  return data;
}

// ---------- chart data (volume profile and pivot levels) ----------
function chartData() {
  const B = chartB;
  if (!B || B.length < 60) return null;
  const period = Math.min(VP_PERIOD, B.length);
  const w = B.slice(-period);
  const base = B.length - period;
  const showN = Math.min(120, B.length);
  const showStart = B.length - showN;
  const prof = profile(w, w.length, VP_BINS);

  const levels = [];
  allPivots(w, PIVOT_LEN).forEach(p => {
    const pct = volPct(prof, p.val);
    if (pct < PIVOT_FILTER) return;
    let to = null;
    for (let j = p.idx + 1; j < w.length; j++) {
      if (w[j].l < p.val && w[j].h > p.val) { to = j; break; }
    }
    levels.push({
      price: +p.val.toFixed(2), high: p.high, pct: Math.round(pct),
      from: base + p.idx - showStart, to: to === null ? null : base + to - showStart, idx: p.idx
    });
  });
  levels.sort((a, b) => b.idx - a.idx);

  const sig = state.signal === 'BUY' || state.signal === 'SELL'
    ? { dir: state.signal, entry: state.entry, sl: state.sl, tp1: state.tp1, tp2: state.tp2 } : null;

  return {
    period,
    candles: B.slice(-showN).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c })),
    prof: { low: prof.low, high: prof.high, size: prof.size, bins: prof.bins, max: prof.max, poc: prof.poc, delta: prof.delta, hasVol: prof.hasVol },
    levels: levels.slice(0, 12),
    signal: sig
  };
}

// ---------- alerts ----------
async function notify(s) {
  const f = x => x.toFixed(2);
  const text = SYMBOL + ' ' + s.signal + '\nEntry ' + f(s.entry) + '\nSL ' + f(s.sl) +
    '\nTP1 ' + f(s.tp1) + ' (close half, move SL to entry)\nTP2 ' + f(s.tp2) + '\nM15 candle ' + s.candle;
  console.log(text);
  fetch('https://ntfy.sh/' + (process.env.NTFY_TOPIC || 'xauusd-signals-k7x92q'), { method: 'POST', body: text, headers: { Title: SYMBOL + ' ' + s.signal, Priority: 'high' } }).catch(e => console.error('ntfy error', e.message));
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text })
    });
  } catch (e) { console.error('Telegram error', e.message); }
}

// ---------- loop ----------
let state = { signal: 'STARTING', checks: [] };
let trades = [], lastBoundary = 0, lastAlertT = 0, chartB = null;

async function refresh() {
  try {
    const [Bfull, H4, H1] = await Promise.all([
      candles('15min', 250, BAR),
      candles('4h', 260, 4 * 3600000),
      candles('1h', 120, 3600000)
    ]);
    const B = Bfull.slice(-150);
    if (B.length < 40 || H4.length < 60 || H1.length < 60) throw new Error('Not enough candles from API');
    chartB = Bfull;

    // update open trades
    trades.forEach(tr => {
      if (tr.done) return;
      const res = evalTrade(tr, B.filter(b => b.t > tr.candleTime), 96, DEF);
      Object.assign(tr, res);
    });

    const s = analyze(B, H4, H1, Date.now(), DEF);

    if (s.signal !== 'NO TRADE') {
      const dk = s.candle.slice(0, 10);
      const today = trades.filter(t => t.candle.slice(0, 10) === dk).length;
      let why = '';
      if (s.candleTime - lastAlertT < DEF.cooldown * BAR) why = 'Cooldown after last signal';
      else if (today >= DEF.maxPerDay) why = 'Daily signal limit reached';
      if (why) {
        s.checks.push({ name: 'Limits', pass: false, note: why });
        s.signal = 'NO TRADE'; s.entry = s.sl = s.tp1 = s.tp2 = null;
      } else {
        s.checks.push({ name: 'Limits', pass: true, note: today + ' of ' + DEF.maxPerDay + ' today' });
      }
    }
    state = s;

    if (s.signal !== 'NO TRADE' && s.candleTime !== lastAlertT) {
      lastAlertT = s.candleTime;
      trades.unshift({ dir: s.signal, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, candleTime: s.candleTime, candle: s.candle, done: false, stage: 0 });
      trades = trades.slice(0, 50);
      await notify(s);
    }
  } catch (e) {
    state = Object.assign({}, state, { error: e.message, updated: new Date().toISOString() });
    console.error(e.message);
  }
}

lastBoundary = Math.floor(Date.now() / 900000) * 900000;
refresh();
setInterval(() => {
  const now = Date.now(), b = Math.floor(now / 900000) * 900000;
  if (b > lastBoundary && now - b >= 8000) { lastBoundary = b; refresh(); }
}, 5000);

// ---------- web ----------
const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>XAUUSD Live Signal</title>
<style>
body{margin:0;background:#0e1620;color:#e8eef5;font:16px/1.5 system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px}
.c{background:#172230;border:1px solid #2b3a4c;border-radius:10px;padding:14px;margin-bottom:14px}
.v{font-size:2.2rem;font-weight:800;margin:0}
.BUY{color:#4cc98a}.SELL{color:#ff8077}.NO{color:#e3b340}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px}dt{color:#93a3b5}dd{margin:0;font-weight:600}
li{list-style:none;padding:6px 0;border-top:1px solid #2b3a4c}ul{padding:0;margin:8px 0 0}
.p{color:#4cc98a}.f{color:#ff8077}.m{color:#93a3b5;font-size:.85rem}
a{color:#7fb4ff}
canvas{display:block;width:100%;height:340px}
</style></head><body><main>
<h1>XAUUSD Live Signal</h1><div id="o" class="c">Loading...</div>
<div class="c"><b>M15 chart with volume profile</b><canvas id="cv"></canvas><div id="vi" class="m"></div></div>
<div id="t" class="c"></div>
<p class="m"><a href="/api/backtest">Run backtest</a> | <a href="/api/sweep">Run sweep</a> (takes a few seconds). Checks the last closed M15 candle. Education only, not financial advice.</p>
<script>
function f(x){return x==null?'-':x.toFixed(2)}
function load(){fetch('/api/signal').then(function(r){return r.json()}).then(function(s){
var cls=s.signal==='BUY'?'BUY':s.signal==='SELL'?'SELL':'NO';
var h='<p class="v '+cls+'">'+s.signal+'</p><div class="m">Price '+f(s.price)+' | Candle '+(s.candle||'-')+'</div>';
if(s.entry!=null){h+='<dl><dt>Entry</dt><dd>'+f(s.entry)+'</dd><dt>Stop loss</dt><dd>'+f(s.sl)+'</dd><dt>TP1</dt><dd>'+f(s.tp1)+'</dd><dt>TP2</dt><dd>'+f(s.tp2)+'</dd></dl>'}
if(s.error){h+='<p class="f">API error: '+s.error+'</p>'}
h+='<ul>'+(s.checks||[]).map(function(c){return '<li><b class="'+(c.pass?'p':'f')+'">'+(c.pass?'Pass':'Fail')+'</b> '+c.name+' <span class="m">'+c.note+'</span></li>'}).join('')+'</ul>';
document.getElementById('o').innerHTML=h;
var st=s.stats||{};
var t='<b>Live results since server start</b><div class="m">Trades '+(st.trades||0)+' | Win rate '+(st.winRate||0)+'% | Total '+(st.totalR||0)+'R | Max drawdown '+(st.maxDrawdownR||0)+'R</div><ul>'+(s.trades||[]).slice(0,10).map(function(x){return '<li><b class="'+(x.dir==='BUY'?'BUY':'SELL')+'">'+x.dir+'</b> '+f(x.entry)+' <span class="m">'+(x.done?(x.out+' '+f(x.r)+'R'):(x.stage===1?'Open, TP1 hit':'Open'))+'</span></li>'}).join('')+'</ul>';
document.getElementById('t').innerHTML=t})}

function draw(d){
var cv=document.getElementById('cv');var dpr=window.devicePixelRatio||1;
var w=cv.clientWidth,h=340;cv.width=w*dpr;cv.height=h*dpr;
var x=cv.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
var c=d.candles,n=c.length,i;if(!n){return}
var lo=1e12,hi=-1e12;
for(i=0;i<n;i++){if(c[i].l<lo)lo=c[i].l;if(c[i].h>hi)hi=c[i].h}
var sg=d.signal;
if(sg){[sg.entry,sg.sl,sg.tp1,sg.tp2].forEach(function(v){if(v<lo)lo=v;if(v>hi)hi=v})}
var pad=(hi-lo)*0.04;lo-=pad;hi+=pad;
var top=10,bot=14,axisW=48,plotW=Math.floor((w-axisW)*0.74),profX=plotW+4,profW=w-axisW-profX;
function Y(p){return top+(hi-p)/(hi-lo)*(h-top-bot)}
var step=plotW/n,pr=d.prof;
x.fillStyle='rgba(127,180,255,0.35)';
for(i=0;i<pr.bins.length;i++){var b0=pr.low+pr.size*i,b1=b0+pr.size;if(b1<lo||b0>hi)continue;var len=pr.bins[i]/pr.max*profW;var y1=Y(Math.min(b1,hi)),y0=Y(Math.max(b0,lo));x.fillRect(profX,y1,len,Math.max(1,y0-y1-1))}
for(i=0;i<n;i++){var k=c[i],up=k.c>=k.o,cx=i*step+step/2;x.strokeStyle=up?'#4cc98a':'#ff8077';x.fillStyle=x.strokeStyle;x.beginPath();x.moveTo(cx,Y(k.h));x.lineTo(cx,Y(k.l));x.stroke();var yo=Y(k.o),yc=Y(k.c);x.fillRect(cx-step*0.3,Math.min(yo,yc),step*0.6,Math.max(1,Math.abs(yo-yc)))}
x.font='10px sans-serif';
d.levels.forEach(function(lv){if(lv.price<lo||lv.price>hi)return;var x1=Math.max(0,lv.from)*step,x2=(lv.to===null?n:Math.min(n,Math.max(0,lv.to)))*step;if(x2<=x1)return;x.strokeStyle=lv.high?'#c0504d':'#2aa198';x.lineWidth=lv.to===null?2:1;x.setLineDash(lv.to===null?[]:[4,3]);x.beginPath();x.moveTo(x1,Y(lv.price));x.lineTo(x2,Y(lv.price));x.stroke();x.setLineDash([]);x.lineWidth=1;x.fillStyle=x.strokeStyle;x.fillText(lv.pct+'%',x1+2,Y(lv.price)-2)});
x.strokeStyle=pr.delta>0?'#4cc98a':'#c0504d';x.lineWidth=2;x.beginPath();x.moveTo(0,Y(pr.poc));x.lineTo(w-axisW,Y(pr.poc));x.stroke();x.lineWidth=1;x.fillStyle=x.strokeStyle;x.fillText('POC '+pr.poc.toFixed(2),4,Y(pr.poc)-3);
if(sg){[['Entry',sg.entry,'#e8eef5'],['SL',sg.sl,'#ff8077'],['TP1',sg.tp1,'#4cc98a'],['TP2',sg.tp2,'#4cc98a']].forEach(function(a){x.strokeStyle=a[2];x.setLineDash([6,4]);x.beginPath();x.moveTo(0,Y(a[1]));x.lineTo(w-axisW,Y(a[1]));x.stroke();x.setLineDash([]);x.fillStyle=a[2];x.fillText(a[0],plotW-34,Y(a[1])-2)})}
x.fillStyle='#93a3b5';
for(i=0;i<=4;i++){var pp=lo+(hi-lo)*i/4;x.fillText(pp.toFixed(1),w-axisW+4,Y(pp)+3)}
document.getElementById('vi').textContent='Volume profile of last '+d.period+' candles | POC '+pr.poc.toFixed(2)+' | Net flow '+(pr.delta>0?'buying':'selling')+' | Source: '+(pr.hasVol?'API volume':'candle count (API gives no volume)')+' | Level labels show volume %'}

function loadChart(){fetch('/api/chart').then(function(r){return r.json()}).then(function(d){if(d&&d.candles){draw(d)}})}
load();loadChart();setInterval(load,30000);setInterval(loadChart,60000);
</script></main></body></html>`;

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj, null, 2));
}

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/signal')) {
    return sendJson(res, 200, Object.assign({}, state, { trades, stats: stats(trades) }));
  }
  if (req.url.startsWith('/api/chart')) {
    try { return sendJson(res, 200, chartData() || { error: 'Not ready yet' }); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (req.url.startsWith('/api/backtest')) {
    try { return sendJson(res, 200, await backtest(cfgFromUrl(req.url))); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (req.url.startsWith('/api/sweep')) {
    try { return sendJson(res, 200, await sweep()); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(PORT, () => console.log('Running on port ' + PORT));
