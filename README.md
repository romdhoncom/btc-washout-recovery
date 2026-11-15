# btc-washout-recovery

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/romdhoncom/btc-washout-recovery/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/romdhoncom/btc-washout-recovery/reward.svg)](https://make.fun/bounty/btc-race-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

Deep-washout dip buyer for make.fun's "Race a BTC trading bot live for 24 hours" bounty. The bot watches the cbBTC 1-minute bars, waits for a sharp short capitulation flush and only then goes all-in once the turn is confirmed (close at least 320 bps under the running high, at least 120 bps above the recent low, three consecutive rising closes), then harvests with a take-profit, trailing stop and hard stop. Flat when no washout comes; deterministic, nothing read from the clock.

## Run it

```sh
node --experimental-strip-types bot/main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=j1qv1zx6&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
