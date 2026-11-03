const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const TD_KEY = process.env.TD_KEY || "";
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
const CRON_KEY = process.env.CRON_KEY || "";

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
  await fetch("https://ntfy.sh/" + NTFY_TOPIC, {
    method: "POST",
    body: message,
    headers: { Title: title },
  });
}

async function getCandles() {
  const url =
    "https://api.twelvedata.com/time_series?symbol=" +
    encodeURIComponent(SYMBOL) +
    "&interval=" + INTERVAL +
    "&outputsize=120&apikey=" + TD_KEY;
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

async function check() {
  const candles = await getCandles();
  candles.pop(); // drop the candle that is still forming
  const closes = candles.map((c) => c.close);
  const emaF = ema(closes, FAST);
  const emaS = ema(closes, SLOW);
  const a = atr(candles, ATR_LEN);
  const i = candles.length - 1;
  const c = candles[i];

  const up = emaF[i] > emaS[i] && c.close > emaS[i];
  const down = emaF[i] < emaS[i] && c.close < emaS[i];
  const longSig = up && c.low <= emaF[i] && c.close > emaF[i] && c.close > c.open;
  const shortSig = down && c.high >= emaF[i] && c.close < emaF[i] && c.close < c.open;

  let result = "No signal. Last closed candle: " + c.time;
  if ((longSig || shortSig) && lastSignal !== c.time) {
    const side = longSig ? "BUY" : "SELL";
    const risk = a[i] * ATR_MULT;
    const sl = longSig ? c.close - risk : c.close + risk;
    const tp = longSig ? c.close + risk * RR : c.close - risk * RR;
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

function allowed(req) {
  return !CRON_KEY || req.query.key === CRON_KEY;
}

app.get("/", (req, res) => {
  res.send("xauusd-signals server running");
});

app.get("/test", async (req, res) => {
  if (!allowed(req)) return res.status(401).send("unauthorized");
  try {
    await notify("Test", "Server test message");
    res.send("sent");
  } catch (err) {
    res.status(500).send(err.message);
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

app.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
});
