"""
Motore strategie: ICT (Smart Money Concepts), Price Action, e combinata.
Lavora su liste di candele OHLC: [{"open","high","low","close"}, ...] in ordine cronologico.
Ogni funzione *_signal ritorna: {"dir": "BUY"|"SELL"|"WAIT", "score": int, "conf": int, "reasons": [str]}
"""

from typing import List, Dict, Optional


# ───────────────── STRUTTURA DI MERCATO ─────────────────

def detect_swings(candles: List[dict], lookback: int = 2) -> List[dict]:
    """Individua swing high/low locali: un candle è uno swing se è il massimo/minimo
    rispetto a `lookback` candele a sinistra e a destra."""
    swings = []
    n = len(candles)
    for i in range(lookback, n - lookback):
        window = candles[i - lookback:i + lookback + 1]
        hi = candles[i]["high"]
        lo = candles[i]["low"]
        if hi == max(c["high"] for c in window):
            swings.append({"i": i, "type": "high", "price": hi})
        if lo == min(c["low"] for c in window):
            swings.append({"i": i, "type": "low", "price": lo})
    return swings


def market_structure(swings: List[dict]) -> str:
    """Trend dedotto dagli ultimi swing: HH/HL = up, LH/LL = down, altrimenti range."""
    highs = [s for s in swings if s["type"] == "high"][-2:]
    lows = [s for s in swings if s["type"] == "low"][-2:]
    if len(highs) == 2 and len(lows) == 2:
        higher_high = highs[-1]["price"] > highs[-2]["price"]
        higher_low = lows[-1]["price"] > lows[-2]["price"]
        if higher_high and higher_low:
            return "up"
        if not higher_high and not higher_low:
            return "down"
    return "range"


def detect_bos_choch(candles: List[dict], swings: List[dict]) -> Optional[dict]:
    """Break of Structure / Change of Character sull'ultima candela chiusa."""
    if not swings or len(candles) < 3:
        return None
    last_close = candles[-1]["close"]
    prevailing = market_structure(swings)
    recent_high = next((s for s in reversed(swings) if s["type"] == "high"), None)
    recent_low = next((s for s in reversed(swings) if s["type"] == "low"), None)

    if recent_high and last_close > recent_high["price"]:
        kind = "BOS" if prevailing != "down" else "CHoCH"
        return {"dir": "up", "kind": kind, "level": recent_high["price"]}
    if recent_low and last_close < recent_low["price"]:
        kind = "BOS" if prevailing != "up" else "CHoCH"
        return {"dir": "down", "kind": kind, "level": recent_low["price"]}
    return None


# ───────────────── ICT: FVG / ORDER BLOCK / LIQUIDITY ─────────────────

def detect_fvg(candles: List[dict], max_lookback: int = 30) -> List[dict]:
    """Fair Value Gap: gap a 3 candele. Bullish se low[i+1] > high[i-1]; bearish se high[i+1] < low[i-1]."""
    gaps = []
    n = len(candles)
    start = max(1, n - max_lookback)
    for i in range(start, n - 1):
        c0, c2 = candles[i - 1], candles[i + 1]
        if c2["low"] > c0["high"]:
            gaps.append({"i": i, "type": "bullish", "top": c2["low"], "bottom": c0["high"]})
        elif c2["high"] < c0["low"]:
            gaps.append({"i": i, "type": "bearish", "top": c0["low"], "bottom": c2["high"]})
    return gaps


def detect_order_blocks(candles: List[dict], bos: Optional[dict], max_lookback: int = 15) -> List[dict]:
    """Order block: ultima candela opposta al movimento, prima del break di struttura."""
    if not bos:
        return []
    n = len(candles)
    start = max(0, n - max_lookback)
    obs = []
    if bos["dir"] == "up":
        for i in range(n - 2, start, -1):
            if candles[i]["close"] < candles[i]["open"]:  # ultima candela ribassista prima del rialzo
                obs.append({"i": i, "type": "bullish", "top": candles[i]["high"], "bottom": candles[i]["low"]})
                break
    else:
        for i in range(n - 2, start, -1):
            if candles[i]["close"] > candles[i]["open"]:  # ultima candela rialzista prima del ribasso
                obs.append({"i": i, "type": "bearish", "top": candles[i]["high"], "bottom": candles[i]["low"]})
                break
    return obs


def detect_liquidity_sweep(candles: List[dict], swings: List[dict]) -> Optional[dict]:
    """Stop hunt: la candela corrente fa un nuovo estremo oltre uno swing recente,
    ma chiude di nuovo dentro il range precedente (wick di liquidità)."""
    if len(candles) < 3 or not swings:
        return None
    last = candles[-1]
    recent_high = next((s for s in reversed(swings[:-1]) if s["type"] == "high"), None)
    recent_low = next((s for s in reversed(swings[:-1]) if s["type"] == "low"), None)

    if recent_high and last["high"] > recent_high["price"] and last["close"] < recent_high["price"]:
        return {"type": "sell_side_swept", "level": recent_high["price"]}
    if recent_low and last["low"] < recent_low["price"] and last["close"] > recent_low["price"]:
        return {"type": "buy_side_swept", "level": recent_low["price"]}
    return None


def ict_signal(candles: List[dict]) -> Dict:
    if len(candles) < 25:
        return {"dir": "WAIT", "score": 0, "conf": 0, "reasons": ["Poche candele"]}

    swings = detect_swings(candles)
    bos = detect_bos_choch(candles, swings)
    fvgs = detect_fvg(candles)
    obs = detect_order_blocks(candles, bos)
    sweep = detect_liquidity_sweep(candles, swings)
    price = candles[-1]["close"]

    score = 0
    reasons = []

    if bos:
        score += 3 if bos["kind"] == "BOS" else 2
        reasons.append(f"{bos['kind']} {bos['dir']} @ {bos['level']:.2f}")

    bias = bos["dir"] if bos else None

    if bias:
        # price inside an FVG in the direction of bias?
        aligned_fvgs = [g for g in fvgs if g["type"] == ("bullish" if bias == "up" else "bearish")]
        for g in aligned_fvgs[-3:]:
            if g["bottom"] <= price <= g["top"]:
                score += 2
                reasons.append(f"Prezzo dentro FVG {g['type']}")
                break

        aligned_obs = [o for o in obs if o["type"] == ("bullish" if bias == "up" else "bearish")]
        for o in aligned_obs:
            if o["bottom"] <= price <= o["top"]:
                score += 2
                reasons.append(f"Prezzo dentro order block {o['type']}")
                break

    if sweep:
        if sweep["type"] == "buy_side_swept" and bias == "up":
            score += 2
            reasons.append(f"Liquidity sweep sotto {sweep['level']:.2f} poi rialzo")
        elif sweep["type"] == "sell_side_swept" and bias == "down":
            score += 2
            reasons.append(f"Liquidity sweep sopra {sweep['level']:.2f} poi ribasso")

    if not bias:
        return {"dir": "WAIT", "score": 0, "conf": 0, "reasons": ["Nessun BOS/CHoCH recente"]}

    direction = "BUY" if bias == "up" else "SELL"
    if score < 4:
        direction = "WAIT"
    conf = min(100, round(score / 9 * 100))
    return {"dir": direction, "score": score, "conf": conf, "reasons": reasons}


# ───────────────── PRICE ACTION ─────────────────

def candle_pattern(c_prev: dict, c: dict) -> Optional[str]:
    body = abs(c["close"] - c["open"])
    rng = c["high"] - c["low"] or 1e-9
    upper_wick = c["high"] - max(c["close"], c["open"])
    lower_wick = min(c["close"], c["open"]) - c["low"]

    prev_body = abs(c_prev["close"] - c_prev["open"])
    bullish = c["close"] > c["open"]
    prev_bullish = c_prev["close"] > c_prev["open"]

    # Engulfing
    if bullish and not prev_bullish and c["close"] >= c_prev["open"] and c["open"] <= c_prev["close"]:
        return "bullish_engulfing"
    if not bullish and prev_bullish and c["open"] >= c_prev["close"] and c["close"] <= c_prev["open"]:
        return "bearish_engulfing"

    # Pin bar / hammer / shooting star (wick >= 2x body, corpo piccolo)
    if body / rng < 0.35:
        if lower_wick / rng > 0.55 and upper_wick / rng < 0.2:
            return "bullish_pinbar"
        if upper_wick / rng > 0.55 and lower_wick / rng < 0.2:
            return "bearish_pinbar"
    return None


def support_resistance(candles: List[dict], swings: List[dict], price: float, tol_pct: float = 0.0015):
    for s in reversed(swings):
        if abs(s["price"] - price) / price <= tol_pct:
            return s
    return None


def price_action_signal(candles: List[dict]) -> Dict:
    if len(candles) < 20:
        return {"dir": "WAIT", "score": 0, "conf": 0, "reasons": ["Poche candele"]}

    swings = detect_swings(candles)
    trend = market_structure(swings)
    price = candles[-1]["close"]
    pattern = candle_pattern(candles[-2], candles[-1])
    level = support_resistance(candles, swings, price)

    score = 0
    reasons = []

    if trend == "up":
        score += 2
        reasons.append("Struttura rialzista (HH/HL)")
    elif trend == "down":
        score -= 2
        reasons.append("Struttura ribassista (LH/LL)")

    if pattern:
        reasons.append(f"Pattern candela: {pattern}")
        if "bullish" in pattern:
            score += 2
        elif "bearish" in pattern:
            score -= 2

    if level:
        reasons.append(f"Prezzo vicino a livello {level['type']} @ {level['price']:.2f}")
        if level["type"] == "low" and pattern and "bullish" in pattern:
            score += 2
        elif level["type"] == "high" and pattern and "bearish" in pattern:
            score -= 2

    direction = "BUY" if score >= 4 else "SELL" if score <= -4 else "WAIT"
    conf = min(100, round(abs(score) / 6 * 100))
    return {"dir": direction, "score": score, "conf": conf, "reasons": reasons}


# ───────────────── COMBINATA ─────────────────

def combined_signal(candles: List[dict]) -> Dict:
    ict = ict_signal(candles)
    pa = price_action_signal(candles)

    reasons = [f"[ICT] {r}" for r in ict["reasons"]] + [f"[PA] {r}" for r in pa["reasons"]]

    if ict["dir"] == "WAIT" or pa["dir"] == "WAIT":
        # richiede accordo tra le due — se una tace, si aspetta
        agree_score = 0
    elif ict["dir"] == pa["dir"]:
        agree_score = ict["score"] + pa["score"]
    else:
        agree_score = 0  # in disaccordo → nessun trade

    if ict["dir"] == pa["dir"] and ict["dir"] != "WAIT":
        direction = ict["dir"]
    else:
        direction = "WAIT"

    conf = min(100, round(abs(agree_score) / 15 * 100)) if direction != "WAIT" else 0
    return {"dir": direction, "score": agree_score, "conf": conf, "reasons": reasons}


STRATEGIES = {
    "ict": ict_signal,
    "price_action": price_action_signal,
    "combined": combined_signal,
}
