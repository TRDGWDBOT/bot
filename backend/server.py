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
from typing import Optional, Any, List
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
import backtest as backtest_engine

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
    # Materie prime
    "XAUUSD": "frxXAUUSD",
    "XAGUSD": "frxXAGUSD",
    # Forex
    "EURUSD": "frxEURUSD",
    "GBPUSD": "frxGBPUSD",
    "USDJPY": "frxUSDJPY",
    "AUDUSD": "frxAUDUSD",
    "USDCAD": "frxUSDCAD",
    "USDCHF": "frxUSDCHF",
    "NZDUSD": "frxNZDUSD",
    # Cripto
    "BTCUSD": "cryBTCUSD",
    "ETHUSD": "cryETHUSD",
    # LTCUSD e XRPUSD rimossi: "Invalid symbol" su questo conto Deriv
    # (non offerti come Multiplier per questo account/residenza).
    # Indici azionari rimossi di proposito: orari di borsa limitati, causavano
    # errori "Trading is not offered for this duration" e posizioni chiuse a
    # mercato fermo.
}
STRATEGY_NAMES = ("ict", "price_action", "combined", "trend_following", "mean_reversion", "breakout", "indicators")
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
        self.strategy = "combined"          # strategia mostrata nel pannello principale (una delle STRATEGY_NAMES)
        self.auto_strategies: list[str] = ["combined"]  # strategie usate per decidere i trade automatici (una o più, a scelta dell'utente — ognuna agisce IN MODO INDIPENDENTE)
        # Configurazione PER SIMBOLO: strategie e timeframe candele possono essere diversi
        # per ogni asset (es. Mean Reversion su XAU/USD a 1h, Breakout su BTC/USD a 1h).
        # Chiave = simbolo Deriv (es. "frxXAUUSD"); valore = {"strategies": [...], "granularity_sec": int}.
        # Un simbolo assente da questo dizionario usa i default globali (auto_strategies + 60s),
        # cioè il comportamento di sempre — nessuna rottura per chi non configura nulla.
        self.symbol_config: dict[str, dict] = {}
        self.watchlist: list[str] = []      # simboli Deriv realmente disponibili sul conto
        self.symbol_multiplier_range: dict[str, list[int]] = {}  # leve realmente valide per simbolo, da Deriv (contracts_for)
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
        self.telegram_bot_token: str = ""
        self.telegram_chat_id: str = ""
        self.notify_settings: dict = {
            "trade_opened": True,        # ordine (auto o manuale) aperto
            "trade_closed_win": True,    # posizione chiusa in profitto
            "trade_closed_loss": True,   # posizione chiusa in perdita
            "connection_lost": True,     # connessione a Deriv caduta
            "auto_order_failed": True,   # un ordine automatico non è andato a buon fine
        }
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

    def _symbol_strategies(self, symbol: str) -> list:
        """Strategie attive per QUESTO simbolo. Se il simbolo ha una configurazione
        specifica (self.symbol_config) la usa, altrimenti ricade sulle strategie globali
        (self.auto_strategies) — così un simbolo non configurato si comporta come prima."""
        cfg = self.symbol_config.get(symbol)
        if cfg and cfg.get("strategies"):
            return cfg["strategies"]
        return self.auto_strategies or [self.strategy]

    def _symbol_granularity_sec(self, symbol: str) -> int:
        """Durata delle candele (in secondi) per QUESTO simbolo. Default 60s (1 minuto,
        il comportamento di sempre) se non configurato diversamente."""
        cfg = self.symbol_config.get(symbol)
        if cfg and cfg.get("granularity_sec"):
            return int(cfg["granularity_sec"])
        return 60

    def log(self, level: str, msg: str):
        ts = datetime.now(timezone.utc).isoformat()
        entry = {"ts": ts, "level": level, "msg": msg}
        self.logs.appendleft(entry)
        print(f"[{level}] {msg}")

    def notify(self, event: str, text: str):
        """Invia una notifica Telegram per l'evento indicato, SOLO se l'utente l'ha
        abilitato in notify_settings e ha configurato bot token + chat id. Non blocca
        mai il chiamante (fire-and-forget in background) e non fa mai fallire il
        chiamante se Telegram non risponde."""
        if not self.notify_settings.get(event, False):
            return
        if not self.telegram_bot_token or not self.telegram_chat_id:
            return
        asyncio.create_task(self._send_telegram(text))

    async def _send_telegram(self, text: str):
        url = f"https://api.telegram.org/bot{self.telegram_bot_token}/sendMessage"
        try:
            async with httpx.AsyncClient(timeout=10) as hc:
                r = await hc.post(url, json={"chat_id": self.telegram_chat_id, "text": text})
                if r.status_code != 200:
                    self.log("W", f"Notifica Telegram non inviata (HTTP {r.status_code}): {r.text[:200]}")
        except Exception as e:
            self.log("W", f"Notifica Telegram fallita: {e}")

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
            self.auto_strategies = cfg.get("auto_strategies", self.auto_strategies)
            self.symbol_config = cfg.get("symbol_config", self.symbol_config)
            self.telegram_bot_token = cfg.get("telegram_bot_token", self.telegram_bot_token)
            self.telegram_chat_id = cfg.get("telegram_chat_id", self.telegram_chat_id)
            self.notify_settings = {**self.notify_settings, **cfg.get("notify_settings", {})}
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
                            raw_list = active.get("active_symbols", [])
                            # Su questa versione dell'API alcuni endpoint usano "underlying_symbol"
                            # invece di "symbol" (vedi anche più sotto nella funzione di buy).
                            # Proviamo entrambi i nomi per essere robusti.
                            available = {
                                s.get("symbol") or s.get("underlying_symbol")
                                for s in raw_list
                                if s.get("symbol") or s.get("underlying_symbol")
                            }
                            if raw_list and not available:
                                # Nessuna delle due chiavi note ha funzionato: logghiamo le chiavi
                                # reali del primo elemento per capire il nome giusto da usare.
                                self.log("W", f"active_symbols: formato inatteso, chiavi={list(raw_list[0].keys())}")
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

                        # Verifica le leve REALI ammesse da Deriv per ogni simbolo (variano per
                        # asset e per conto/residenza) invece di fidarci a occhio della lista
                        # statica VALID_MULTIPLIERS. Se una richiesta fallisce per un simbolo,
                        # semplicemente per quel simbolo si ricade sulla lista statica.
                        self.symbol_multiplier_range = {}
                        for sym in self.watchlist:
                            try:
                                cf = await self._send({"contracts_for": sym}, timeout=15)
                                if cf.get("error"):
                                    raise RuntimeError(cf["error"].get("message", "errore contracts_for"))
                                for entry in cf.get("contracts_for", {}).get("available", []):
                                    mr = entry.get("multiplier_range")
                                    if mr:
                                        self.symbol_multiplier_range[sym] = sorted(int(x) for x in mr)
                                        break
                            except Exception as e:
                                self.log("W", f"contracts_for fallito per {sym} ({e}) — uso lista di default per la leva")
                        for name, deriv_sym in SYMBOLS.items():
                            if deriv_sym in self.symbol_multiplier_range:
                                self.log("I", f"Leve valide {name}: {self.symbol_multiplier_range[deriv_sym]}")
                            elif deriv_sym in self.watchlist:
                                self.log("W", f"Leve reali non trovate per {name}, uso default {list(VALID_MULTIPLIERS)}")

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
                                    "granularity": self._symbol_granularity_sec(sym),
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
                self.notify("connection_lost", f"⚠️ TRDGWDBOT: connessione a Deriv persa.\n{self.last_error}")
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
                        sym_name = SYMBOL_TO_NAME.get(meta.get("symbol"), meta.get("symbol", ""))
                        event = "trade_closed_win" if profit >= 0 else "trade_closed_loss"
                        emoji = "✅" if profit >= 0 else "❌"
                        self.notify(event, f"{emoji} TRDGWDBOT: {sym_name} chiuso ({source})\nP/L: {profit:+.2f} {self.currency}")
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
        gran_sec = self._symbol_granularity_sec(symbol)
        gran_ms = gran_sec * 1000
        now_ms = int(time.time() * 1000)
        bucket_ts = (now_ms // gran_ms) * gran_ms
        if not m["last_minute_ts"] or bucket_ts > m["last_minute_ts"]:
            if m["last_minute_ts"] and m["minute_buffer"]:
                m["candles"].append({
                    "open": m["minute_buffer"][0],
                    "high": max(m["minute_buffer"]),
                    "low": min(m["minute_buffer"]),
                    "close": m["minute_buffer"][-1],
                })
                if len(m["candles"]) > 200:
                    m["candles"].pop(0)
            m["last_minute_ts"] = bucket_ts
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

        # Calcola OGNI strategia disponibile per questo simbolo (utile per confronto in UI
        # e perché ognuna, se selezionata per l'auto-trading, agisce in modo indipendente)
        m["signals"] = {name: fn(candles) for name, fn in strategies.STRATEGIES.items()}
        # Compat: indicatori legacy, disponibili come opzione aggiuntiva
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
        # in modo indipendente; altrimenti si limita al solo simbolo attivo.
        if not (symbol == self.active_symbol or self.auto_multi_symbol):
            return

        ok, reason = check_filters(ind["ATR"] if ind else 1.0)

        # Ogni strategia selezionata (self.auto_strategies) lavora IN MODO INDIPENDENTE:
        # ognuna ha il proprio contatore di conferma multi-candela e può far scattare un
        # trade per conto proprio, senza bisogno che le altre siano d'accordo. L'unica
        # combinazione che resta "fusa" è quella dentro "combined" (ICT + Price Action),
        # che è già così internamente — qui la trattiamo come una strategia singola.
        strategy_state = m.setdefault("strategy_state", {})
        for name in self._symbol_strategies(symbol):
            sig = m["signals"].get(name)
            if not sig:
                continue
            st = strategy_state.setdefault(name, {"pending_dir": "WAIT", "pending_count": 0, "last_auto_dir": None})
            d = sig["dir"]
            if d == st["pending_dir"]:
                st["pending_count"] += 1
            else:
                st["pending_dir"] = d
                st["pending_count"] = 1
            confirmed = st["pending_count"] >= strategies.STRATEGY_CONFIRM_NEED.get(name, self.confirm_need)
            m["signals"][name] = {**sig, "confirmed": confirmed, "pending": st["pending_count"]}

            if not (self.auto_mode and confirmed and ok and d != "WAIT" and d != st["last_auto_dir"]):
                continue

            # Evita di aprire una posizione nella direzione opposta mentre una precedente
            # sullo STESSO simbolo è ancora aperta (da qualsiasi strategia): altrimenti
            # BUY e SELL si annullano a vicenda e il conto perde solo spread/commissioni.
            already_open_same_symbol = any(
                self.pending_trade_meta.get(cid, {}).get("symbol") == symbol
                for cid in self.open_contracts
            )
            if already_open_same_symbol:
                st["last_auto_dir"] = d
                continue

            # Apri SOLO se sembra esserci spazio per arrivare al TP configurato prima di
            # toccare lo SL: distanza di prezzo richiesta = %TP (o %SL) / (leva * 100).
            price_now = m["price"]
            tp_distance = price_now * (self.auto_tp_pct / (self.auto_multiplier * 100))
            sl_distance = price_now * (self.auto_sl_pct / (self.auto_multiplier * 100))
            room_ok, room_reason = strategies.target_reachable(
                candles, d, tp_distance, sl_distance, ind["ATR"] if ind else None
            )
            if not room_ok:
                self.log("W", f"AUTO skip [{name}] {symbol} {d}: {room_reason}")
                st["last_auto_dir"] = d
                continue

            if len(self.open_contracts) < self.max_open_positions:
                self.log("S", f"AUTO trigger [{name}] {symbol}: {d} (score={sig['score']}, conf={sig['conf']}%)")
                st["last_auto_dir"] = d
                # IMPORTANTE: non fare "await" qui. Questo codice gira dentro il loop che
                # riceve i messaggi WebSocket — se aspettassimo qui la risposta dell'ordine,
                # il loop si bloccherebbe e non potrebbe mai ricevere quella risposta
                # (si va in timeout ogni volta). Lo lanciamo come task indipendente.
                asyncio.create_task(self._auto_order_task(d, symbol, name))
                # Una sola apertura per tick per simbolo: se un'altra strategia scatta nello
                # stesso istante la prendiamo al giro successivo (open_contracts sarà aggiornato).
                break

    async def _auto_order_task(self, direction: str, symbol: str, strategy_label: str = ""):
        try:
            await self.place_order(direction, stake=self.auto_stake, multiplier=self.auto_multiplier, symbol=symbol, source="auto", strategy=strategy_label or self.strategy)
        except Exception as e:
            self.log("E", f"AUTO order fallito: {e or repr(e)}")
            self.notify("auto_order_failed", f"⚠️ TRDGWDBOT: ordine automatico {direction} su {SYMBOL_TO_NAME.get(symbol, symbol)} fallito.\n{e or repr(e)}")

    async def place_order(self, direction: str, stake: float = 1.0, multiplier: int = 100, symbol: Optional[str] = None, source: str = "manual", strategy: Optional[str] = None):
        if not self.authorized:
            raise RuntimeError("Non autenticato")
        sym = symbol or self.active_symbol
        allowed_multipliers = self.symbol_multiplier_range.get(sym) or list(VALID_MULTIPLIERS)
        if multiplier not in allowed_multipliers:
            # Arrotonda al valore valido più vicino (per QUESTO simbolo) invece di far fallire l'ordine
            multiplier = min(allowed_multipliers, key=lambda v: abs(v - multiplier))
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
        self.notify("trade_opened", f"🔔 TRDGWDBOT: {direction} {SYMBOL_TO_NAME.get(sym, sym)} aperto (${stake}, x{multiplier}, {source})")

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
            "auto_strategies": self.auto_strategies,
            "symbol_config": self.symbol_config,
            "available_strategies": list(strategies.STRATEGIES.keys()),
            "telegram_bot_token": self.telegram_bot_token,
            "telegram_chat_id": self.telegram_chat_id,
            "notify_settings": self.notify_settings,
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
            "symbol_multiplier_range": self.symbol_multiplier_range,
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
    auto_strategies: Optional[List[str]] = None


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
    if body.auto_strategies is not None:
        invalid = [s for s in body.auto_strategies if s not in strategies.STRATEGIES]
        if invalid:
            raise HTTPException(400, f"strategie non valide: {invalid}. Valide: {list(strategies.STRATEGIES.keys())}")
        if not body.auto_strategies:
            raise HTTPException(400, "seleziona almeno una strategia")
        client.auto_strategies = body.auto_strategies
        updates["auto_strategies"] = body.auto_strategies
    if updates:
        await db.config.update_one({"_id": "main"}, {"$set": updates}, upsert=True)
        client.log("I", f"Parametri auto aggiornati: {updates}")
    return client.get_state()


# Timeframe candela ammessi per la configurazione per-simbolo (in secondi).
ALLOWED_GRANULARITIES = (60, 300, 900, 3600)


class SymbolConfigBody(BaseModel):
    symbol_config: dict  # {"frxXAUUSD": {"strategies": ["mean_reversion"], "granularity_sec": 3600}, ...}


@app.post("/api/symbol-config")
async def set_symbol_config(body: SymbolConfigBody):
    """Configura strategie e timeframe candele in modo INDIPENDENTE per ogni simbolo della
    watchlist — es. Mean Reversion su XAU/USD a 1h, Breakout su BTC/USD a 1h. Un simbolo
    omesso da questo dizionario continua a usare i default globali (auto_strategies + 1 minuto),
    quindi non serve configurare esplicitamente ogni simbolo se va bene il comportamento standard."""
    cleaned: dict = {}
    for sym, cfg in body.symbol_config.items():
        if sym not in SYMBOLS.values():
            raise HTTPException(400, f"simbolo non valido: {sym}")
        entry: dict = {}
        if "strategies" in cfg:
            strat_list = cfg["strategies"]
            if not strat_list:
                raise HTTPException(400, f"{sym}: seleziona almeno una strategia")
            invalid = [s for s in strat_list if s not in strategies.STRATEGIES]
            if invalid:
                raise HTTPException(400, f"{sym}: strategie non valide: {invalid}")
            entry["strategies"] = strat_list
        if "granularity_sec" in cfg:
            gran = int(cfg["granularity_sec"])
            if gran not in ALLOWED_GRANULARITIES:
                raise HTTPException(400, f"{sym}: granularity_sec deve essere una di {ALLOWED_GRANULARITIES}")
            entry["granularity_sec"] = gran
        cleaned[sym] = entry

    # Se cambia il timeframe di un simbolo, il buffer di candele esistente (costruito col
    # timeframe precedente) non ha più senso mescolato al nuovo: lo svuotiamo per quel
    # simbolo, così si ricostruisce pulito dalla prossima candela.
    for sym, entry in cleaned.items():
        old_gran = client._symbol_granularity_sec(sym)
        new_gran = entry.get("granularity_sec", old_gran)
        if new_gran != old_gran and sym in client.markets:
            client.markets[sym]["candles"] = []
            client.markets[sym]["minute_buffer"] = []
            client.markets[sym]["last_minute_ts"] = 0

    client.symbol_config = {**client.symbol_config, **cleaned}
    await db.config.update_one({"_id": "main"}, {"$set": {"symbol_config": client.symbol_config}}, upsert=True)
    client.log("I", f"Configurazione per-simbolo aggiornata: {list(cleaned.keys())}")
    return client.get_state()


class NotifySettingsBody(BaseModel):
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    notify_settings: Optional[dict] = None  # es. {"trade_opened": true, "trade_closed_loss": false, ...}


@app.post("/api/notify-settings")
async def set_notify_settings(body: NotifySettingsBody):
    """Configura le notifiche Telegram: token del bot, chat id di destinazione, e quali
    eventi notificare (l'utente sceglie cosa ricevere e cosa no)."""
    updates = {}
    if body.telegram_bot_token is not None:
        client.telegram_bot_token = body.telegram_bot_token.strip()
        updates["telegram_bot_token"] = client.telegram_bot_token
    if body.telegram_chat_id is not None:
        client.telegram_chat_id = body.telegram_chat_id.strip()
        updates["telegram_chat_id"] = client.telegram_chat_id
    if body.notify_settings is not None:
        known = set(client.notify_settings.keys())
        invalid = [k for k in body.notify_settings if k not in known]
        if invalid:
            raise HTTPException(400, f"eventi non validi: {invalid}. Validi: {sorted(known)}")
        client.notify_settings = {**client.notify_settings, **body.notify_settings}
        updates["notify_settings"] = client.notify_settings
    if updates:
        await db.config.update_one({"_id": "main"}, {"$set": updates}, upsert=True)
        client.log("I", "Impostazioni notifiche aggiornate")
    return client.get_state()


@app.post("/api/notify-test")
async def send_test_notification():
    """Manda subito un messaggio di prova su Telegram, ignorando i toggle per evento
    (serve solo a verificare che token/chat id siano corretti)."""
    if not client.telegram_bot_token or not client.telegram_chat_id:
        raise HTTPException(400, "Configura prima bot token e chat id")
    await client._send_telegram("✅ TRDGWDBOT: notifica di prova riuscita.")
    return {"ok": True}


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


class BacktestBody(BaseModel):
    symbol: Optional[str] = None       # default: simbolo attivo del client
    strategies: Optional[List[str]] = None  # default: tutte
    granularity: int = 60              # secondi per candela (60=1min, 300=5min, 900=15min...)
    count: int = 5000                  # numero di candele storiche da scaricare (fino a 10000, paginato)
    confirm_need: Optional[int] = None
    tp_pct: Optional[float] = None
    sl_pct: Optional[float] = None
    multiplier: Optional[int] = None
    stake: Optional[float] = None


DERIV_MAX_CANDLES_PER_CALL = 5000
BACKTEST_MAX_CANDLES = 10000


async def _fetch_candles_paginated(sym: str, granularity: int, total_count: int) -> list:
    """Scarica candele storiche reali da Deriv fino a total_count. La PRIMA pagina è
    sequenziale (serve a scoprire quante candele Deriv dà davvero per chiamata a questo
    simbolo/timeframe — a volte molto meno dei 5000 documentati). Tutte le pagine
    successive vengono invece lanciate IN PARALLELO con asyncio.gather: la connessione
    WebSocket con Deriv supporta già più richieste in volo contemporaneamente (self._send
    traccia ogni richiesta per req_id), quindi non c'è motivo di aspettarle una alla volta
    — è proprio questo che causava i timeout su 5000-10000 candele."""
    first_batch_count = min(DERIV_MAX_CANDLES_PER_CALL, total_count)
    hist = await client._send({
        "ticks_history": sym, "adjust_start_time": 1, "count": first_batch_count,
        "end": "latest", "start": 1, "style": "candles", "granularity": granularity,
    }, timeout=30)
    if hist.get("error"):
        raise RuntimeError(hist["error"].get("message", "errore ticks_history"))
    first_page = hist.get("candles") or []
    if not first_page:
        return []

    all_candles = list(first_page)
    remaining = total_count - len(all_candles)
    per_page = len(first_page)  # quante candele Deriv dà REALMENTE per chiamata, a questo timeframe
    if remaining <= 0 or per_page == 0:
        return all_candles[-total_count:] if len(all_candles) > total_count else all_candles

    # Calcola in anticipo gli "end" delle pagine successive (spaziate di per_page candele
    # l'una dall'altra) e lancia tutte le richieste insieme.
    max_extra_pages = 30  # margine ampio: anche con pagine piccole copre ben oltre 10000
    n_more_pages = min(max_extra_pages, -(-remaining // per_page))  # ceil division
    oldest_epoch = first_page[0]["epoch"]
    ends = [oldest_epoch - granularity - i * per_page * granularity for i in range(n_more_pages)]

    async def _fetch_page(end_epoch: int):
        try:
            h = await client._send({
                "ticks_history": sym, "adjust_start_time": 1, "count": per_page,
                "end": end_epoch, "start": 1, "style": "candles", "granularity": granularity,
            }, timeout=30)
            return h.get("candles") or []
        except Exception as e:
            client.log("W", f"Backtest {sym}: una pagina è fallita ({e}), la salto")
            return []

    pages = await asyncio.gather(*[_fetch_page(e) for e in ends])
    for page in pages:
        all_candles.extend(page)

    if not any(pages):
        client.log("I", f"Backtest {sym}: storico esaurito dopo la prima pagina — totale {len(all_candles)}")

    # Le pagine parallele possono sovrapporsi leggermente ai bordi (weekend, mercati
    # chiusi, stima approssimata degli "end"): dedup per epoch, poi ordina e taglia.
    by_epoch = {c["epoch"]: c for c in all_candles}
    merged = sorted(by_epoch.values(), key=lambda c: c["epoch"])
    return merged[-total_count:] if len(merged) > total_count else merged


@app.post("/api/backtest")
async def run_backtest(body: BacktestBody):
    """Scarica candele storiche REALI da Deriv per il simbolo indicato (paginando se serve
    superare il limite per-chiamata di Deriv) e simula la stessa identica logica live
    (stesse funzioni strategia, stesso filtro target_reachable, stessa formula di leva) per
    stimare come si sarebbero comportate le strategie selezionate. Richiede che il bot sia
    connesso (usa la stessa sessione WebSocket già autenticata)."""
    if not client.authorized or not client.ws:
        raise HTTPException(409, "Il bot deve essere connesso a Deriv per scaricare lo storico")

    sym = body.symbol or client.active_symbol
    count = min(max(body.count, 100), BACKTEST_MAX_CANDLES)
    try:
        raw_candles = await _fetch_candles_paginated(sym, body.granularity, count)
    except Exception as e:
        raise HTTPException(502, f"Errore scaricando lo storico da Deriv: {e}")

    if len(raw_candles) < 100:
        raise HTTPException(502, f"Storico troppo corto ricevuto da Deriv ({len(raw_candles)} candele)")
    candles = [{"open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"]} for c in raw_candles]

    strategy_names = body.strategies or list(strategies.STRATEGIES.keys())
    invalid = [s for s in strategy_names if s not in strategies.STRATEGIES]
    if invalid:
        raise HTTPException(400, f"strategie non valide: {invalid}")

    report = backtest_engine.run_backtest(
        candles,
        strategy_names,
        confirm_need=body.confirm_need,  # None = usa la soglia per-strategia (default, coerente col bot live)
        tp_pct=body.tp_pct or client.auto_tp_pct,
        sl_pct=body.sl_pct or client.auto_sl_pct,
        multiplier=body.multiplier or client.auto_multiplier,
        stake=body.stake or client.auto_stake,
    )
    report["symbol"] = sym
    report["granularity_sec"] = body.granularity
    report["candles_requested"] = count
    return report


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
