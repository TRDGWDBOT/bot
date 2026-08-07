"""
XAUBot — FastAPI backend
Maintains a persistent WebSocket connection to Deriv API for 24/7 auto-trading.
Exposes REST endpoints for the PWA dashboard.
"""
import asyncio
import json
import os
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Optional, Any
from urllib.parse import quote

import websockets
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import certifi
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

import strategies

# ───────────────── ENV ─────────────────
load_dotenv()
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
DEFAULT_APP_ID = os.environ.get("DERIV_DEFAULT_APP_ID", "1089")

# ───────────────── WATCHLIST (oro, forex, cripto, indici) ─────────────────
# Chiave = nome breve mostrato in UI, valore = simbolo Deriv.
# Se un simbolo non è tra gli active_symbols del conto, viene scartato automaticamente
# (log di avviso) invece di rompere la connessione.
SYMBOLS = {
    "XAUUSD": "frxXAUUSD",
    "XAGUSD": "frxXAGUSD",
    "EURUSD": "frxEURUSD",
    "GBPUSD": "frxGBPUSD",
    "USDJPY": "frxUSDJPY",
    "AUDUSD": "frxAUDUSD",
    "USDCAD": "frxUSDCAD",
    "USDCHF": "frxUSDCHF",
    "NZDUSD": "frxNZDUSD",
    "BTCUSD": "cryBTCUSD",
    "ETHUSD": "cryETHUSD",
    "LTCUSD": "cryLTCUSD",
    "XRPUSD": "cryXRPUSD",
    "US500": "OTC_SPC",
    "US100": "OTC_NDX",
    "US30": "OTC_DJI",
    "GER40": "OTC_GDAXI",
    "UK100": "OTC_FTSE",
    "JPN225": "OTC_N225",
}
STRATEGY_NAMES = ("ict", "price_action", "combined", "indicators")
VALID_MULTIPLIERS = (100, 200, 300, 500, 800)
SYMBOL_TO_NAME = {v: k for k, v in SYMBOLS.items()}

# ───────────────── MONGO ─────────────────
mongo_client: AsyncIOMotorClient = AsyncIOMotorClient(MONGO_URL, tls=True, tlsCAFile=certifi.where())
db = mongo_client[DB_NAME]

# ───────────────── INDICATORS (port from JS) ─────────────────
def ema(arr, n):
    if not arr:
        return None
    k = 2 / (n + 1)
    e = arr[0]
    for v in arr[1:]:
        e = v * k + e * (1 - k)
    return e

def rsi(closes, n=14):
    if len(closes) < n + 1:
        return 50.0
    g = l = 0.0
    for i in range(len(closes) - n, len(closes)):
        d = closes[i] - closes[i - 1]
        if d > 0:
            g += d
        else:
            l += abs(d)
    rs = (g / n) / ((l / n) or 0.001)
    return 100 - 100 / (1 + rs)

def atr(cs, n=14):
    if len(cs) < 2:
        return 0.0
    trs = []
    for i in range(1, len(cs)):
        H, L, C = cs[i]["high"], cs[i]["low"], cs[i - 1]["close"]
        trs.append(max(H - L, abs(H - C), abs(L - C)))
    last = trs[-n:]
    return sum(last) / len(last) if last else 0.0

def bollinger(closes, n=20, k=2):
    sl = closes[-n:]
    m = sum(sl) / len(sl)
    std = (sum((b - m) ** 2 for b in sl) / len(sl)) ** 0.5
    return {"up": m + k * std, "mid": m, "dn": m - k * std}

def stoch_k(cs, n=5):
    sl = cs[-n:]
    h = max(c["high"] for c in sl)
    l = min(c["low"] for c in sl)
    if h == l:
        return 50.0
    return (sl[-1]["close"] - l) / (h - l) * 100

def compute_indicators(cs):
    if not cs or len(cs) < 30:
        return None
    closes = [c["close"] for c in cs]
    E9 = ema(closes[-30:], 9)
    E21 = ema(closes[-40:], 21)
    E50 = ema(closes[-60:], 50) if len(closes) >= 60 else E21
    RSI = rsi(closes)
    MACD = E9 - E21
    ms = []
    for i in range(10, len(closes)):
        e9_i = ema(closes[max(0, i - 30):i], 9)
        e21_i = ema(closes[max(0, i - 40):i], 21)
        ms.append(e9_i - e21_i)
    macd_hist = MACD - (ema(ms[-9:], 9) if len(ms) >= 9 else MACD)
    MOM = closes[-1] - closes[-6] if len(closes) >= 6 else 0
    ATR = atr(cs)
    BB = bollinger(closes)
    SK = stoch_k(cs)
    return {
        "E9": E9, "E21": E21, "E50": E50,
        "RSI": RSI, "MACD": MACD, "macdHist": macd_hist,
        "MOM": MOM, "ATR": ATR, "BB": BB, "SK": SK,
        "price": closes[-1],
    }

def score_signal(ind):
    s = 0
    r = ind["RSI"]
    if r < 30: s += 3
    elif r < 40: s += 2
    elif r < 48: s += 1
    elif r > 70: s -= 3
    elif r > 60: s -= 2
    elif r > 52: s -= 1
    s += 2 if ind["E9"] > ind["E21"] else -2
    s += 1 if ind["E21"] > ind["E50"] else -1
    mh = ind["macdHist"]
    if mh > 0.10: s += 2
    elif mh > 0: s += 1
    elif mh < -0.10: s -= 2
    elif mh < 0: s -= 1
    if ind["MOM"] > 0.5: s += 1
    if ind["MOM"] < -0.5: s -= 1
    if ind["price"] < ind["BB"]["dn"]: s += 1
    if ind["price"] > ind["BB"]["up"]: s -= 1
    direction = "BUY" if s >= 4 else "SELL" if s <= -4 else "WAIT"
    conf = min(100, round(abs(s) / 11 * 100))
    return {"dir": direction, "score": s, "conf": conf}

def in_session():
    h = datetime.now(timezone.utc).hour
    return 7 <= h < 17

def check_filters(atr_val):
    if atr_val < 0.5:
        return False, "Mercato piatto (ATR basso)"
    if not in_session():
        return False, f"Fuori sessione UTC {datetime.now(timezone.utc).hour}h"
    return True, ""

# ───────────────── DERIV CLIENT ─────────────────
class DerivClient:
    """Persistent Deriv WebSocket client. Single-user MVP."""

    def __init__(self):
        self.ws = None
        self.task: Optional[asyncio.Task] = None
        self.token: Optional[str] = None
        self.app_id: str = DEFAULT_APP_ID
        self.env: str = "demo"
        self.active_symbol = "frxXAUUSD"   # simbolo su cui opera l'auto-trading
        self.strategy = "combined"          # "ict" | "price_action" | "combined" | "indicators"
        self.watchlist: list[str] = []      # simboli Deriv realmente disponibili sul conto
        self.req_id = 100
        self.pending: dict[int, asyncio.Future] = {}
        self.connected = False
        self.authorized = False
        self.last_error: Optional[str] = None
        self.loginid: Optional[str] = None
        self.currency: str = "USD"
        self.balance: float = 0.0
        self.account_type: str = "demo"
        # Stato di mercato per simbolo: {symbol: {candles, minute_buffer, last_minute_ts,
        #                                          bid, ask, price, spread, signals: {strategy: {...}}}}
        self.markets: dict[str, dict] = {}
        # Segnale/confirm-counter per il simbolo+strategia attivi (usati per l'auto-trading)
        self.pending_dir = "WAIT"
        self.pending_count = 0
        self.confirm_need = 5
        self.entry = self.tp = self.sl = 0.0
        self.filter_ok = False
        self.filter_reason = "Connessione..."
        # Trading state
        self.auto_mode = False
        self.last_auto_dir: Optional[str] = None
        self.open_contracts: dict[int, dict] = {}
        self.contracts_subscribed: set[int] = set()
        self.pending_trade_meta: dict[int, dict] = {}  # contract_id -> {source, symbol, strategy, direction, stake, multiplier}
        self.auto_closing: set[int] = set()  # contratti per cui è già stata inviata una richiesta di chiusura (evita doppioni)
        # Take-profit / stop-loss automatici per i contratti aperti dall'AUTO (% dello stake investito)
        self.auto_tp_pct: float = 20.0
        self.auto_sl_pct: float = 10.0
        # Parametri auto-trading (configurabili dall'utente)
        self.auto_stake: float = 1.0
        self.auto_multiplier: int = 100
        self.max_open_positions: int = 3
        self.auto_multi_symbol: bool = True  # se True, l'auto-trading opera su TUTTA la watchlist, non solo sul simbolo attivo
        # Stats
        self.session_pnl = 0.0
        self.trades_total = 0
        self.trades_win = 0
        self.profit_total = 0.0
        self.auto_trades_total = 0
        self.auto_trades_win = 0
        self.manual_trades_total = 0
        self.manual_trades_win = 0
        # Logs (ring buffer)
        self.logs = deque(maxlen=200)

    def _market(self, symbol: str) -> dict:
        if symbol not in self.markets:
            self.markets[symbol] = {
                "candles": [], "minute_buffer": [], "last_minute_ts": 0,
                "bid": 0.0, "ask": 0.0, "price": 0.0, "spread": 0.0,
                "signals": {},
                "pending_dir": "WAIT", "pending_count": 0, "last_auto_dir": None,
            }
        return self.markets[symbol]

    def log(self, level: str, msg: str):
        ts = datetime.now(timezone.utc).isoformat()
        entry = {"ts": ts, "level": level, "msg": msg}
        self.logs.appendleft(entry)
        print(f"[{level}] {msg}")

    async def configure(self, token: str, app_id: str, env: str, active_symbol: Optional[str] = None, strategy: Optional[str] = None):
        self.token = token
        self.app_id = app_id or DEFAULT_APP_ID
        self.env = env
        if active_symbol:
            self.active_symbol = active_symbol
        if strategy:
            self.strategy = strategy
        self.last_error = None
        # Persist
        await db.config.update_one(
            {"_id": "main"},
            {"$set": {
                "token": token, "app_id": self.app_id, "env": env,
                "active_symbol": self.active_symbol, "strategy": self.strategy,
            }},
            upsert=True,
        )
        await self.restart()

    async def load_persisted_config(self):
        cfg = await db.config.find_one({"_id": "main"})
        if cfg and cfg.get("token"):
            self.token = cfg["token"]
            self.app_id = cfg.get("app_id") or DEFAULT_APP_ID
            self.env = cfg.get("env", "demo")
            self.active_symbol = cfg.get("active_symbol", self.active_symbol)
            self.strategy = cfg.get("strategy", self.strategy)
            self.auto_mode = cfg.get("auto_mode", False)
            self.auto_stake = cfg.get("auto_stake", self.auto_stake)
            self.auto_multiplier = cfg.get("auto_multiplier", self.auto_multiplier)
            self.max_open_positions = cfg.get("max_open_positions", self.max_open_positions)
            self.auto_multi_symbol = cfg.get("auto_multi_symbol", self.auto_multi_symbol)
            self.auto_tp_pct = cfg.get("auto_tp_pct", self.auto_tp_pct)
            self.auto_sl_pct = cfg.get("auto_sl_pct", self.auto_sl_pct)
            self.log("I", f"Config caricata da DB (env={self.env}, symbol={self.active_symbol}, strategy={self.strategy})")
            asyncio.create_task(self._run_loop())

    async def restart(self):
        # Stop existing
        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        if self.ws:
            try:
                await self.ws.close()
            except Exception:
                pass
        self.connected = False
        self.authorized = False
        # Start new
        self.task = asyncio.create_task(self._run_loop())

    async def _get_otp_url(self) -> str:
        """REST: crea/recupera il conto, poi ottiene un URL WS pre-autenticato via OTP."""
        headers = {
            "Deriv-App-ID": self.app_id,
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=15) as client:
            acc_resp = await client.post(
                "https://api.derivws.com/trading/v1/options/accounts",
                headers=headers,
                json={"currency": "USD", "group": "row", "account_type": self.env},
            )
            if acc_resp.status_code >= 400:
                raise RuntimeError(f"Conto: {acc_resp.status_code} — {acc_resp.text[:200]}")
            acc_data = acc_resp.json()
            acc = acc_data["data"][0] if isinstance(acc_data.get("data"), list) else acc_data["data"]
            self.loginid = acc.get("account_id")
            self.currency = acc.get("currency", "USD")
            self.balance = float(acc.get("balance", 0) or 0)
            self.account_type = self.env

            otp_resp = await client.post(
                f"https://api.derivws.com/trading/v1/options/accounts/{self.loginid}/otp",
                headers=headers,
            )
            if otp_resp.status_code >= 400:
                raise RuntimeError(f"OTP: {otp_resp.status_code} — {otp_resp.text[:200]}")
            otp_data = otp_resp.json()
            url = otp_data.get("data", {}).get("url")
            if not url:
                raise RuntimeError("URL WebSocket mancante nella risposta OTP")
            return url

    async def _run_loop(self):
        backoff = 2
        while True:
            if not self.token:
                await asyncio.sleep(2)
                continue
            try:
                self.log("I", "Recupero conto e OTP via REST...")
                url = await self._get_otp_url()
                self.log("S", f"Conto {self.loginid} ({self.account_type}) saldo={self.balance}{self.currency}")
                async with websockets.connect(url, ping_interval=None) as ws:
                    self.ws = ws
                    self.connected = True
                    self.authorized = True  # l'OTP autentica già la connessione
                    self.last_error = None
                    backoff = 2
                    self.log("S", "WebSocket connesso (OTP)")

                    async def _keepalive():
                        while True:
                            await asyncio.sleep(20)
                            try:
                                await self._send_no_wait({"ping": 1})
                            except Exception:
                                return

                    async def _receive_loop():
                        async for raw in ws:
                            try:
                                msg = json.loads(raw)
                            except Exception:
                                continue
                            await self._handle(msg)

                    # IMPORTANTE: il receive loop deve partire PRIMA di qualunque chiamata
                    # che aspetta una risposta (_send). Altrimenti nessuno "ascolta" i
                    # messaggi in arrivo e ogni richiesta va in timeout — è il bug che
                    # causava sia gli ordini automatici falliti sia lo storico mai caricato.
                    keepalive_task = asyncio.create_task(_keepalive())
                    receive_task = asyncio.create_task(_receive_loop())

                    try:
                        # Subscriptions account-level
                        await self._send_no_wait({"balance": 1, "subscribe": 1})
                        await self._send_no_wait({"proposal_open_contract": 1, "subscribe": 1})

                        # Valida la watchlist contro i simboli davvero disponibili sul conto
                        try:
                            active = await self._send({"active_symbols": "brief"}, timeout=25)
                            available = {s["symbol"] for s in active.get("active_symbols", [])}
                            self.watchlist = []
                            for name, deriv_sym in SYMBOLS.items():
                                if deriv_sym in available:
                                    self.watchlist.append(deriv_sym)
                                else:
                                    self.log("W", f"Simbolo non disponibile sul conto, saltato: {name} ({deriv_sym})")
                        except Exception as e:
                            self.log("W", f"active_symbols non risposto ({e}) — uso lista completa")
                            self.watchlist = list(SYMBOLS.values())

                        if self.active_symbol not in self.watchlist and self.watchlist:
                            self.log("W", f"Simbolo attivo {self.active_symbol} non disponibile, passo a {self.watchlist[0]}")
                            self.active_symbol = self.watchlist[0]

                        # Storico + subscribe ticks per ogni simbolo della watchlist
                        # (ogni simbolo è isolato: se uno fallisce/non risponde, si salta senza
                        #  far cadere l'intera connessione)
                        ok_count = 0
                        for sym in self.watchlist:
                            m = self._market(sym)
                            try:
                                await self._send_no_wait({"ticks": sym, "subscribe": 1})
                                hist = await self._send({
                                    "ticks_history": sym,
                                    "adjust_start_time": 1,
                                    "count": 120,
                                    "end": "latest",
                                    "start": 1,
                                    "style": "candles",
                                    "granularity": 60,
                                }, timeout=8)
                                if hist.get("candles"):
                                    m["candles"] = [
                                        {"open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"]}
                                        for c in hist["candles"]
                                    ]
                                    ok_count += 1
                            except asyncio.TimeoutError:
                                self.log("W", f"Storico {sym}: timeout, salto (riproverà sui tick live)")
                            except Exception as e:
                                self.log("W", f"Storico {sym}: {e}")
                        self.log("S", f"Watchlist attiva: {len(self.watchlist)} simboli — storico caricato per {ok_count}")

                        # Ora restiamo in attesa finché il receive loop non termina
                        # (disconnessione, errore, ecc.)
                        await receive_task
                    finally:
                        keepalive_task.cancel()
                        receive_task.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.connected = False
                self.authorized = False
                self.last_error = str(e) or repr(e)
                self.log("E", f"Connessione fallita: {self.last_error}")
                await asyncio.sleep(backoff)
                backoff = min(60, backoff * 2)

    async def _send(self, payload: dict, timeout: float = 15):
        if not self.ws:
            raise RuntimeError("WS non connesso")
        self.req_id += 1
        rid = self.req_id
        payload["req_id"] = rid
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        await self.ws.send(json.dumps(payload))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self.pending.pop(rid, None)

    async def _send_no_wait(self, payload: dict):
        if not self.ws:
            return
        self.req_id += 1
        payload["req_id"] = self.req_id
        await self.ws.send(json.dumps(payload))

    async def _handle(self, msg: dict):
        rid = msg.get("req_id")
        if rid in self.pending:
            self.pending[rid].set_result(msg)
            # Continue: subscription messages also carry req_id (resolves once + keeps coming)
        if msg.get("error"):
            err_msg = msg["error"].get("message", "?")
            echo = msg.get("echo_req", {}) or {}
            sym_ctx = echo.get("ticks") or echo.get("ticks_history") or echo.get("underlying_symbol")
            label = SYMBOL_TO_NAME.get(sym_ctx, sym_ctx) if sym_ctx else None
            self.log("E", f"API err [{label}]: {err_msg}" if label else f"API err: {err_msg}")
        mt = msg.get("msg_type")
        if mt == "tick":
            t = msg.get("tick", {})
            sym = t.get("symbol")
            if not sym:
                return
            m = self._market(sym)
            m["bid"] = float(t.get("bid", 0) or 0)
            m["ask"] = float(t.get("ask", 0) or 0)
            m["price"] = (m["bid"] + m["ask"]) / 2 if m["bid"] and m["ask"] else float(t.get("quote", 0) or 0)
            m["spread"] = m["ask"] - m["bid"]
            self._update_pseudo_candle(sym, m["price"])
            await self._maybe_signal(sym)
        elif mt == "balance":
            b = msg.get("balance", {})
            self.balance = float(b.get("balance", self.balance))
            self.currency = b.get("currency", self.currency)
        elif mt == "proposal_open_contract":
            poc = msg.get("proposal_open_contract")
            if poc and poc.get("contract_id"):
                cid = poc["contract_id"]
                if poc.get("is_sold"):
                    if cid in self.open_contracts:
                        profit = float(poc.get("profit", 0))
                        meta = self.pending_trade_meta.pop(cid, {})
                        source = meta.get("source", "manual")
                        if profit >= 0:
                            self.trades_win += 1
                            if source == "auto":
                                self.auto_trades_win += 1
                            else:
                                self.manual_trades_win += 1
                        self.profit_total = round(self.profit_total + profit, 2)
                        self.session_pnl = round(self.session_pnl + profit, 2)
                        self.log("S" if profit >= 0 else "E", f"Chiuso {cid}: {profit:+.2f} {self.currency} ({source})")
                        await db.trades.update_one(
                            {"contract_id": cid},
                            {"$set": {
                                "status": "closed",
                                "profit": profit,
                                "sell_price": poc.get("sell_price"),
                                "closed_at": datetime.now(timezone.utc).isoformat(),
                            }},
                        )
                        self.open_contracts.pop(cid, None)
                        self.auto_closing.discard(cid)
                else:
                    self.open_contracts[cid] = poc
                    # Take-profit / stop-loss automatico: solo per i contratti aperti dall'AUTO
                    meta = self.pending_trade_meta.get(cid)
                    if meta and meta.get("source") == "auto" and cid not in self.auto_closing:
                        stake_c = meta.get("stake") or 1
                        profit = float(poc.get("profit", 0))
                        profit_pct = (profit / stake_c) * 100 if stake_c else 0
                        if profit_pct >= self.auto_tp_pct or profit_pct <= -self.auto_sl_pct:
                            self.auto_closing.add(cid)
                            reason = "TP" if profit_pct >= self.auto_tp_pct else "SL"
                            self.log("S", f"AUTO {reason} #{cid}: {profit_pct:+.1f}% — chiudo")
                            # Come per l'apertura: non fare "await" qui dentro il receive loop,
                            # altrimenti la richiesta di vendita resterebbe in attesa di una
                            # risposta che questo stesso loop, bloccato, non potrebbe mai leggere.
                            asyncio.create_task(self._auto_close_task(cid))

    async def _auto_close_task(self, contract_id: int):
        try:
            await self.close_contract(contract_id)
        except Exception as e:
            self.log("E", f"AUTO close fallita #{contract_id}: {e}")
            self.auto_closing.discard(contract_id)

    def _update_pseudo_candle(self, symbol: str, price: float):
        m = self._market(symbol)
        now_ms = int(time.time() * 1000)
        minute_ts = (now_ms // 60000) * 60000
        if not m["last_minute_ts"] or minute_ts > m["last_minute_ts"]:
            if m["last_minute_ts"] and m["minute_buffer"]:
                m["candles"].append({
                    "open": m["minute_buffer"][0],
                    "high": max(m["minute_buffer"]),
                    "low": min(m["minute_buffer"]),
                    "close": m["minute_buffer"][-1],
                })
                if len(m["candles"]) > 200:
                    m["candles"].pop(0)
            m["last_minute_ts"] = minute_ts
            m["minute_buffer"] = [price]
        else:
            m["minute_buffer"].append(price)
            if m["candles"]:
                last = m["candles"][-1]
                last["high"] = max(last["high"], price)
                last["low"] = min(last["low"], price)
                last["close"] = price

    async def _maybe_signal(self, symbol: str):
        m = self._market(symbol)
        candles = m["candles"]
        if len(candles) < 25:
            return

        # Calcola tutte e 3 le strategie per questo simbolo (utile per confronto in UI)
        m["signals"] = {
            "ict": strategies.ict_signal(candles),
            "price_action": strategies.price_action_signal(candles),
            "combined": strategies.combined_signal(candles),
        }
        # Compat: indicatori legacy, disponibili come 4a opzione
        ind = compute_indicators(candles)
        if ind:
            m["signals"]["indicators"] = score_signal(ind)
            m["indicators"] = ind

        # Il grafico/segnale mostrato "in primo piano" nell'app resta quello del simbolo attivo;
        # qui sotto aggiorniamo entry/tp/sl/filtro solo per quello, per la UI principale.
        if symbol == self.active_symbol:
            sig_display = m["signals"].get(self.strategy) or {"dir": "WAIT", "score": 0, "conf": 0}
            ok_d, reason_d = check_filters(ind["ATR"] if ind else 1.0)
            self.filter_ok = ok_d
            self.filter_reason = reason_d
            price = m["price"]
            d_display = sig_display["dir"]
            self.entry = price if d_display != "WAIT" else 0.0
            tp_p, sl_p = 10, 5
            self.tp = (self.entry + tp_p * 0.01) if d_display == "BUY" else (self.entry - tp_p * 0.01) if d_display == "SELL" else 0.0
            self.sl = (self.entry - sl_p * 0.01) if d_display == "BUY" else (self.entry + sl_p * 0.01) if d_display == "SELL" else 0.0

        # L'auto-trading, se "multi-simbolo" è attivo, valuta OGNI simbolo della watchlist
        # in modo indipendente (ognuno col proprio contatore di conferma); altrimenti si
        # limita al solo simbolo attivo.
        if not (symbol == self.active_symbol or self.auto_multi_symbol):
            return

        sig = m["signals"].get(self.strategy) or {"dir": "WAIT", "score": 0, "conf": 0}
        d = sig["dir"]
        if d == m["pending_dir"]:
            m["pending_count"] += 1
        else:
            m["pending_dir"] = d
            m["pending_count"] = 1
        confirmed = m["pending_count"] >= self.confirm_need

        ok, reason = check_filters(ind["ATR"] if ind else 1.0)

        m["signals"][self.strategy] = {
            **sig,
            "confirmed": confirmed,
            "pending": m["pending_count"],
        }

        if self.auto_mode and confirmed and ok and d != "WAIT" and d != m["last_auto_dir"]:
            if len(self.open_contracts) < self.max_open_positions:
                self.log("S", f"AUTO trigger [{self.strategy}] {symbol}: {d} (score={sig['score']}, conf={sig['conf']}%)")
                m["last_auto_dir"] = d
                # IMPORTANTE: non fare "await" qui. Questo codice gira dentro il loop che
                # riceve i messaggi WebSocket — se aspettassimo qui la risposta dell'ordine,
                # il loop si bloccherebbe e non potrebbe mai ricevere quella risposta
                # (si va in timeout ogni volta). Lo lanciamo come task indipendente.
                asyncio.create_task(self._auto_order_task(d, symbol))

    async def _auto_order_task(self, direction: str, symbol: str):
        try:
            await self.place_order(direction, stake=self.auto_stake, multiplier=self.auto_multiplier, symbol=symbol, source="auto", strategy=self.strategy)
        except Exception as e:
            self.log("E", f"AUTO order fallito: {e or repr(e)}")

    async def place_order(self, direction: str, stake: float = 1.0, multiplier: int = 100, symbol: Optional[str] = None, source: str = "manual", strategy: Optional[str] = None):
        if not self.authorized:
            raise RuntimeError("Non autenticato")
        if multiplier not in VALID_MULTIPLIERS:
            # Arrotonda al valore valido più vicino invece di far fallire l'ordine
            multiplier = min(VALID_MULTIPLIERS, key=lambda v: abs(v - multiplier))
        sym = symbol or self.active_symbol
        contract_type = "MULTUP" if direction == "BUY" else "MULTDOWN"

        # Step 1: proposal — chiede un preventivo per il contratto
        # NB: su questa versione dell'API il campo si chiama "underlying_symbol", non "symbol"
        prop_payload = {
            "proposal": 1,
            "amount": stake,
            "basis": "stake",
            "contract_type": contract_type,
            "currency": self.currency,
            "underlying_symbol": sym,
            "multiplier": multiplier,
        }
        prop_resp = await self._send(prop_payload, timeout=15)
        if prop_resp.get("error"):
            raise RuntimeError(prop_resp["error"].get("message", "Errore proposal"))
        proposal_id = prop_resp.get("proposal", {}).get("id")
        if not proposal_id:
            raise RuntimeError("Proposal senza id nella risposta")

        # Step 2: buy — acquista usando l'id del preventivo appena ottenuto
        buy_resp = await self._send({"buy": proposal_id, "price": stake}, timeout=15)
        if buy_resp.get("error"):
            raise RuntimeError(buy_resp["error"].get("message", "Errore ordine"))
        buy = buy_resp.get("buy", {})
        cid = buy.get("contract_id")
        self.trades_total += 1
        if source == "auto":
            self.auto_trades_total += 1
        else:
            self.manual_trades_total += 1
        self.log("S", f"Ordine {direction} #{cid} aperto a ${buy.get('buy_price')} ({source})")

        if cid:
            self.pending_trade_meta[cid] = {
                "source": source, "symbol": sym, "strategy": strategy or self.strategy,
                "direction": direction, "stake": stake, "multiplier": multiplier,
            }
            await db.trades.insert_one({
                "_id": str(uuid.uuid4()),
                "contract_id": cid,
                "source": source,
                "symbol": sym,
                "strategy": strategy or self.strategy,
                "direction": direction,
                "stake": stake,
                "multiplier": multiplier,
                "buy_price": buy.get("buy_price"),
                "status": "open",
                "opened_at": datetime.now(timezone.utc).isoformat(),
            })
            # Subscribe to specific contract for updates
            await self._send_no_wait({"proposal_open_contract": 1, "contract_id": cid, "subscribe": 1})
        return {"contract_id": cid, "buy_price": buy.get("buy_price")}

    async def close_contract(self, contract_id: int):
        resp = await self._send({"sell": int(contract_id), "price": 0}, timeout=20)
        if resp.get("error"):
            raise RuntimeError(resp["error"]["message"])
        return resp.get("sell", {})

    async def close_all(self):
        ids = list(self.open_contracts.keys())
        results = []
        for cid in ids:
            try:
                r = await self.close_contract(cid)
                results.append({"contract_id": cid, "ok": True, "sold_for": r.get("sold_for")})
            except Exception as e:
                results.append({"contract_id": cid, "ok": False, "error": str(e)})
        for mk in self.markets.values():
            mk["last_auto_dir"] = None
        return results

    def get_state(self):
        active_m = self._market(self.active_symbol)
        return {
            "connected": self.connected,
            "authorized": self.authorized,
            "configured": bool(self.token),
            "last_error": self.last_error,
            "loginid": self.loginid,
            "currency": self.currency,
            "balance": self.balance,
            "env": self.env,
            "account_type": self.account_type,
            "active_symbol": self.active_symbol,
            "strategy": self.strategy,
            "watchlist": self.watchlist,
            "bid": active_m["bid"], "ask": active_m["ask"], "price": active_m["price"], "spread": active_m["spread"],
            "candles_count": len(active_m["candles"]),
            "indicators": active_m.get("indicators", {}),
            "signal": active_m["signals"].get(self.strategy, {"dir": "WAIT", "score": 0, "conf": 0}),
            "entry": self.entry, "tp": self.tp, "sl": self.sl,
            "filter_ok": self.filter_ok,
            "filter_reason": self.filter_reason,
            "confirm_need": self.confirm_need,
            "auto_mode": self.auto_mode,
            "markets": {
                sym: {
                    "price": mk["price"], "bid": mk["bid"], "ask": mk["ask"], "spread": mk["spread"],
                    "candles_count": len(mk["candles"]),
                    "signals": mk["signals"],
                }
                for sym, mk in self.markets.items()
            },
            "positions": [
                {
                    "contract_id": p.get("contract_id"),
                    "contract_type": p.get("contract_type"),
                    "buy_price": p.get("buy_price"),
                    "profit": p.get("profit", 0),
                    "current_spot": p.get("current_spot"),
                    "entry_spot": p.get("entry_spot"),
                }
                for p in self.open_contracts.values()
            ],
            "auto_stake": self.auto_stake,
            "auto_multi_symbol": self.auto_multi_symbol,
            "auto_tp_pct": self.auto_tp_pct,
            "auto_sl_pct": self.auto_sl_pct,
            "auto_multiplier": self.auto_multiplier,
            "max_open_positions": self.max_open_positions,
            "valid_multipliers": VALID_MULTIPLIERS,
            "stats": {
                "trades_total": self.trades_total,
                "trades_win": self.trades_win,
                "profit_total": self.profit_total,
                "session_pnl": self.session_pnl,
                "auto_trades_total": self.auto_trades_total,
                "auto_trades_win": self.auto_trades_win,
                "manual_trades_total": self.manual_trades_total,
                "manual_trades_win": self.manual_trades_win,
            },
            "logs": list(self.logs)[:60],
        }


client = DerivClient()

# ───────────────── FASTAPI ─────────────────
app = FastAPI(title="TRDGWDBOT API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup():
    await client.load_persisted_config()


class ConfigBody(BaseModel):
    token: str = Field(..., min_length=4)
    app_id: str = Field(default=DEFAULT_APP_ID)
    env: str = Field(default="demo")
    active_symbol: Optional[str] = None
    strategy: Optional[str] = None


class OrderBody(BaseModel):
    direction: str  # BUY / SELL
    stake: float = 1.0
    multiplier: int = 100
    symbol: Optional[str] = None


class AutoBody(BaseModel):
    enabled: bool


class AutoSettingsBody(BaseModel):
    auto_stake: Optional[float] = None
    auto_multiplier: Optional[int] = None
    max_open_positions: Optional[int] = None
    auto_multi_symbol: Optional[bool] = None
    auto_tp_pct: Optional[float] = None
    auto_sl_pct: Optional[float] = None


class ActiveBody(BaseModel):
    active_symbol: Optional[str] = None
    strategy: Optional[str] = None


@app.get("/api/")
async def root():
    return {"service": "TRDGWDBOT", "status": "ok"}


@app.get("/api/state")
async def get_state():
    return client.get_state()


@app.get("/api/symbols")
async def get_symbols():
    return {"watchlist": client.watchlist, "catalog": SYMBOLS}


@app.post("/api/config")
async def set_config(body: ConfigBody):
    if body.env not in ("demo", "real"):
        raise HTTPException(400, "env must be demo or real")
    if body.strategy and body.strategy not in STRATEGY_NAMES:
        raise HTTPException(400, f"strategy must be one of {STRATEGY_NAMES}")
    await client.configure(body.token.strip(), body.app_id.strip(), body.env, body.active_symbol, body.strategy)
    # Allow some time for handshake
    await asyncio.sleep(2.5)
    return client.get_state()


@app.post("/api/active")
async def set_active(body: ActiveBody):
    """Cambia simbolo/strategia attivi per l'auto-trading senza riconnettersi."""
    if body.strategy and body.strategy not in STRATEGY_NAMES:
        raise HTTPException(400, f"strategy must be one of {STRATEGY_NAMES}")
    if body.active_symbol and body.active_symbol not in client.watchlist:
        raise HTTPException(400, f"Simbolo non nella watchlist attiva: {client.watchlist}")
    if body.active_symbol:
        client.active_symbol = body.active_symbol
    if body.strategy:
        client.strategy = body.strategy
    if body.active_symbol not in (None,) or body.strategy not in (None,):
        m = client._market(client.active_symbol)
        m["pending_dir"] = "WAIT"
        m["pending_count"] = 0
        m["last_auto_dir"] = None
    await db.config.update_one(
        {"_id": "main"},
        {"$set": {"active_symbol": client.active_symbol, "strategy": client.strategy}},
        upsert=True,
    )
    return client.get_state()


@app.post("/api/order")
async def place_order(body: OrderBody):
    if body.direction not in ("BUY", "SELL"):
        raise HTTPException(400, "direction must be BUY or SELL")
    if not client.authorized:
        raise HTTPException(400, "Non autenticato — configura prima il token")
    try:
        r = await client.place_order(body.direction, body.stake, body.multiplier, body.symbol, source="manual")
        return {"ok": True, **r}
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/close_all")
async def close_all():
    if not client.authorized:
        raise HTTPException(400, "Non autenticato")
    return {"results": await client.close_all()}


@app.post("/api/close/{contract_id}")
async def close_position(contract_id: int):
    if not client.authorized:
        raise HTTPException(400, "Non autenticato")
    try:
        r = await client.close_contract(contract_id)
        return {"ok": True, "sold_for": r.get("sold_for")}
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/auto")
async def set_auto(body: AutoBody):
    client.auto_mode = bool(body.enabled)
    if not body.enabled:
        for mk in client.markets.values():
            mk["last_auto_dir"] = None
    await db.config.update_one(
        {"_id": "main"}, {"$set": {"auto_mode": client.auto_mode}}, upsert=True
    )
    client.log("I", f"AUTO {'ON' if client.auto_mode else 'OFF'}")
    return {"auto_mode": client.auto_mode}


@app.post("/api/auto-settings")
async def set_auto_settings(body: AutoSettingsBody):
    """Parametrizza l'auto-trading: stake, leva, numero massimo di posizioni aperte contemporaneamente."""
    updates = {}
    if body.auto_stake is not None:
        if body.auto_stake <= 0:
            raise HTTPException(400, "auto_stake deve essere positivo")
        client.auto_stake = body.auto_stake
        updates["auto_stake"] = body.auto_stake
    if body.auto_multiplier is not None:
        if body.auto_multiplier not in VALID_MULTIPLIERS:
            raise HTTPException(400, f"auto_multiplier deve essere uno di {VALID_MULTIPLIERS}")
        client.auto_multiplier = body.auto_multiplier
        updates["auto_multiplier"] = body.auto_multiplier
    if body.max_open_positions is not None:
        if body.max_open_positions < 1:
            raise HTTPException(400, "max_open_positions deve essere almeno 1")
        client.max_open_positions = body.max_open_positions
        updates["max_open_positions"] = body.max_open_positions
    if body.auto_multi_symbol is not None:
        client.auto_multi_symbol = body.auto_multi_symbol
        updates["auto_multi_symbol"] = body.auto_multi_symbol
    if body.auto_tp_pct is not None:
        if body.auto_tp_pct <= 0:
            raise HTTPException(400, "auto_tp_pct deve essere positivo")
        client.auto_tp_pct = body.auto_tp_pct
        updates["auto_tp_pct"] = body.auto_tp_pct
    if body.auto_sl_pct is not None:
        if body.auto_sl_pct <= 0:
            raise HTTPException(400, "auto_sl_pct deve essere positivo")
        client.auto_sl_pct = body.auto_sl_pct
        updates["auto_sl_pct"] = body.auto_sl_pct
    if updates:
        await db.config.update_one({"_id": "main"}, {"$set": updates}, upsert=True)
        client.log("I", f"Parametri auto aggiornati: {updates}")
    return client.get_state()


@app.post("/api/reset-stats")
async def reset_stats():
    """Azzera statistiche e cancella lo storico operazioni (non tocca posizioni aperte)."""
    client.trades_total = 0
    client.trades_win = 0
    client.profit_total = 0.0
    client.session_pnl = 0.0
    client.auto_trades_total = 0
    client.auto_trades_win = 0
    client.manual_trades_total = 0
    client.manual_trades_win = 0
    await db.trades.delete_many({})
    client.log("I", "Statistiche e storico azzerati")
    return client.get_state()


@app.get("/api/history")
async def get_history(limit: int = 100, source: Optional[str] = None, symbol: Optional[str] = None, status: Optional[str] = None):
    """Storico operazioni (manuali + automatiche), con filtri opzionali."""
    query: dict = {}
    if source in ("manual", "auto"):
        query["source"] = source
    if symbol:
        query["symbol"] = symbol
    if status in ("open", "closed"):
        query["status"] = status
    cursor = db.trades.find(query).sort("opened_at", -1).limit(min(limit, 500))
    out = []
    async for d in cursor:
        d["id"] = d.pop("_id")
        out.append(d)
    return {"trades": out, "count": len(out)}


@app.get("/api/trades")
async def get_trades(limit: int = 50):
    # Mantenuto per compatibilità — preferire /api/history
    cursor = db.trades.find().sort("opened_at", -1).limit(limit)
    out = []
    async for d in cursor:
        d["id"] = d.pop("_id")
        out.append(d)
    return out


@app.post("/api/disconnect")
async def disconnect():
    """Drop saved config and disconnect."""
    await db.config.delete_one({"_id": "main"})
    client.token = None
    client.authorized = False
    await client.restart()
    return {"ok": True}
