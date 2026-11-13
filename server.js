const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const TD_KEY = (process.env.TWELVE_DATA_KEY || "").trim();
const TG_TOKEN = (process.env.TELEGRAM_TOKEN || "").trim();
const TG_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const CRON_KEY = (process.env.CRON_KEY || "").trim();

const SYMBOL = "XAU/USD";
const LIVE_INTERVAL = "1h"; // timeframe used by /check
const BT_TF = "15min"; // default timeframe for /backtest and /optimize
const BT_BARS = 12000; // about 6 months of 15min candles
const TFS = ["5min", "15min", "30min", "1h"];
const ATR_LEN = 14;
const SPREAD = 0.3; // assumed cost per trade in price units

// Live strategy settings. Replace with optimizer result later.
const CFG = { fast: 20, slow: 50, trend: 200, atrMult: 1.5, rr: 2, from: 7, to: 17 };

let lastSignal = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ema(values, len) {
  const k = 2 / (len + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function atr(c, len) {
  const tr = c.map((x, i) => {
    if (i === 0) return x.high - x.low;
    return Math.max(
      x.high - x.low,
      Math.abs(x.high - c[i - 1].close),
      Math.abs(x.low - c[i - 1].close)
    );
  });
  const out = [];
  let prev = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < len - 1) {
      out.push(null);
    } else if (i === len - 1) {
      prev = tr.slice(0, len).reduce((a, b) => a + b, 0) / len;
      out.push(prev);
    } else {
      prev = (prev * (len - 1) + tr[i]) / len;
      out.push(prev);
    }
  }
  return out;
}

async function notify(title, message) {
  if (!TG_TOKEN || !TG_CHAT_ID) throw new Error("Telegram env vars missing");
  const res = await fetch(
    "https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: title + "\n" + message,
      }),
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error("telegram error " + res.status + ": " + text);
  return "telegram ok (" + res.status + ")";
}

async function getCandles(size, tf) {
  const interval = tf || LIVE_INTERVAL;
  const map = new Map();
  let endDate = "";
  for (let round = 0; round < 6 && map.size < size; round++) {
    const n = Math.min(5000, size - map.size);
    let url =
      "https://api.twelvedata.com/time_series?symbol=" +
      encodeURIComponent(SYMBOL) +
      "&interval=" + interval +
      "&timezone=UTC" +
      "&outputsize=" + n +
      "&apikey=" + TD_KEY;
    if (endDate) url += "&end_date=" + encodeURIComponent(endDate);
    const res = await fetch(url);
    const data = await res.json();
    if (!data.values) {
      if (map.size) break;
      throw new Error("Data error: " + JSON.stringify(data));
    }
    const before = map.size;
    data.values.forEach((v) => {
      map.set(v.datetime, {
        time: v.datetime,
        open: +v.open,
        high: +v.high,
        low: +v.low,
        close: +v.close,
      });
    });
    if (data.values.length < n || map.size === before) break;
    endDate = data.values[data.values.length - 1].datetime;
    await sleep(2000);
  }
  return Array.from(map.values()).sort((x, y) => (x.time < y.time ? -1 : 1));
}

function okDay(time) {
  const d = new Date(time.replace(" ", "T") + "Z").getUTCDay();
  return d !== 0 && d !== 6;
}

function inSession(time, from, to) {
  if (from === 0 && to === 24) return true;
  const h = parseInt(time.slice(11, 13), 10);
  return h >= from && h < to;
}

function signalAt(candles, f, s, t, i, p) {
  const c = candles[i];
  if (!okDay(c.time) || !inSession(c.time, p.from, p.to)) return null;
  const upT = !t || c.close > t[i];
  const dnT = !t || c.close < t[i];
  const up = f[i] > s[i] && c.close > s[i] && upT;
  const down = f[i] < s[i] && c.close < s[i] && dnT;
  if (up && c.low <= f[i] && c.close > f[i] && c.close > c.open) return "BUY";
  if (down && c.high >= f[i] && c.close < f[i] && c.close < c.open) return "SELL";
  return null;
}

function runTrades(candles, f, s, t, a, p, start, end) {
  const out = [];
  let i = start;
  while (i < end) {
    const side = signalAt(candles, f, s, t, i, p);
    if (!side || a[i] === null) {
      i++;
      continue;
    }
    const entry = candles[i].close;
    const risk = a[i] * p.atrMult;
    const sl = side === "BUY" ? entry - risk : entry + risk;
    const tp = side === "BUY" ? entry + risk * p.rr : entry - risk * p.rr;
    let r = null;
    let j = i + 1;
    for (; j < candles.length; j++) {
      const k = candles[j];
      const hitSL = side === "BUY" ? k.low <= sl : k.high >= sl;
      const hitTP = side === "BUY" ? k.high >= tp : k.low <= tp;
      if (hitSL) {
        r = -1;
        break;
      }
      if (hitTP) {
        r = p.rr;
        break;
      }
    }
    if (r === null) break;
    out.push(r - SPREAD / risk);
    i = j + 1;
  }
  return out;
}

function stats(rs) {
  const n = rs.length;
  const tot = rs.reduce((x, y) => x + y, 0);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  rs.forEach((r) => {
    eq += r;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
  });
  return {
    n: n,
    wins: rs.filter((r) => r > 0).length,
    tot: tot,
    exp: n ? tot / n : 0,
    dd: dd,
  };
}

async function check() {
  const candles = await getCandles(320, LIVE_INTERVAL);
  candles.pop(); // drop the candle that is still forming
  const closes = candles.map((c) => c.close);
  const f = ema(closes, CFG.fast);
  const s = ema(closes, CFG.slow);
  const t = CFG.trend ? ema(closes, CFG.trend) : null;
  const a = atr(candles, ATR_LEN);
  const i = candles.length - 1;
  const c = candles[i];

  const side = signalAt(candles, f, s, t, i, CFG);

  let result = "No signal. Last closed candle: " + c.time;
  if (side && lastSignal !== c.time) {
    const risk = a[i] * CFG.atrMult;
    const sl = side === "BUY" ? c.close - risk : c.close + risk;
    const tp = side === "BUY" ? c.close + risk * CFG.rr : c.close - risk * CFG.rr;
    const msg =
      side + " XAUUSD (" + LIVE_INTERVAL + ")\n" +
      "Entry: " + c.close.toFixed(2) + "\n" +
      "SL: " + sl.toFixed(2) + "\n" +
      "TP: " + tp.toFixed(2);
    await notify("XAUUSD " + side, msg);
    lastSignal = c.time;
    result = msg;
  }
  return result;
}

function line(label, x) {
  return (
    label + " n=" + x.n +
    " win=" + (x.n ? ((x.wins / x.n) * 100).toFixed(0) : 0) + "%" +
    " exp=" + x.exp.toFixed(2) + "R" +
    " tot=" + x.tot.toFixed(1) + "R" +
    " dd=" + x.dd.toFixed(1) + "R"
  );
}

async function backtest(tf, bars) {
  const candles = await getCandles(bars, tf);
  const closes = candles.map((c) => c.close);
  const f = ema(closes, CFG.fast);
  const s = ema(closes, CFG.slow);
  const t = CFG.trend ? ema(closes, CFG.trend) : null;
  const a = atr(candles, ATR_LEN);
  const st = stats(runTrades(candles, f, s, t, a, CFG, 200, candles.length - 1));
  return (
    "Backtest " + SYMBOL + " " + tf + "\n" +
    "Candles: " + candles.length + "\n" +
    "From: " + candles[0].time + "\n" +
    "To: " + candles[candles.length - 1].time + "\n" +
    "Settings: " + JSON.stringify(CFG) + "\n" +
    "Spread cost: " + SPREAD + "\n" +
    line("Result:", st)
  );
}

async function optimize(tf, bars) {
  const candles = await getCandles(bars, tf);
  const closes = candles.map((c) => c.close);
  const E = {};
  [10, 20, 50, 100, 200].forEach((l) => {
    E[l] = ema(closes, l);
  });
  const a = atr(candles, ATR_LEN);
  const start = 200;
  const end = candles.length - 1;
  const split = start + Math.floor((end - start) * 0.7);

  const all = [];
  const sessions = [[0, 24], [7, 17], [12, 20]];
  for (const fast of [10, 20]) {
    for (const slow of [50, 100]) {
      for (const trend of [0, 200]) {
        for (const atrMult of [1, 1.5, 2]) {
          for (const rr of [1.5, 2, 3]) {
            for (const sess of sessions) {
              const p = {
                fast: fast, slow: slow, trend: trend,
                atrMult: atrMult, rr: rr, from: sess[0], to: sess[1],
              };
              const t = trend ? E[trend] : null;
              const tr = stats(runTrades(candles, E[fast], E[slow], t, a, p, start, split));
              const te = stats(runTrades(candles, E[fast], E[slow], t, a, p, split, end));
              all.push({ p: p, tr: tr, te: te });
            }
          }
        }
      }
    }
  }

  const passes = (x) => x.tr.n >= 30 && x.te.n >= 12 && x.tr.exp > 0 && x.te.exp > 0;
  const good = all
    .filter(passes)
    .sort((x, y) => y.tr.exp + y.te.exp - (x.tr.exp + x.te.exp))
    .slice(0, 8);

  let out =
    "Optimize " + SYMBOL + " " + tf + "\n" +
    "Candles: " + candles.length + "\n" +
    "Data: " + candles[0].time + " to " + candles[candles.length - 1].time + "\n" +
    "Train until: " + candles[split].time + " (then test)\n" +
    "Spread cost: " + SPREAD + "\n" +
    "Tested: " + all.length + " combos. Profitable in BOTH train and test: " +
    all.filter(passes).length + "\n\n";
  if (!good.length) {
    out += "No setup was profitable in both periods.";
    return out;
  }
  good.forEach((x, k) => {
    out +=
      "#" + (k + 1) + " " + JSON.stringify(x.p) + "\n" +
      "  " + line("TRAIN", x.tr) + "\n" +
      "  " + line("TEST ", x.te) + "\n\n";
  });
  return out;
}

function allowed(req) {
  return !CRON_KEY || req.query.key === CRON_KEY;
}

function btOpts(req) {
  const tf = TFS.includes(req.query.tf) ? req.query.tf : BT_TF;
  let bars = parseInt(req.query.bars, 10);
  if (!bars || bars < 500) bars = BT_BARS;
  if (bars > 20000) bars = 20000;
  return { tf: tf, bars: bars };
}

app.get("/", (req, res) => {
  res.send("xauusd-signals server running");
});

app.get("/test", async (req, res) => {
  if (!allowed(req)) return res.status(401).send("unauthorized");
  try {
    const info = await notify("Test", "Server test message");
    res.send("sent. " + info);
  } catch (err) {
    console.log(err.message);
    res.status(500).send("failed: " + err.message);
  }
});

app.get("/check", async (req, res) => {
  if (!allowed(req)) return res.status(401).send("unauthorized");
  try {
    res.send(await check());
  } catch (err) {
    console.log(err.message);
    res.status(500).send(err.message);
  }
});

app.get("/backtest", async (req, res) => {
  if (!allowed(req)) return res.status(401).send("unauthorized");
  try {
    const o = btOpts(req);
    res.type("text/plain").send(await backtest(o.tf, o.bars));
  } catch (err) {
    console.log(err.message);
    res.status(500).send(err.message);
  }
});

app.get("/optimize", async (req, res) => {
  if (!allowed(req)) return res.status(401).send("unauthorized");
  try {
    const o = btOpts(req);
    res.type("text/plain").send(await optimize(o.tf, o.bars));
  } catch (err) {
    console.log(err.message);
    res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
});
