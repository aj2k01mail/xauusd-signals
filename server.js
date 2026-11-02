const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || "";

// TradingView may send JSON as plain text, so read everything as text
app.use(express.text({ type: "*/*" }));

app.get("/", (req, res) => {
  res.send("xauusd-signals server running");
});

app.post("/webhook", (req, res) => {
  let data;
  try {
    data = JSON.parse(req.body);
  } catch (err) {
    console.log("Invalid JSON:", req.body);
    return res.status(400).send("invalid json");
  }

  if (SECRET && data.secret !== SECRET) {
    console.log("Wrong secret");
    return res.status(401).send("unauthorized");
  }

  console.log(
    new Date().toISOString(),
    "SIGNAL:",
    data.symbol,
    data.side,
    "SL:",
    data.sl,
    "TP:",
    data.tp
  );

  // Add your own action here (Telegram message, broker API, etc.)

  res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
});
