const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const TD_KEY = (process.env.TWELVE_DATA_KEY || "").trim();
const TG_TOKEN = (process.env.TELEGRAM_TOKEN || "").trim();
const TG_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const CRON_KEY = (process.env.CRON_KEY || "").trim();

const SYMBOL = "XAU/USD";
const INTERVAL = "15min";
const FAST = 20;
const SLOW = 50;
const ATR_LEN = 14;
const ATR_MULT = 1.5;
const RR = 2;

let lastSignal = "";

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

async function getCandles(size) {
  const url =
    "https://api.twelvedata.com/time_series?symbol=" +
    encodeURIComponent(SYMBOL) +
    "&interval=" + INTERVAL +
    "&outputsize=" + size + "&apikey=" + TD_KEY;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.values) throw new Error("Data error: " + JSON.stringify(data));
  return data.values.reverse().map((v) => ({
    time: v.datetime,
    open: +v.open,
    high: +v.high,
    low: +v.low,
    close: +v.close,
  }));
}

function signalAt(candles, emaF, emaS, i) {
  const c = candles[i];
  const up = emaF[i] > emaS[i] && c.close > emaS[i];
  const down = emaF[i] < emaS[i] && c.close < emaS[i];
  if (up && c.low <= emaF[i] && c.close > emaF[i] && c.close > c.open) return "BUY";
  if (down && c.high >= emaF[i] && c.close < emaF[i] && c.close < c.open) return "SELL";
  return null;
}

async function check() {
  const candles = await getCandles(120);
  candles.pop(); // drop the candle that is still forming
  const closes = candles.map((c) => c.close);
  const emaF = ema(closes, FAST);
  const emaS = ema(closes, SLOW);
  const a = atr(candles, ATR_LEN);
  const i = candles.length - 1;
  const c = candles[i];

  const side = signalAt(candles, emaF, emaS, i);

  let result = "No signal. Last closed candle: " + c.time;
  if (side && lastSignal !== c.time) {
    const risk = a[i] * ATR_MULT;
    const sl = side === "BUY" ? c.close - risk : c.close + risk;
    const tp = side === "BUY" ? c.close + risk * RR : c.close - risk * RR;
    const msg =
      side + " XAUUSD (" + INTERVAL + ")\n" +
      "Entry: " + c.close.toFixed(2) + "\n" +
      "SL: " + sl.toFixed(2) + "\n" +
      "TP: " + tp.toFixed(2);
    await notify("XAUUSD " + side, msg);
    lastSignal = c.time;
    result = msg;
  }
  return result;
}

async function backtest() {
  const candles = await getCandles(5000);
  const closes = candles.map((c) => c.close);
  const emaF = ema(closes, FAST);
  const emaS = ema(closes, SLOW);
  const a = atr(candles, ATR_LEN);

  const trades = [];
  let i = 100;
  while (i < candles.length - 1) {
    const side = signalAt(candles, emaF, emaS, i);
    if (!side) {
      i++;
      continue;
    }
    const entry = candles[i].close;
    const risk = a[i] * ATR_MULT;
    const sl = side === "BUY" ? entry - risk : entry + risk;
    const tp = side === "BUY" ? entry + risk * RR : entry - risk * RR;
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
        r = RR;
        break;
      }
    }
    if (r === null) break;
    trades.push({ side: side, time: candles[i].time, r: r });
    i = j + 1;
  }

  const wins = trades.filter((t) => t.r > 0).length;
  const losses = trades.length - wins;
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  trades.forEach((t) => {
    eq += t.r;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDD) maxDD = peak - eq;
  });
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const pf = losses ? (wins * RR) / losses : 0;

  return (
    "Backtest " + SYMBOL + " " + INTERVAL + "\n" +
    "From: " + candles[0].time + "\n" +
    "To: " + candles[candles.length - 1].time + "\n" +
    "Trades: " + trades.length + "\n" +
    "Wins: " + wins + "  Losses: " + losses + "\n" +
    "Win rate: " + winRate.toFixed(1) + "%\n" +
    "Total R: " + totalR.toFixed(1) + "\n" +
    "Profit factor: " + pf.toFixed(2) + "\n" +
    "Max drawdown: " + maxDD.toFixed(1) + " R"
  );
}

function allowed(req) {
  return !CRON_KEY || req.query.key === CRON_KEY;
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
    res.type("text/plain").send(await backtest());
  } catch (err) {
    console.log(err.message);
    res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
});
