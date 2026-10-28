// XAUUSD live signal server. Node 18+, no dependencies.
const http = require('http');

const KEY = process.env.TWELVEDATA_KEY;
const PORT = process.env.PORT || 3000;
const SYMBOL = process.env.SYMBOL || 'XAU/USD';
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT;
const SESSION = (process.env.SESSION_UTC || '7-20').split('-').map(Number);
// Example: NEWS_BLOCKS="2026-10-29 12:30-13:30,2026-11-06 13:00-14:00" (UTC)
const NEWS = (process.env.NEWS_BLOCKS || '').split(',').map(s => s.trim()).filter(Boolean);

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
    .filter(b => b.t + ms <= now); // keep closed candles only
}

// ---------- strategy ----------
function analyze(B, H) {
  const k = B.length - 1, last = B[k], prev = B[k - 1];
  const a = atr(B, 14), zone = a * 0.5, tick = 0.01;
  const hc = H.map(x => x.c), slen = Math.min(200, H.length - 1);
  const ef = ema(hc, 50), es = ema(hc, slen), hl = hc[hc.length - 1];
  const up = ef > es && hl > ef, down = ef < es && hl < ef;
  const dir = up ? 'BUY' : down ? 'SELL' : 'NONE';
  const pv = pivots(B, k, 5);

  const body = Math.abs(last.c - last.o);
  const uw = last.h - Math.max(last.o, last.c);
  const lw = Math.min(last.o, last.c) - last.l;
  const bullC = (last.c > last.o && prev.c < prev.o && last.c >= prev.o && last.o <= prev.c) ||
                (lw >= 2 * Math.max(body, tick) && lw >= 2 * uw);
  const bearC = (last.c < last.o && prev.c > prev.o && last.c <= prev.o && last.o >= prev.c) ||
                (uw >= 2 * Math.max(body, tick) && uw >= 2 * lw);

  const now = new Date(), hr = now.getUTCHours();
  const sessOk = hr >= SESSION[0] && hr < SESSION[1];
  const newsOk = !NEWS.some(s => {
    const [d, r] = s.split(' '); const [x, y] = r.split('-');
    return now >= Date.parse(d + 'T' + x + ':00Z') && now <= Date.parse(d + 'T' + y + ':00Z');
  });
  const fresh = Date.now() - last.t < 45 * 60000;

  const checks = [];
  checks.push({ name: 'Data fresh', pass: fresh, note: fresh ? 'Live candles' : 'Market closed or stale data' });
  checks.push({ name: 'Trend (H4)', pass: dir !== 'NONE', note: (up ? 'Uptrend' : down ? 'Downtrend' : 'Range') });

  let lvl = false, cnd = false, sl = 0, risk = 0, rOk = false;
  if (dir === 'BUY') {
    lvl = pv.pl !== null && last.l <= pv.pl + zone && last.l >= pv.pl - zone && last.c > pv.pl;
    cnd = bullC;
    sl = Math.min(last.l, pv.pl === null ? last.l : pv.pl) - a * 0.3;
    risk = last.c - sl;
  } else if (dir === 'SELL') {
    lvl = pv.ph !== null && last.h >= pv.ph - zone && last.h <= pv.ph + zone && last.c < pv.ph;
    cnd = bearC;
    sl = Math.max(last.h, pv.ph === null ? last.h : pv.ph) + a * 0.3;
    risk = sl - last.c;
  }
  if (dir !== 'NONE') {
    rOk = risk > 0 && risk <= a * 3;
    checks.push({ name: 'Level retest', pass: lvl, note: dir === 'BUY' ? 'Swing low ' + pv.pl : 'Swing high ' + pv.ph });
    checks.push({ name: 'Candle', pass: cnd, note: 'Pin bar or engulfing' });
    checks.push({ name: 'Risk size', pass: rOk, note: 'Stop ' + risk.toFixed(2) + ' (max ' + (a * 3).toFixed(2) + ')' });
  }
  checks.push({ name: 'Session', pass: sessOk, note: 'UTC ' + SESSION[0] + ':00 to ' + SESSION[1] + ':00' });
  checks.push({ name: 'News', pass: newsOk, note: newsOk ? 'No blocked window' : 'Inside news window' });

  const ok = fresh && dir !== 'NONE' && lvl && cnd && rOk && sessOk && newsOk;
  const e = last.c, s = dir === 'BUY' ? 1 : -1;
  return {
    signal: ok ? dir : 'NO TRADE',
    candleTime: last.t,
    candle: new Date(last.t).toISOString(),
    price: e,
    entry: ok ? e : null,
    sl: ok ? sl : null,
    tp1: ok ? e + s * risk * 2 : null,
    tp2: ok ? e + s * risk * 3 : null,
    checks,
    updated: new Date().toISOString()
  };
}

// ---------- alerts ----------
async function notify(s) {
  const f = x => x.toFixed(2);
  const text = SYMBOL + ' ' + s.signal + '\nEntry ' + f(s.entry) + '\nSL ' + f(s.sl) +
    '\nTP1 ' + f(s.tp1) + '\nTP2 ' + f(s.tp2) + '\nM15 candle ' + s.candle;
  console.log(text);
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
let history = [], lastBoundary = 0, lastAlertT = 0;

async function refresh() {
  try {
    const [B, H] = await Promise.all([
      candles('15min', 150, 15 * 60000),
      candles('4h', 260, 4 * 3600000)
    ]);
    if (B.length < 40 || H.length < 60) throw new Error('Not enough candles from API');
    state = analyze(B, H);
    if (state.signal !== 'NO TRADE' && state.candleTime !== lastAlertT) {
      lastAlertT = state.candleTime;
      history.unshift(state);
      history = history.slice(0, 20);
      await notify(state);
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
</style></head><body><main>
<h1>XAUUSD Live Signal</h1><div id="o" class="c">Loading...</div>
<p class="m">Checks the last closed M15 candle. Education only, not financial advice.</p>
<script>
function f(x){return x==null?'-':x.toFixed(2)}
function load(){fetch('/api/signal').then(function(r){return r.json()}).then(function(s){
var cls=s.signal==='BUY'?'BUY':s.signal==='SELL'?'SELL':'NO';
var h='<p class="v '+cls+'">'+s.signal+'</p><div class="m">Price '+f(s.price)+' | Candle '+(s.candle||'-')+'</div>';
if(s.entry!=null){h+='<dl><dt>Entry</dt><dd>'+f(s.entry)+'</dd><dt>Stop loss</dt><dd>'+f(s.sl)+'</dd><dt>TP1 (1:2)</dt><dd>'+f(s.tp1)+'</dd><dt>TP2 (1:3)</dt><dd>'+f(s.tp2)+'</dd></dl>'}
if(s.error){h+='<p class="f">API error: '+s.error+'</p>'}
h+='<ul>'+(s.checks||[]).map(function(c){return '<li><b class="'+(c.pass?'p':'f')+'">'+(c.pass?'Pass':'Fail')+'</b> '+c.name+' <span class="m">'+c.note+'</span></li>'}).join('')+'</ul>';
document.getElementById('o').innerHTML=h})}
load();setInterval(load,30000);
</script></main></body></html>`;

http.createServer((req, res) => {
  if (req.url.startsWith('/api/signal')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(Object.assign({}, state, { history })));
  }
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(PORT, () => console.log('Running on port ' + PORT));
