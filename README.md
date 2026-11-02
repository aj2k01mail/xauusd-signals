# xauusd-signals

XAUUSD EMA pullback strategy (TradingView) with a webhook receiver.

## Files
- ema-pullback.pine: Pine Script v5 strategy
- server.js: Express server that receives TradingView alerts
- package.json: dependencies

## Run
npm install
WEBHOOK_SECRET=change-me npm start

## TradingView alert
- Message: {{strategy.order.alert_message}}
- Webhook URL: https://YOUR-SERVER/webhook

## Disclaimer
Not financial advice. Backtest before going live.
