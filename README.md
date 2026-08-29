# AutoTread

Paper-trading terminal for crypto: multi-timeframe rules, optional TensorFlow helper, trailing stops, and a live dashboard. It is **not** a proven edge and it is **not** autonomous deep reinforcement learning.

## What it actually is
- Weighted indicator + SMC rules on 1m entries with 5m/1h/4h vetoes
- Simulated (or optional live futures) broker with fees, ATR stops, and 1R trailing
- A small neural net that stays **out of scoring** until it has a saved model or 20 trained samples
- A 5m walk-forward backtest (`npm run backtest` or the dashboard button)

## Quick Start
```bash
npm install
npm start
```
Open `http://localhost:3000`. Quality filters are on by default (fewer trades).

```bash
npm run backtest
```
Walks BTC/ETH/SOL/BNB on ~400 five-minute bars. Treat a losing backtest as the real answer, not the UI win rate.

## Live futures (optional)
Paper is the default. See `.env.example`. Keep `BINANCE_TESTNET=true` until you have a backtest you accept and have watched paper live.
