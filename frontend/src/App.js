import React, { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";

const API = (() => {
  const env = process.env.REACT_APP_BACKEND_URL;
  // Frontend e backend sono deployati come servizi separati (Render): usa sempre
  // l'URL configurato in build. Il fallback a same-origin serve solo per lo
  // scenario legacy (nginx che proxya /api sullo stesso dominio, es. docker-compose locale).
  if (env) return `${env.replace(/\/$/, "")}/api`;
  if (typeof window !== "undefined" && window.location?.origin) return `${window.location.origin}/api`;
  return "/api";
})();
const POLL_MS = 1000;

const SYMBOL_LABELS = {
  frxXAUUSD: "XAU/USD", frxXAGUSD: "XAG/USD",
  frxEURUSD: "EUR/USD", frxGBPUSD: "GBP/USD", frxUSDJPY: "USD/JPY",
  frxAUDUSD: "AUD/USD", frxUSDCAD: "USD/CAD", frxUSDCHF: "USD/CHF", frxNZDUSD: "NZD/USD",
  cryBTCUSD: "BTC/USD", cryETHUSD: "ETH/USD", cryLTCUSD: "LTC/USD", cryXRPUSD: "XRP/USD",
  OTC_SPC: "US 500", OTC_NDX: "US Tech 100", OTC_DJI: "Wall St 30",
  OTC_GDAXI: "Germany 40", OTC_FTSE: "UK 100", OTC_N225: "Japan 225",
};
const STRATEGY_LABELS = { ict: "ICT", price_action: "Price Action", combined: "ICT + PA", indicators: "Indicatori" };

function fmt(v, d = 2) {
  if (v === null || v === undefined || isNaN(v) || v === 0) return "—";
  return Number(v).toFixed(d);
}

function timeFmt(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return "—"; }
}

export default function App() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [prevPrice, setPrevPrice] = useState(0);
  const [setupErr, setSetupErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Setup/Settings form fields
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState("1089");
  const [env, setEnv] = useState("demo");
  const [activeSymbol, setActiveSymbol] = useState("frxXAUUSD");
  const [strategy, setStrategy] = useState("combined");

  // Risk fields
  const [stake, setStake] = useState(1);
  const [mult, setMult] = useState(100);
  const [autoStake, setAutoStake] = useState(1);
  const [autoMult, setAutoMult] = useState(100);
  const [maxPos, setMaxPos] = useState(3);
  const [multiSymbol, setMultiSymbol] = useState(true);
  const [autoTp, setAutoTp] = useState(20);
  const [autoSl, setAutoSl] = useState(10);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyFilter, setHistoryFilter] = useState("all");

  const toastTimerRef = useRef(null);
  const wakeLockRef = useRef(null);

  const showToast = useCallback((m) => {
    setToastMsg(m);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(""), 2500);
  }, []);

  // Polling
  const fetchState = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/state`, { timeout: 8000 });
      setState((prev) => {
        if (prev && r.data?.price && r.data.price !== prev.price) setPrevPrice(prev.price);
        return r.data;
      });
    } catch (e) {
      // ignore transient errors
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, POLL_MS);
    return () => clearInterval(id);
  }, [fetchState]);

  // Sincronizza i parametri auto-trading dal server una sola volta al primo caricamento
  const autoSettingsSynced = useRef(false);
  useEffect(() => {
    if (state && !autoSettingsSynced.current) {
      if (state.auto_stake != null) setAutoStake(state.auto_stake);
      if (state.auto_multiplier != null) setAutoMult(state.auto_multiplier);
      if (state.max_open_positions != null) setMaxPos(state.max_open_positions);
      if (state.auto_multi_symbol != null) setMultiSymbol(state.auto_multi_symbol);
      if (state.auto_tp_pct != null) setAutoTp(state.auto_tp_pct);
      if (state.auto_sl_pct != null) setAutoSl(state.auto_sl_pct);
      autoSettingsSynced.current = true;
    }
  }, [state]);

  // Wake Lock — keep screen on while connected (only Android Chrome supports it)
  useEffect(() => {
    if (!state?.connected) return;
    let active = true;
    (async () => {
      try {
        if ("wakeLock" in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
        }
      } catch {}
    })();
    const onVis = async () => {
      if (document.visibilityState === "visible" && active && "wakeLock" in navigator && !wakeLockRef.current?.released) {
        try { wakeLockRef.current = await navigator.wakeLock.request("screen"); } catch {}
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVis);
      try { wakeLockRef.current?.release?.(); } catch {}
    };
  }, [state?.connected]);

  const isConfigured = state?.configured;

  // Setup submit
  const submitSetup = async () => {
    setSetupErr("");
    if (!token.trim()) { setSetupErr("Inserisci il token Deriv"); return; }
    if (!appId.trim()) { setSetupErr("Inserisci l'App ID"); return; }
    setSubmitting(true);
    try {
      const r = await axios.post(`${API}/config`, { token: token.trim(), app_id: appId.trim(), env, active_symbol: activeSymbol, strategy }, { timeout: 60000 });
      setState(r.data);
      if (r.data?.last_error) setSetupErr(r.data.last_error);
      else showToast("Connessione avviata...");
    } catch (e) {
      if (e.code === "ECONNABORTED") setSetupErr("Il server sta impiegando molto ad avviarsi (piano gratuito) — riprova tra poco");
      else setSetupErr(e?.response?.data?.detail || e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const saveSettings = async () => {
    try {
      const r = await axios.post(`${API}/config`, { token: token.trim() || state?.token || "", app_id: appId.trim() || state?.app_id || "1089", env, active_symbol: activeSymbol, strategy });
      setState(r.data);
      setSettingsOpen(false);
      showToast("Salvato — riconnessione");
    } catch (e) {
      showToast(e?.response?.data?.detail || e.message);
    }
  };

  const setActive = async (nextSymbol, nextStrategy) => {
    try {
      const r = await axios.post(`${API}/active`, { active_symbol: nextSymbol, strategy: nextStrategy });
      setState(r.data);
      showToast("Simbolo/strategia aggiornati");
    } catch (e) {
      showToast(e?.response?.data?.detail || e.message);
    }
  };

  const disconnect = async () => {
    try { await axios.post(`${API}/disconnect`); setState((s) => ({ ...(s || {}), configured: false, authorized: false, connected: false })); setSettingsOpen(false); showToast("Disconnesso"); } catch {}
  };

  const placeOrder = async (dir) => {
    if (!state?.authorized) return showToast("Non autenticato");
    try {
      await axios.post(`${API}/order`, { direction: dir, stake: Number(stake) || 1, multiplier: Number(mult) || 100 });
      showToast(`✓ Ordine ${dir} aperto`);
    } catch (e) {
      showToast("✗ " + (e?.response?.data?.detail || e.message));
    }
  };

  const closeAll = async () => {
    try {
      const r = await axios.post(`${API}/close_all`);
      showToast(`Chiusi ${r.data.results.length} contratti`);
    } catch (e) {
      showToast("✗ " + (e?.response?.data?.detail || e.message));
    }
  };

  const closePosition = async (contractId) => {
    try {
      await axios.post(`${API}/close/${contractId}`);
      showToast(`Posizione #${contractId} chiusa`);
    } catch (e) {
      showToast("✗ " + (e?.response?.data?.detail || e.message));
    }
  };

  const resetStats = async () => {
    if (!window.confirm("Azzerare statistiche e cancellare tutto lo storico operazioni? L'operazione non è reversibile.")) return;
    try {
      const r = await axios.post(`${API}/reset-stats`);
      setState(r.data);
      setHistory([]);
      showToast("Statistiche e storico azzerati");
    } catch (e) {
      showToast("✗ " + (e?.response?.data?.detail || e.message));
    }
  };

  const toggleAuto = async () => {
    try {
      const r = await axios.post(`${API}/auto`, { enabled: !state?.auto_mode });
      showToast(`AUTO ${r.data.auto_mode ? "ON" : "OFF"}`);
    } catch (e) {
      showToast(e?.response?.data?.detail || e.message);
    }
  };

  const saveAutoSettings = async () => {
    try {
      const r = await axios.post(`${API}/auto-settings`, {
        auto_stake: Number(autoStake) || 1,
        auto_multiplier: Number(autoMult) || 100,
        max_open_positions: Number(maxPos) || 3,
        auto_multi_symbol: multiSymbol,
        auto_tp_pct: Number(autoTp) || 20,
        auto_sl_pct: Number(autoSl) || 10,
      });
      setState(r.data);
      showToast("Parametri auto-trading salvati");
    } catch (e) {
      showToast("✗ " + (e?.response?.data?.detail || e.message));
    }
  };

  const fetchHistory = async (filter) => {
    try {
      const params = {};
      if (filter && filter !== "all") params.source = filter;
      const r = await axios.get(`${API}/history`, { params });
      setHistory(r.data.trades || []);
    } catch (e) {
      showToast("✗ " + (e?.response?.data?.detail || e.message));
    }
  };

  const openHistory = () => {
    setHistoryOpen(true);
    fetchHistory(historyFilter);
  };

  const changeHistoryFilter = (f) => {
    setHistoryFilter(f);
    fetchHistory(f);
  };

  // ── Loading ──
  if (loading) {
    return <div className="setup-screen"><div style={{ color: "var(--gold)", fontFamily: "var(--mono)", letterSpacing: "4px" }}>CARICAMENTO...</div></div>;
  }

  // ── Setup ──
  if (!isConfigured) {
    return (
      <div className="setup-screen" data-testid="setup-screen">
        <div className="setup-title">TRDGWDBOT</div>
        <div className="setup-badge"><div className="setup-badge-dot"></div><div className="setup-badge-txt">DERIV</div></div>
        <div className="setup-card">
          <div className="setup-steps">
            <div className="setup-steps-title">COME OTTENERE IL TOKEN</div>
            <div className="setup-step"><span className="setup-step-num">1.</span> Vai su <a href="https://app.deriv.com/account/api-token" target="_blank" rel="noreferrer">app.deriv.com/account/api-token</a></div>
            <div className="setup-step"><span className="setup-step-num">2.</span> Crea token con scope: <b>Trade, Account management</b></div>
            <div className="setup-step"><span className="setup-step-num">3.</span> Copia il token (formato attuale: <code>pat_...</code>)</div>
            <div className="setup-step"><span className="setup-step-num">4.</span> Incollalo qui sotto insieme al tuo App ID (da <a href="https://developers.deriv.com/dashboard" target="_blank" rel="noreferrer">developers.deriv.com/dashboard</a>, oppure <b>1089</b> per un test rapido).</div>
          </div>

          <div className="setup-section-label">TOKEN API DERIV</div>
          <div className="setup-field">
            <label>Token</label>
            <div className="input-wrap">
              <span className="input-icon">🔑</span>
              <input data-testid="setup-token-input" type="text" value={token} onChange={(e) => setToken(e.target.value)} placeholder="pat_..." autoComplete="off" spellCheck="false" />
            </div>
          </div>

          <div className="setup-section-label">APP ID DERIV</div>
          <div className="setup-field">
            <label>App ID</label>
            <div className="input-wrap">
              <span className="input-icon">🆔</span>
              <input data-testid="setup-appid-input" type="text" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="1089" autoComplete="off" spellCheck="false" />
            </div>
          </div>

          <div className="setup-section-label">SIMBOLO PRINCIPALE (auto-trading)</div>
          <div className="setup-field">
            <div className="input-wrap">
              <select data-testid="setup-symbol-select" value={activeSymbol} onChange={(e) => setActiveSymbol(e.target.value)} style={{ width: "100%", background: "transparent", border: "none", color: "inherit", fontFamily: "inherit" }}>
                <option value="frxXAUUSD">XAU/USD — Oro</option>
                <option value="frxXAGUSD">XAG/USD — Argento</option>
                <option value="frxEURUSD">EUR/USD</option>
                <option value="frxGBPUSD">GBP/USD</option>
                <option value="frxUSDJPY">USD/JPY</option>
                <option value="frxAUDUSD">AUD/USD</option>
                <option value="frxUSDCAD">USD/CAD</option>
                <option value="frxUSDCHF">USD/CHF</option>
                <option value="frxNZDUSD">NZD/USD</option>
                <option value="cryBTCUSD">BTC/USD</option>
                <option value="cryETHUSD">ETH/USD</option>
                <option value="cryLTCUSD">LTC/USD</option>
                <option value="cryXRPUSD">XRP/USD</option>
                <option value="OTC_SPC">US 500</option>
                <option value="OTC_NDX">US Tech 100</option>
                <option value="OTC_DJI">Wall Street 30</option>
                <option value="OTC_GDAXI">Germany 40</option>
                <option value="OTC_FTSE">UK 100</option>
                <option value="OTC_N225">Japan 225</option>
              </select>
            </div>
          </div>

          <div className="setup-section-label">STRATEGIA</div>
          <div className="setup-env">
            <button className={`env-btn ${strategy === "ict" ? "active" : ""}`} onClick={() => setStrategy("ict")}>ICT</button>
            <button className={`env-btn ${strategy === "price_action" ? "active" : ""}`} onClick={() => setStrategy("price_action")}>PRICE ACTION</button>
            <button className={`env-btn ${strategy === "combined" ? "active" : ""}`} onClick={() => setStrategy("combined")}>ICT + PA</button>
          </div>

          <div className="setup-section-label">TIPO DI CONTO (sceglie il token)</div>
          <div className="setup-env">
            <button data-testid="env-demo-btn" className={`env-btn ${env === "demo" ? "active" : ""}`} onClick={() => setEnv("demo")}>DEMO</button>
            <button data-testid="env-real-btn" className={`env-btn ${env === "real" ? "active" : ""}`} onClick={() => setEnv("real")}>REALE</button>
          </div>

          {setupErr && <div className="setup-err" data-testid="setup-error">✗ {setupErr}</div>}

          <button data-testid="setup-start-btn" className="btn-start" onClick={submitSetup} disabled={submitting}>{submitting ? "CONNESSIONE IN CORSO... (può richiedere fino a 1 min)" : "AVVIA TRDGWDBOT"}</button>
        </div>
      </div>
    );
  }

  // ── App ──
  const s = state;
  const sig = s.signal || {};
  const ind = s.indicators || {};
  const score = sig.score || 0;
  const scoreLbl = score >= 6 ? "FORTE BUY" : score >= 4 ? "BUY" : score <= -6 ? "FORTE SELL" : score <= -4 ? "SELL" : "NEUTRO";
  const scoreColor = score >= 4 ? "var(--buy)" : score <= -4 ? "var(--sell)" : "var(--text2)";
  const dir = sig.dir || "WAIT";
  const arcColor = dir === "BUY" ? "var(--buy)" : dir === "SELL" ? "var(--sell)" : "var(--wait)";
  const circum = 2 * Math.PI * 27;
  const conf = sig.conf || 0;
  const priceDir = s.price > prevPrice ? "up" : s.price < prevPrice ? "down" : "";

  return (
    <div className="app" data-testid="app">
      <div className="hdr">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="hdr-logo">TRDGWD<span>BOT</span></div>
          <div className={`hdr-env ${s.account_type || "demo"}`} data-testid="env-badge">{(s.account_type || "demo").toUpperCase()}</div>
        </div>
        <div className="hdr-right">
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div className={`status-dot ${s.authorized ? "ok" : s.connected ? "connecting" : "err"}`} data-testid="status-dot"></div>
            <span className="status-txt" data-testid="status-text">{s.authorized ? `LIVE · ${s.loginid || ""}` : s.connected ? "CONNESSO" : "OFFLINE"}</span>
          </div>
          <button className="btn-settings" onClick={() => { setToken(""); setAppId(s.app_id || "1089"); setEnv(s.env || "demo"); setActiveSymbol(s.active_symbol || "frxXAUUSD"); setStrategy(s.strategy || "combined"); setSettingsOpen(true); }} data-testid="settings-btn">⚙</button>
        </div>
      </div>

      {!s.authorized && (
        <div className={`conn-banner ${s.last_error ? "err" : ""}`} data-testid="conn-banner">
          {s.last_error ? "✗ " + s.last_error : "⟳ CONNESSIONE A DERIV..."}
        </div>
      )}

      <div className="market-switch" data-testid="market-switch" style={{ display: "flex", gap: 8, padding: "8px 14px", overflowX: "auto" }}>
        <select
          data-testid="active-symbol-select"
          value={s.active_symbol || activeSymbol}
          onChange={(e) => { setActiveSymbol(e.target.value); setActive(e.target.value, s.strategy); }}
          style={{ flex: 1, background: "var(--panel, #14161c)", color: "inherit", border: "1px solid var(--border, #2a2d36)", borderRadius: 8, padding: "8px 10px", fontFamily: "inherit" }}
        >
          {(s.watchlist && s.watchlist.length ? s.watchlist : [s.active_symbol]).map((sym) => (
            <option key={sym} value={sym}>{SYMBOL_LABELS[sym] || sym}</option>
          ))}
        </select>
        <select
          data-testid="active-strategy-select"
          value={s.strategy || strategy}
          onChange={(e) => { setStrategy(e.target.value); setActive(s.active_symbol, e.target.value); }}
          style={{ flex: 1, background: "var(--panel, #14161c)", color: "inherit", border: "1px solid var(--border, #2a2d36)", borderRadius: 8, padding: "8px 10px", fontFamily: "inherit" }}
        >
          <option value="ict">ICT</option>
          <option value="price_action">Price Action</option>
          <option value="combined">ICT + PA</option>
          <option value="indicators">Indicatori (legacy)</option>
        </select>
      </div>

      {s.markets && Object.keys(s.markets).length > 1 && (
        <div className="watchlist-strip" data-testid="watchlist-strip" style={{ display: "flex", gap: 6, padding: "0 14px 8px", overflowX: "auto" }}>
          {Object.entries(s.markets).map(([sym, mk]) => {
            const d = mk.signals?.[s.strategy]?.dir || "WAIT";
            const color = d === "BUY" ? "var(--buy)" : d === "SELL" ? "var(--sell)" : "var(--text2, #888)";
            const isActive = sym === s.active_symbol;
            return (
              <div
                key={sym}
                onClick={() => { setActiveSymbol(sym); setActive(sym, s.strategy); }}
                style={{
                  flexShrink: 0, cursor: "pointer", padding: "6px 10px", borderRadius: 8,
                  border: `1px solid ${isActive ? color : "var(--border, #2a2d36)"}`,
                  background: isActive ? "rgba(255,255,255,0.05)" : "transparent",
                  fontSize: 12, fontFamily: "var(--mono)", color,
                }}
              >
                {SYMBOL_LABELS[sym] || sym} · {d}
              </div>
            );
          })}
        </div>
      )}

      <div className="price-strip">
        <div className={`price-val ${priceDir}`} data-testid="price-value">
          {fmt(s.price)}
          <span className="price-arrow">{priceDir === "up" ? "▲" : priceDir === "down" ? "▼" : ""}</span>
        </div>
        <div className="price-meta">
          <div className="pm-item"><div className="pm-label">BID</div><div className="pm-val" data-testid="bid-value">{fmt(s.bid)}</div></div>
          <div className="pm-item"><div className="pm-label">ASK</div><div className="pm-val" data-testid="ask-value">{fmt(s.ask)}</div></div>
          <div className="pm-item"><div className="pm-label">SPREAD</div><div className="pm-val" data-testid="spread-value">{fmt(s.spread, 4)}</div></div>
          <div className="pm-item"><div className="pm-label">SALDO</div><div className="pm-val" data-testid="balance-value">{fmt(s.balance)} {s.currency || ""}</div></div>
        </div>
      </div>

      <div className={`sig-card ${dir !== "WAIT" ? dir : ""}`} data-testid="signal-card">
        <div className="sig-header">
          <div className="sig-header-label">SEGNALE SCALPING</div>
          <div className="sig-header-time">{new Date().toLocaleTimeString("it-IT")}</div>
        </div>
        <div className="sig-top">
          <div>
            <div className={`sig-dir ${dir}`} data-testid="signal-direction">{dir}</div>
            <div className="sig-dir-sub">{dir === "BUY" ? "SEGNALE RIALZISTA" : dir === "SELL" ? "SEGNALE RIBASSISTA" : "NESSUN SEGNALE"}</div>
          </div>
          <div className="conf-wrap">
            <svg viewBox="0 0 64 64" width="64" height="64">
              <circle className="conf-track" cx="32" cy="32" r="27"/>
              <circle className="conf-arc" cx="32" cy="32" r="27" style={{ strokeDasharray: circum, strokeDashoffset: circum * (1 - conf / 100), stroke: arcColor }}/>
            </svg>
            <div className="conf-num" style={{ color: arcColor }}>{conf}%<div className="conf-label">CONF</div></div>
          </div>
        </div>
        <div className="sig-reason" data-testid="signal-reason">
          {!s.filter_ok ? `⛔ ${s.filter_reason}` :
            !sig.confirmed ? `⟳ Conferma ${sig.pending || 0}/${s.confirm_need} — Score: ${score >= 0 ? "+" : ""}${score}` :
            dir === "BUY" ? `✓ BUY confermato — Score: +${score}` :
            dir === "SELL" ? `✓ SELL confermato — Score: ${score}` :
            `Neutro — Score: ${score}`}
        </div>
        {!!(sig.reasons && sig.reasons.length) && (
          <div className="sig-reasons-list" data-testid="signal-reasons" style={{ fontSize: 11, color: "var(--text2, #888)", padding: "0 4px 4px", lineHeight: 1.6 }}>
            {sig.reasons.map((r, i) => <div key={i}>· {r}</div>)}
          </div>
        )}
        <div className="confirm-track"><div className="confirm-fill" style={{ width: ((sig.pending || 0) / (s.confirm_need || 5) * 100) + "%", background: arcColor }}></div></div>
        <div className="sig-levels">
          <div className="level-cell"><div className="level-lbl">ENTRY</div><div className="level-val" style={{ color: "var(--gold)" }}>{fmt(s.entry)}</div></div>
          <div className="level-cell"><div className="level-lbl">TP</div><div className="level-val" style={{ color: "var(--buy)" }}>{fmt(s.tp)}</div></div>
          <div className="level-cell"><div className="level-lbl">SL</div><div className="level-val" style={{ color: "var(--sell)" }}>{fmt(s.sl)}</div></div>
        </div>
      </div>

      <div className="sec-title">INDICATORI ({s.candles_count || 0} candele)</div>
      <div className="ind-grid">
        <div className="ind-tile"><div className="ind-lbl">RSI 14</div><div className="ind-num" data-testid="ind-rsi" style={{ color: ind.RSI < 30 ? "var(--buy)" : ind.RSI > 70 ? "var(--sell)" : "var(--gold)" }}>{fmt(ind.RSI, 1)}</div><div className="ind-bar"><div className="ind-fill" style={{ width: Math.min(100, ind.RSI || 50) + "%", background: ind.RSI < 30 ? "var(--buy)" : ind.RSI > 70 ? "var(--sell)" : "var(--gold)" }}></div></div></div>
        <div className="ind-tile"><div className="ind-lbl">MACD HIST</div><div className="ind-num" style={{ color: (ind.macdHist || 0) >= 0 ? "var(--buy)" : "var(--sell)" }}>{ind.macdHist != null ? ((ind.macdHist >= 0 ? "+" : "") + ind.macdHist.toFixed(4)) : "—"}</div><div className="ind-bar"><div className="ind-fill" style={{ width: "50%", background: (ind.macdHist || 0) >= 0 ? "var(--buy)" : "var(--sell)" }}></div></div></div>
        <div className="ind-tile"><div className="ind-lbl">EMA 9 / 21</div><div className="ind-num" style={{ fontSize: 12, color: (ind.E9 || 0) > (ind.E21 || 0) ? "var(--buy)" : "var(--sell)" }}>{fmt(ind.E9, 1)} / {fmt(ind.E21, 1)}</div><div className="ind-bar"><div className="ind-fill" style={{ width: (ind.E9 > ind.E21 ? 70 : 30) + "%", background: ind.E9 > ind.E21 ? "var(--buy)" : "var(--sell)" }}></div></div></div>
        <div className="ind-tile"><div className="ind-lbl">ATR 14</div><div className="ind-num" style={{ color: "var(--gold)" }}>{fmt(ind.ATR, 4)}</div><div className="ind-bar"><div className="ind-fill" style={{ width: Math.min(100, (ind.ATR || 0) * 10) + "%", background: "var(--gold)" }}></div></div></div>
        <div className="ind-tile"><div className="ind-lbl">MOMENTUM</div><div className="ind-num" style={{ color: (ind.MOM || 0) >= 0 ? "var(--buy)" : "var(--sell)" }}>{ind.MOM != null ? ((ind.MOM >= 0 ? "+" : "") + ind.MOM.toFixed(3)) : "—"}</div><div className="ind-bar"><div className="ind-fill" style={{ width: "50%", background: (ind.MOM || 0) >= 0 ? "var(--buy)" : "var(--sell)" }}></div></div></div>
        <div className="ind-tile"><div className="ind-lbl">STOCH K</div><div className="ind-num" style={{ color: (ind.SK || 50) < 20 ? "var(--buy)" : (ind.SK || 50) > 80 ? "var(--sell)" : "var(--gold)" }}>{fmt(ind.SK, 1)}</div><div className="ind-bar"><div className="ind-fill" style={{ width: Math.min(100, ind.SK || 50) + "%", background: (ind.SK || 50) < 20 ? "var(--buy)" : (ind.SK || 50) > 80 ? "var(--sell)" : "var(--gold)" }}></div></div></div>
        <div className="ind-tile wide">
          <div className="ind-lbl">SCORE SEGNALE</div>
          <div className="score-row">
            <div className="ind-num" style={{ fontSize: 22, color: scoreColor }} data-testid="score-value">{score >= 0 ? "+" : ""}{score}</div>
            <div className="score-track"><div className="score-fill" style={{ width: Math.min(100, Math.abs(score) / 11 * 100) + "%", background: scoreColor }}></div></div>
            <div className="score-tag" style={{ color: scoreColor }}>{scoreLbl}</div>
          </div>
        </div>
      </div>

      <div className="sec-title">POSIZIONI APERTE ({s.positions?.length || 0})</div>
      <div className="pos-wrap" data-testid="positions-wrap">
        {!s.positions?.length ? <div className="pos-none">Nessuna posizione aperta</div> :
          s.positions.map((p) => {
            const isUp = p.contract_type === "MULTUP";
            const d = isUp ? "BUY" : "SELL";
            const pnl = Number(p.profit || 0);
            return (
              <div key={p.contract_id} className="pos-row">
                <div>
                  <div className={`pos-dir ${d}`}>{d}</div>
                  <div className="pos-info">#{p.contract_id} · ${p.buy_price || "—"} · {fmt(p.current_spot)}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div className={`pos-pnl ${pnl >= 0 ? "pos" : "neg"}`}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}</div>
                  <button
                    data-testid={`close-pos-${p.contract_id}`}
                    onClick={() => closePosition(p.contract_id)}
                    title="Chiudi questa posizione"
                    style={{ background: "transparent", border: "1px solid var(--border, #2a2d36)", color: "var(--sell)", borderRadius: 6, width: 26, height: 26, cursor: "pointer", fontSize: 13, lineHeight: 1 }}
                  >✕</button>
                </div>
              </div>
            );
          })
        }
      </div>

      <div className="sec-title">STATISTICHE</div>
      <div className="stats-grid">
        <div className="stat-tile"><div className="stat-v" data-testid="stat-trades">{s.stats?.trades_total || 0}</div><div className="stat-l">TRADES</div></div>
        <div className="stat-tile"><div className="stat-v" style={{ color: "var(--buy)" }}>{s.stats?.trades_total > 0 ? Math.round((s.stats.trades_win / s.stats.trades_total) * 100) + "%" : "—%"}</div><div className="stat-l">WIN RATE</div></div>
        <div className="stat-tile"><div className="stat-v" style={{ color: (s.stats?.profit_total || 0) >= 0 ? "var(--buy)" : "var(--sell)" }}>{(s.stats?.profit_total || 0) >= 0 ? "+" : ""}{(s.stats?.profit_total || 0).toFixed(2)}</div><div className="stat-l">P&amp;L</div></div>
        <div className="stat-tile"><div className="stat-v">{fmt(s.balance)}</div><div className="stat-l">BALANCE</div></div>
      </div>
      <div className="stats-grid" style={{ marginTop: 6 }}>
        <div className="stat-tile"><div className="stat-v" style={{ fontSize: 16 }}>{s.stats?.manual_trades_total || 0} <span style={{ fontSize: 11, color: "var(--text2, #888)" }}>manuali</span></div><div className="stat-l">{s.stats?.manual_trades_total > 0 ? Math.round((s.stats.manual_trades_win / s.stats.manual_trades_total) * 100) + "% win" : "—"}</div></div>
        <div className="stat-tile"><div className="stat-v" style={{ fontSize: 16 }}>{s.stats?.auto_trades_total || 0} <span style={{ fontSize: 11, color: "var(--text2, #888)" }}>auto</span></div><div className="stat-l">{s.stats?.auto_trades_total > 0 ? Math.round((s.stats.auto_trades_win / s.stats.auto_trades_total) * 100) + "% win" : "—"}</div></div>
      </div>
      <button className="btn-history" data-testid="open-history-btn" onClick={openHistory} style={{ width: "100%", marginTop: 8, padding: 10, borderRadius: 8, background: "transparent", border: "1px solid var(--border, #2a2d36)", color: "var(--gold)", fontFamily: "var(--mono)", letterSpacing: 1 }}>📜 STORICO OPERAZIONI</button>
      <button className="btn-reset-stats" data-testid="reset-stats-btn" onClick={resetStats} style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 8, background: "transparent", border: "1px solid var(--border, #2a2d36)", color: "var(--sell)", fontFamily: "var(--mono)", letterSpacing: 1 }}>🗑 RESET STATISTICHE E STORICO</button>

      <div className="sec-title">GESTIONE RISCHIO (manuale)</div>
      <div className="risk-card">
        <div className="risk-grid">
          <div className="risk-field"><label>Stake ($)</label><input data-testid="cfg-stake-input" type="number" value={stake} onChange={(e) => setStake(e.target.value)} min="1"/></div>
          <div className="risk-field">
            <label>Leva</label>
            <select data-testid="cfg-mult-input" value={mult} onChange={(e) => setMult(e.target.value)} style={{ width: "100%", padding: 8, background: "transparent", color: "inherit", border: "1px solid var(--border, #2a2d36)", borderRadius: 8 }}>
              {(s.valid_multipliers || [100, 200, 300, 500, 800]).map((v) => <option key={v} value={v}>x{v}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="sec-title">PARAMETRI AUTO-TRADING</div>
      <div className="risk-card">
        <div className="risk-grid">
          <div className="risk-field"><label>Stake auto ($)</label><input data-testid="auto-stake-input" type="number" value={autoStake} onChange={(e) => setAutoStake(e.target.value)} min="1"/></div>
          <div className="risk-field">
            <label>Leva auto</label>
            <select data-testid="auto-mult-input" value={autoMult} onChange={(e) => setAutoMult(e.target.value)} style={{ width: "100%", padding: 8, background: "transparent", color: "inherit", border: "1px solid var(--border, #2a2d36)", borderRadius: 8 }}>
              {(s.valid_multipliers || [100, 200, 300, 500, 800]).map((v) => <option key={v} value={v}>x{v}</option>)}
            </select>
          </div>
          <div className="risk-field"><label>Max posizioni aperte</label><input data-testid="auto-maxpos-input" type="number" value={maxPos} onChange={(e) => setMaxPos(e.target.value)} min="1" max="10"/></div>
          <div className="risk-field"><label>Take-profit auto (%)</label><input data-testid="auto-tp-input" type="number" value={autoTp} onChange={(e) => setAutoTp(e.target.value)} min="1"/></div>
          <div className="risk-field"><label>Stop-loss auto (%)</label><input data-testid="auto-sl-input" type="number" value={autoSl} onChange={(e) => setAutoSl(e.target.value)} min="1"/></div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12, padding: "10px 12px", border: "1px solid var(--border, #2a2d36)", borderRadius: 8 }}>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>MULTI-SIMBOLO</div>
            <div style={{ fontSize: 11, color: "var(--text2, #888)", marginTop: 2 }}>Trada su tutta la watchlist, non solo su {SYMBOL_LABELS[s.active_symbol] || s.active_symbol}</div>
          </div>
          <button
            data-testid="auto-multi-symbol-toggle"
            onClick={() => setMultiSymbol(!multiSymbol)}
            style={{
              width: 46, height: 26, borderRadius: 13, border: "1px solid var(--border, #2a2d36)",
              background: multiSymbol ? "var(--gold)" : "transparent", position: "relative", cursor: "pointer", flexShrink: 0,
            }}
          >
            <div style={{ width: 20, height: 20, borderRadius: "50%", background: multiSymbol ? "#000" : "var(--text2, #888)", position: "absolute", top: 2, left: multiSymbol ? 23 : 2, transition: "left .15s" }} />
          </button>
        </div>
        <button className="btn-save" data-testid="save-auto-settings-btn" onClick={saveAutoSettings} style={{ marginTop: 10 }}>SALVA PARAMETRI AUTO</button>
      </div>

      <div className="sec-title">ORDINI MANUALI</div>
      <div className="order-wrap">
        <div className="order-row">
          <button data-testid="manual-buy-btn" className="btn-trade btn-buy" disabled={!s.authorized} onClick={() => placeOrder("BUY")}>▲ BUY</button>
          <button data-testid="manual-sell-btn" className="btn-trade btn-sell" disabled={!s.authorized} onClick={() => placeOrder("SELL")}>▼ SELL</button>
        </div>
        <div className="order-row">
          <button data-testid="auto-toggle-btn" className={`btn-auto ${s.auto_mode ? "on" : ""}`} onClick={toggleAuto}>⚡ AUTO {s.auto_mode ? "ON" : "OFF"}</button>
          <button data-testid="close-all-btn" className="btn-close-all" onClick={closeAll}>✕ CHIUDI TUTTO</button>
        </div>
      </div>

      <div className="sec-title">LOG</div>
      <div className="log-box" data-testid="log-box">
        {(s.logs || []).map((l, i) => (
          <div key={i} className={`log-line ${l.level}`}>
            <span className="log-time">{timeFmt(l.ts)}</span>
            <span>{l.msg}</span>
          </div>
        ))}
      </div>

      <div className="bottom-bar">
        <div className="bb-auto">AUTO: <span className={s.auto_mode ? "on" : "off"}>{s.auto_mode ? "ON" : "OFF"}</span></div>
        <div className="bb-ts">{new Date().toLocaleTimeString("it-IT")}</div>
        <div className="bb-pnl" style={{ color: (s.stats?.session_pnl || 0) >= 0 ? "var(--buy)" : "var(--sell)" }}>{(s.stats?.session_pnl || 0) >= 0 ? "+" : ""}{(s.stats?.session_pnl || 0).toFixed(2)}</div>
      </div>

      <div className={`settings-panel ${settingsOpen ? "open" : ""}`}>
        <div className="settings-header">
          <div className="settings-title">IMPOSTAZIONI</div>
          <div className="settings-close" onClick={() => setSettingsOpen(false)}>✕</div>
        </div>
        <div className="settings-body">
          <div className="settings-field"><label>Nuovo Token API Deriv (vuoto = mantieni)</label><input type="text" value={token} onChange={(e) => setToken(e.target.value)} placeholder="lascia vuoto per non cambiare"/></div>
          <div className="settings-field"><label>App ID</label><input type="text" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="1089"/></div>
          <div className="settings-field">
            <label>Simbolo principale</label>
            <select value={activeSymbol} onChange={(e) => setActiveSymbol(e.target.value)} style={{ width: "100%", padding: 8, background: "transparent", color: "inherit", border: "1px solid var(--border, #2a2d36)", borderRadius: 8 }}>
              {Object.entries(SYMBOL_LABELS).map(([sym, label]) => <option key={sym} value={sym}>{label}</option>)}
            </select>
          </div>
          <div className="settings-field">
            <label>Strategia</label>
            <div className="settings-env">
              <button className={`env-btn ${strategy === "ict" ? "active" : ""}`} onClick={() => setStrategy("ict")}>ICT</button>
              <button className={`env-btn ${strategy === "price_action" ? "active" : ""}`} onClick={() => setStrategy("price_action")}>PA</button>
              <button className={`env-btn ${strategy === "combined" ? "active" : ""}`} onClick={() => setStrategy("combined")}>ICT+PA</button>
            </div>
          </div>
          <div className="settings-field">
            <label>Tipo Conto</label>
            <div className="settings-env">
              <button className={`env-btn ${env === "demo" ? "active" : ""}`} onClick={() => setEnv("demo")}>DEMO</button>
              <button className={`env-btn ${env === "real" ? "active" : ""}`} onClick={() => setEnv("real")}>REALE</button>
            </div>
          </div>
          <button className="btn-save" onClick={saveSettings}>SALVA E RICONNETTI</button>
          <button className="btn-disconnect" onClick={disconnect}>DISCONNETTI E RIMUOVI TOKEN</button>
          <div className="info-box">
            <div className="info-title">INFO API DERIV</div>
            <div className="info-txt">
              Connessione: REST (api.derivws.com) + OTP → WebSocket<br/>
              Token: <a href="https://app.deriv.com/account/api-token" target="_blank" rel="noreferrer">app.deriv.com/account/api-token</a><br/>
              Simboli attivi: {(s.watchlist || []).length}<br/>
              Bot server-side: continua a girare anche con app chiusa.
            </div>
          </div>
        </div>
      </div>

      <div className={`settings-panel ${historyOpen ? "open" : ""}`}>
        <div className="settings-header">
          <div className="settings-title">STORICO OPERAZIONI</div>
          <div className="settings-close" onClick={() => setHistoryOpen(false)}>✕</div>
        </div>
        <div className="settings-body">
          <div className="settings-env" style={{ marginBottom: 12 }}>
            <button className={`env-btn ${historyFilter === "all" ? "active" : ""}`} onClick={() => changeHistoryFilter("all")}>TUTTE</button>
            <button className={`env-btn ${historyFilter === "manual" ? "active" : ""}`} onClick={() => changeHistoryFilter("manual")}>MANUALI</button>
            <button className={`env-btn ${historyFilter === "auto" ? "active" : ""}`} onClick={() => changeHistoryFilter("auto")}>AUTO</button>
          </div>
          {history.length === 0 && <div style={{ textAlign: "center", color: "var(--text2, #888)", padding: 20, fontFamily: "var(--mono)" }}>Nessuna operazione trovata</div>}
          {history.map((t) => {
            const isOpen = t.status === "open";
            const profit = t.profit;
            const color = isOpen ? "var(--gold)" : (profit >= 0 ? "var(--buy)" : "var(--sell)");
            return (
              <div key={t.id} style={{ border: "1px solid var(--border, #2a2d36)", borderRadius: 8, padding: 10, marginBottom: 8, fontFamily: "var(--mono)", fontSize: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ color: t.direction === "BUY" ? "var(--buy)" : "var(--sell)" }}>{t.direction} · {SYMBOL_LABELS[t.symbol] || t.symbol}</span>
                  <span style={{ color: "var(--text2, #888)" }}>{t.source === "auto" ? "⚡ auto" : "✋ manuale"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text2, #888)" }}>
                  <span>Stake ${t.stake} · x{t.multiplier} · {STRATEGY_LABELS[t.strategy] || t.strategy}</span>
                  <span style={{ color }}>{isOpen ? "APERTA" : `${profit >= 0 ? "+" : ""}${(profit || 0).toFixed(2)}`}</span>
                </div>
                <div style={{ color: "var(--text2, #888)", marginTop: 2, fontSize: 11 }}>
                  {t.opened_at ? new Date(t.opened_at).toLocaleString("it-IT") : ""}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className={`toast ${toastMsg ? "show" : ""}`} data-testid="toast">{toastMsg}</div>
    </div>
  );
}
