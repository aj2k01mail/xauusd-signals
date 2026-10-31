// XAUUSD signal server v2.2 (tunable backtest). Node 18+, no dependencies.
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

// Default settings. The backtest link can override most of them, for example:
// /api/backtest?h1=0&zone=1&rr1=1.5&rr2=2&maxdist=10
const DEF = {
  maxDist: Number(process.env.MAX_DIST || 10),      // max price distance for SL and TP2
  rr1: Number(process.env.RR1 || 1.5),              // TP1 as multiple of risk
  rr2: Number(process.env.RR2 || 2),                // TP2 as multiple of risk
  spread: Number(process.env.SPREAD || 0.3),        // spread plus slippage in price
  minAtr: Number(process.env.MIN_ATR || 0.8),       // skip dead markets
  h1: Number(process.env.USE_H1 || 1),              // 1 = H1 trend must agree, 0 = ignore H1
  zone: Number(process.env.ZONE || 0.5),            // level retest zone in ATR
  slbuf: Number(process.env.SL_BUF || 0.3),         // stop buffer in ATR
  maxAtr: Number(process.env.MAX_ATR_MULT || 3),    // stop cannot exceed this many ATR
  maxPerDay: Number(process.env.MAX_PER_DAY || 3),  // max signals per UTC day
  cooldown: Number(process.env.COOLDOWN || 4),      // candles to wait after a signal
  friCutoff: Number(process.env.FRI_CUTOFF_UTC || 18)
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

function trendOf(arr, fast, slow) {
  const c = arr.map(x => x.c), sl = Math.min(slow, c.length - 1);
  const ef = ema(c, fast), es = ema(c, sl), last = c[c.length - 1];
  return ef > es && last > ef ? 'BUY' : ef < es && last < ef ? 'SELL' : 'NONE';
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
      o: +v.open, h: +v.high, l: +v.low, c: +v.close
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
  if (dir !== 'NONE') {
    maxRisk = Math.min(a * C.maxAtr, C.maxDist / C.rr2);
    rOk = risk >= minRisk && risk <= maxRisk;
    checks.push({ name: 'Level retest', pass: lvl, note: dir === 'BUY' ? 'Swing low ' + pv.pl : 'Swing high ' + pv.ph });
    checks.push({ name: 'Candle', pass: cnd, note: 'Pin bar or engulfing' });
    checks.push({ name: 'Risk size', pass: rOk, note: 'Stop ' + risk.toFixed(2) + ' (min ' + minRisk.toFixed(2) + ', max ' + maxRisk.toFixed(2) + ')' });
  }
  checks.push({ name: 'Session', pass: sessOk, note: !weekdayOk ? 'Weekend, market closed' : !fridayOk ? 'Friday cutoff' : 'UTC ' + SESSION[0] + ':00 to ' + SESSION[1] + ':00' });
  checks.push({ name: 'News', pass: newsOk, note: newsOk ? 'No blocked window' : 'Inside news window' });

  const ok = fresh && dir !== 'NONE' && h1ok && atrOk && lvl && cnd && rOk && sessOk && newsOk;
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

async function loadBtData() {
  if (dataCache && Date.now() - dataCache.at < 3600000) return dataCache;
  const [B, H4, H1] = await Promise.all([
    candles('15min', 5000, BAR),
    candles('4h', 1500, 4 * 3600000),
    candles('1h', 3000, 3600000)
  ]);
  dataCache = { at: Date.now(), B, H4, H1 };
  btCache = {};
  return dataCache;
}

function cfgFromUrl(url) {
  const q = new URL(url, 'http://x').searchParams;
  const cfg = Object.assign({}, DEF);
  const map = { maxdist: 'maxDist', rr1: 'rr1', rr2: 'rr2', spread: 'spread', minatr: 'minAtr', h1: 'h1', zone: 'zone', slbuf: 'slbuf', maxatr: 'maxAtr' };
  Object.keys(map).forEach(k => {
    if (q.has(k) && q.get(k) !== '' && !isNaN(Number(q.get(k)))) cfg[map[k]] = Number(q.get(k));
  });
  return cfg;
}

async function backtest(cfg) {
  const key = JSON.stringify(cfg);
  const data0 = await loadBtData();
  if (btCache[key]) return btCache[key];
  const { B, H4, H1 } = data0;
  const trades = [], perDay = {}, riskSamples = [], atrSamples = [];
  // Funnel counts only candles inside the trading session, to show which filter blocks signals.
  const funnel = {
    candlesChecked: 0, sessionCandles: 0,
    trendH4: 0, trendH1: 0, volatility: 0, levelRetest: 0, candlePattern: 0, riskSize: 0,
    levelAndCandle: 0, trendLevelCandle: 0,
    levelCandleButRiskTooBig: 0, levelCandleButRiskTooSmall: 0, levelCandleRiskOk: 0
  };
  let i = 200;
  while (i < B.length - 2) {
    const w = B.slice(i - 149, i + 1);
    const t = w[w.length - 1].t + BAR;
    const h4 = upto(H4, 4 * 3600000, t, 260), h1 = upto(H1, 3600000, t, 120);
    if (h4.length < 60 || h1.length < 60) { i++; continue; }
    const sg = analyze(w, h4, h1, t, cfg);

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

    const dk = new Date(t).toISOString().slice(0, 10);
    if (sg.signal !== 'NO TRADE' && (perDay[dk] || 0) < cfg.maxPerDay) {
      const tr = { dir: sg.signal, entry: sg.entry, sl: sg.sl, tp1: sg.tp1, tp2: sg.tp2 };
      const res = evalTrade(tr, B.slice(i + 1, i + 97), 96, cfg);
      if (!res.done) break;
      perDay[dk] = (perDay[dk] || 0) + 1;
      trades.push({ time: sg.candle, dir: tr.dir, entry: +tr.entry.toFixed(2), sl: +tr.sl.toFixed(2), out: res.out, r: +res.r.toFixed(2), done: true });
      i += res.bars + cfg.cooldown;
    } else {
      i++;
    }
  }
  riskSamples.sort((x, y) => x - y);
  atrSamples.sort((x, y) => x - y);
  funnel.riskStats = {
    note: 'Stop distance of candles that had level retest and candle pattern',
    min: pick(riskSamples, 0), median: pick(riskSamples, 0.5), p75: pick(riskSamples, 0.75), max: pick(riskSamples, 0.999),
    atrMedian: pick(atrSamples, 0.5)
  };
  const data = {
    note: 'Backtest on recent M15 candles. Includes spread cost. Past results do not guarantee future results. Under 30 trades is too few to trust.',
    config: cfg,
    from: new Date(B[0].t).toISOString(),
    to: new Date(B[B.length - 1].t).toISOString(),
    summary: stats(trades),
    funnel,
    last30: trades.slice(-30)
  };
  btCache[key] = data;
  return data;
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
let trades = [], lastBoundary = 0, lastAlertT = 0;

async function refresh() {
  try {
    const [B, H4, H1] = await Promise.all([
      candles('15min', 150, BAR),
      candles('4h', 260, 4 * 3600000),
      candles('1h', 120, 3600000)
    ]);
    if (B.length < 40 || H4.length < 60 || H1.length < 60) throw new Error('Not enough candles from API');

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
</style></head><body><main>
<h1>XAUUSD Live Signal</h1><div id="o" class="c">Loading...</div>
<div id="t" class="c"></div>
<p class="m"><a href="/api/backtest">Run backtest</a> (takes a few seconds). Checks the last closed M15 candle. Education only, not financial advice.</p>
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
load();setInterval(load,30000);
</script></main></body></html>`;

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/signal')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(Object.assign({}, state, { trades, stats: stats(trades) })));
  }
  if (req.url.startsWith('/api/backtest')) {
    try {
      const data = await backtest(cfgFromUrl(req.url));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(data, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(PORT, () => console.log('Running on port ' + PORT));
