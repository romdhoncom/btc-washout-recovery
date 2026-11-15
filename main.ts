// Washout-recovery dip-buyer for the cbBTC 1-minute race (agent-fun/bars-replay/v1).
//
// Idea: BTC's sharpest losses on this market arrive as short capitulation flushes, and the
// pool's price recovers a good part of a deep flush within the next hour. The bot goes all-in
// only on a deep washout (a close at least 320 bps under the running 360-bar high) once the
// turn is confirmed: the close sits at least 120 bps above the lowest close of the last 90
// minutes and three consecutive closes have risen. It then harvests a 300 bps take-profit
// measured from its own fill, with a 120 bps trailing stop under the highest close since the
// entry, a 60 bps stop under the low it confirmed from, and a 45-bar cooldown after every
// exit. When no washout comes it stays flat; near the end of the 24-hour window it takes a
// $1 presence position so the entry always records at least one filled trade.
//
// Every amount is the bar data's own integer units (micro-USDC at quote_scale, price at
// price_scale, quantity at qty_scale); the confirmations are computed on floating-point
// closes only. Deterministic: nothing is read from the clock, the environment or randomness.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

// ---- parameters ---------------------------------------------------------------------------

const SYMBOL = 'CBBTC';
/** The running-high window (bars) the washout depth is measured under. */
const HIGH_WINDOW = 360;
/** How deep under the running high a washout must be (bps) before it interests the bot. */
const DIP_MIN_BPS = 320;
/** Deeper than this the "washout" is treated as an outright crash and left alone. */
const DIP_MAX_BPS = 1000;
/** The recent-low window (bars) the bounce is measured from. */
const LOW_WINDOW = 90;
/** A close at least this far above the recent low (bps) says the low is in. */
const TRIGGER_BPS = 120;
/** Consecutive rising closes that confirm the turn. */
const UP_CLOSES = 3;
/** Take-profit above the entry fill (bps). */
const TAKE_PROFIT_BPS = 300;
/** Trailing stop under the highest close since the entry (bps). */
const TRAIL_BPS = 120;
/** Stop under the recent low the entry was confirmed from (bps). */
const STOP_LOW_BPS = 60;
/** Bars without entries after an exit. */
const COOLDOWN_BARS = 45;
/** Round trips the bot allows itself per window. */
const MAX_TRADES = 8;
/** A buy may not fill further than this above the close it was decided on (bps). */
const BUY_SLIPPAGE_BPS = 400;
/** The $1 presence buy, taken this many bars into a 1,440-bar window when nothing traded. */
const PRESENCE_SEQ = 1400;
/** The smallest order the harness accepts ($1 in quote units). */
const MIN_NOTIONAL = 1_000_000n;
/** Exits always fill: the whole point of a stop. */
const EXIT_SLIPPAGE_BPS = 10_000;

// ---- state --------------------------------------------------------------------------------

let seq = -1;
/** Every delivered close, as floats in price units. */
const closes: number[] = [];
/** The open position's fill bar seq (-1 flat). */
let entrySeq = -1;
/** The recent low (the last LOW_WINDOW closes, the decision bar's close excluded) the entry confirmed from. */
let entryLow = 0;
/** No entries before this seq (a decision seq plus the cooldown). */
let cooldownUntil = -2;
/** Filled buys so far (the presence buy included; the end-of-run flatten is not ours). */
let trades = 0;
/** The entry fill's price; 0 flat. */
let fillPrice = 0n;
/** The highest close since the entry. */
let trailHigh = 0n;
/** The held position is the $1 presence position, not a washout trade. */
let micro = false;
/** The low and the micro flag of the buy currently in flight (applied when it fills). */
let pendingEntryLow = 0;
let pendingMicro = false;

// ---- helpers ------------------------------------------------------------------------------

/** The latest close's drawdown under the running high of the last HIGH_WINDOW closes (bps). */
function dipBps(): number {
  const i = closes.length - 1;
  if (i < 2) return 0;
  let high = 0;
  const from = Math.max(0, i - HIGH_WINDOW + 1);
  for (let j = from; j <= i; j++) if (closes[j] > high) high = closes[j];
  if (high <= 0) return 0;
  return ((high - closes[i]) / high) * 10_000;
}

/**
 * The lowest close of the last `window` closes. With `withLast` the decision bar's own close
 * joins the window (the entry trigger); without it the window stops one bar short, which is
 * the low a decision could have known when it was made (the stop anchor).
 */
function rollingLow(window: number, withLast: boolean): number {
  const i = closes.length - 1;
  const last = withLast ? i : i - 1;
  const from = Math.max(0, last - window + 1);
  let low = Infinity;
  for (let j = from; j <= last; j++) if (closes[j] < low) low = closes[j];
  return low;
}

/** The washout-turn confirmation: a deep dip, a close off the recent low, and rising closes. */
function washoutSignal(): boolean {
  const i = closes.length - 1;
  if (i < 2) return false;
  const dip = dipBps();
  if (dip < DIP_MIN_BPS || dip > DIP_MAX_BPS) return false;
  const low = rollingLow(LOW_WINDOW, true);
  if (!isFinite(low) || closes[i] < low * (1 + TRIGGER_BPS / 10_000)) return false;
  for (let k = 1; k <= UP_CLOSES; k++) if (!(closes[i - k + 1] > closes[i - k])) return false;
  return true;
}

// ---- the bot ------------------------------------------------------------------------------

await runBars({
  onHello(state) {
    seq = state.seq;
  },
  onBatch(state, batch: Batch): OrderInput[] {
    seq = batch.seq;
    const symbol = state.hello.symbols[0]?.symbol ?? SYMBOL;
    const bar = batch.bars.find((b) => b.symbol === symbol) ?? null;
    const close = state.close(symbol);

    // 1) The fills of the last reply: a filled buy opens the position and sets the trade's
    //    anchors; a filled sell starts the cooldown. The account is already folded into `state`.
    for (const f of batch.fills) {
      if (f.symbol !== symbol || f.status !== 'filled') continue;
      if (f.side === 'buy') {
        trades++;
        fillPrice = BigInt(f.price);
        entrySeq = batch.seq;
        trailHigh = close ?? 0n;
        entryLow = pendingEntryLow;
        micro = pendingMicro;
      } else {
        cooldownUntil = batch.seq - 1 + COOLDOWN_BARS;
      }
    }

    // A gap (no bar this minute) leaves the closes as they are: the stale close is the best
    // knowledge there is, and the backtest this bot was tuned in carried no gaps.
    if (bar !== null && close !== null) closes.push(Number(close));
    if (close === null) return [];

    // 2) Decide on this close.
    const held = state.positions.get(symbol);
    let orders: OrderInput[] = [];
    if (held !== undefined && held.qty > 0n) {
      const closeN = Number(close);
      const fillN = Number(fillPrice);
      let exit = false;
      if (!micro) {
        // The stop under the confirmed low, then the take-profit, then the trailing stop.
        if (STOP_LOW_BPS > 0 && entryLow > 0 && closeN <= entryLow * (1 - STOP_LOW_BPS / 10_000)) exit = true;
        else if (TAKE_PROFIT_BPS > 0 && fillN > 0 && closeN >= fillN * (1 + TAKE_PROFIT_BPS / 10_000)) exit = true;
        else if (TRAIL_BPS > 0 && Number(trailHigh) > 0 && closeN <= Number(trailHigh) * (1 - TRAIL_BPS / 10_000)) exit = true;
      } else if (washoutSignal()) {
        exit = true; // a real washout deserves the cash back from the $1 placeholder
      } else if (seq - entrySeq >= 4) {
        exit = true;
      }
      if (exit) orders = [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: EXIT_SLIPPAGE_BPS }];
    } else if (seq > cooldownUntil && trades < MAX_TRADES) {
      if (washoutSignal()) {
        // All-in: the cash and the weight room are the same while flat.
        const notional = state.cash < state.equity ? state.cash : state.equity;
        if (notional >= MIN_NOTIONAL) {
          const knownLow = rollingLow(LOW_WINDOW, false);
          pendingEntryLow = isFinite(knownLow) ? knownLow : 0;
          pendingMicro = false;
          orders = [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: BUY_SLIPPAGE_BPS }];
        }
      } else if (seq >= PRESENCE_SEQ + state.warmupBars && trades === 0 && !micro) {
        const knownLow = rollingLow(LOW_WINDOW, false);
        pendingEntryLow = isFinite(knownLow) ? knownLow : 0;
        pendingMicro = true;
        orders = [{ side: 'buy', symbol, notional_quote_units: MIN_NOTIONAL, max_slippage_bps: BUY_SLIPPAGE_BPS }];
      }
    }

    // 3) Fold this close into the anchors, after the decisions (the trailing high first).
    if (held !== undefined && held.qty > 0n && close > trailHigh) trailHigh = close;

    return orders;
  },
});
