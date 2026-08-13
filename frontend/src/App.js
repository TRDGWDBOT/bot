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
  cryBTCUSD: "BTC/USD", cryETHUSD: "ETH/USD",
};
const STRATEGY_LABELS = {
  ict: "ICT", price_action: "Price Action", combined: "ICT + PA",
  trend_following: "Trend Following", mean_reversion: "Mean Reversion", breakout: "Breakout",
  indicators: "Indicatori",
};

const GRANULARITY_LABELS = { "60s": "1 minuto", "300s": "5 minuti", "900s": "15 minuti", "3600s": "1 ora" };

// Le strategie auto-trading sono salvate come "nome@Ns" (es. "breakout@60s") per portarsi
// dietro anche il timeframe candele con cui hanno aperto il trade; quelle manuali sono solo
// il nome della strategia mostrata nel pannello, senza timeframe (non derivano da una
// configurazione specifica). Questa funzione traduce entrambe in etichette leggibili.
function formatStrategyMeta(raw) {
  if (!raw) return "—";
  const [name, gran] = raw.split("@");
  const label = STRATEGY_LABELS[name] || name;
  if (!gran) return label;
  return `${label} · ${GRANULARITY_LABELS[gran] || gran}`;
}

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
  const [activeTab, setActiveTab] = useState("trading"); // "trading" | "auto" | "backtest" | "notifiche" | "log"
  const [refreshing, setRefreshing] = useState(false);
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
  const [autoTp, setAutoTp] = useState(20);
  const [autoSl, setAutoSl] = useState(10);
  const [symbolConfigDraft, setSymbolConfigDraft] = useState({});
  const [backtestSymbol, setBacktestSymbol] = useState("");
  const [backtestStrategies, setBacktestStrategies] = useState(["combined"]);
  const [backtestGranularity, setBacktestGranularity] = useState(60);
  const [backtestCount, setBacktestCount] = useState(5000);
  const [backtestRunning, setBacktestRunning] = useState(false);
  const [backtestReport, setBacktestReport] = useState(null);
  const [backtestErr, setBacktestErr] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [tgChatId, setTgChatId] = useState("");
  const [notifySettings, setNotifySettings] = useState({
    trade_opened: true, trade_closed_win: true, trade_closed_loss: true,
    connection_lost: true, auto_order_failed: true,
  });
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

  const manualRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchState();
      showToast("Aggiornato");
    } catch (e) {
      showToast("Aggiornamento fallito");
    } finally {
      setRefreshing(false);
    }
  };

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
      if (state.auto_tp_pct != null) setAutoTp(state.auto_tp_pct);
      if (state.auto_sl_pct != null) setAutoSl(state.auto_sl_pct);
      if (state.symbol_config != null) setSymbolConfigDraft(state.symbol_config);
      if (state.telegram_bot_token != null) setTgToken(state.telegram_bot_token);
      if (state.telegram_chat_id != null) setTgChatId(state.telegram_chat_id);
      if (state.notify_settings != null) setNotifySettings(state.notify_settings);
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

  // symbolConfigDraft ora è: { [sym]: [ {id, strategies, granularity_sec}, ... ] }
  // — più configurazioni indipendenti possono coesistere sullo stesso simbolo.
  const addSymbolConfig = (sym) => {
    setSymbolConfigDraft((prev) => {
      const list = prev[sym] || [];
      const newEntry = { id: `new-${Date.now()}`, strategies: [], granularity_sec: 60 };
      return { ...prev, [sym]: [...list, newEntry] };
    });
  };

  const removeSymbolConfig = (sym, id) => {
    setSymbolConfigDraft((prev) => ({ ...prev, [sym]: (prev[sym] || []).filter((e) => e.id !== id) }));
  };

  const toggleSymbolStrategy = (sym, id, name) => {
    setSymbolConfigDraft((prev) => ({
      ...prev,
      [sym]: (prev[sym] || []).map((e) => {
        if (e.id !== id) return e;
        const list = e.strategies || [];
        const next = list.includes(name) ? list.filter((s) => s !== name) : [...list, name];
        return { ...e, strategies: next };
      }),
    }));
  };

  const setSymbolConfigGranularity = (sym, id, gran) => {
    setSymbolConfigDraft((prev) => ({
      ...prev,
      [sym]: (prev[sym] || []).map((e) => (e.id === id ? { ...e, granularity_sec: Number(gran) } : e)),
    }));
  };

  const saveSymbolConfig = async () => {
    try {
      const payload = {};
      for (const [sym, list] of Object.entries(symbolConfigDraft)) {
        const cleaned = (list || [])
          .filter((e) => e.strategies && e.strategies.length > 0)
          .map((e) => ({
            id: e.id && !e.id.startsWith("new-") ? e.id : undefined,
            strategies: e.strategies,
            granularity_sec: e.granularity_sec || 60,
          }));
        payload[sym] = cleaned; // array vuoto = nessun trade automatico su questo simbolo
      }
      const r = await axios.post(`${API}/symbol-config`, { symbol_config: payload });
      setState(r.data);
      showToast("Configurazione per simbolo salvata");
    } catch (e) {
      showToast(e?.response?.data?.detail || e.message);
    }
  };

  const toggleBacktestStrategy = (name) => {
    setBacktestStrategies((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]
    );
  };

  const runBacktest = async () => {
    if (backtestStrategies.length === 0) {
      showToast("Seleziona almeno una strategia");
      return;
    }
    setBacktestRunning(true);
    setBacktestErr("");
    setBacktestReport(null);
    try {
      const r = await axios.post(`${API}/backtest`, {
        symbol: backtestSymbol || s.active_symbol,
        strategies: backtestStrategies,
        granularity: Number(backtestGranularity) || 60,
        count: Number(backtestCount) || 5000,
      }, { timeout: 180000 });
      setBacktestReport(r.data);
    } catch (e) {
      setBacktestErr(e?.response?.data?.detail || e.message);
    } finally {
      setBacktestRunning(false);
    }
  };

  const toggleNotifyEvent = (name) => {
    setNotifySettings((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const saveNotifySettings = async () => {
    try {
      const r = await axios.post(`${API}/notify-settings`, {
        telegram_bot_token: tgToken.trim(),
        telegram_chat_id: tgChatId.trim(),
        notify_settings: notifySettings,
      });
      setState(r.data);
      showToast("Impostazioni notifiche salvate");
    } catch (e) {
      showToast(e?.response?.data?.detail || e.message);
    }
  };

  const testNotify = async () => {
    try {
      await axios.post(`${API}/notify-test`);
      showToast("Notifica di prova inviata — controlla Telegram");
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
      <style>{"@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }"}</style>
      <div className="sticky-top">
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
            <button className="btn-settings" onClick={manualRefresh} disabled={refreshing} data-testid="refresh-btn" title="Aggiorna" style={{ opacity: refreshing ? 0.5 : 1 }}>
              <span style={{ display: "inline-block", animation: refreshing ? "spin 0.8s linear infinite" : "none" }}>⟳</span>
            </button>
            <button className="btn-settings" onClick={() => { setToken(""); setAppId(s.app_id || "1089"); setEnv(s.env || "demo"); setActiveSymbol(s.active_symbol || "frxXAUUSD"); setStrategy(s.strategy || "combined"); setSettingsOpen(true); }} data-testid="settings-btn">⚙</button>
          </div>
        </div>

        {!s.authorized && (
          <div className={`conn-banner ${s.last_error ? "err" : ""}`} data-testid="conn-banner">
            {s.last_error ? "✗ " + s.last_error : "⟳ CONNESSIONE A DERIV..."}
          </div>
        )}

        <div className="tab-bar" style={{ display: "flex", overflowX: "auto", gap: 6, padding: "8px 14px", borderBottom: "1px solid var(--border, #2a2d36)" }}>
          {[
          ["trading", "TRADING"],
          ["auto", "AUTOMAZIONE"],
          ["backtest", "BACKTEST"],
          ["notifiche", "NOTIFICHE"],
          ["log", "LOG"],
        ].map(([key, label]) => (
          <button
            key={key}
            data-testid={`tab-${key}`}
            onClick={() => setActiveTab(key)}
            className={`env-btn ${activeTab === key ? "active" : ""}`}
            style={{ fontSize: 11, whiteSpace: "nowrap", flexShrink: 0 }}
          >
            {label}
          </button>
        ))}
      </div>
      </div>

      {activeTab === "trading" && (
      <>
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
          <option value="trend_following">Trend Following</option>
          <option value="mean_reversion">Mean Reversion</option>
          <option value="breakout">Breakout</option>
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
                  <div className={`pos-dir ${d}`}>{d} <span style={{ color: "var(--text2, #888)", fontWeight: 400 }}>{p.symbol_name || SYMBOL_LABELS[p.symbol] || p.symbol || ""}</span></div>
                  <div className="pos-info">#{p.contract_id} · ${p.buy_price || "—"} · {fmt(p.current_spot)}</div>
                  <div className="pos-info" style={{ opacity: 0.8 }}>{formatStrategyMeta(p.strategy)} {p.source ? `· ${p.source}` : ""}</div>
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
      </>
      )}

      {activeTab === "auto" && (
      <>
      <div className="sec-title">PARAMETRI AUTO-TRADING (globali)</div>
      <div className="risk-card">
        <div style={{ fontSize: 11, color: "var(--text2, #888)", marginBottom: 10 }}>
          Stake, leva, TP/SL e numero massimo di posizioni si applicano a TUTTE le
          configurazioni. Quali strategie usare e su quali simboli si decide qui sotto, in
          "CONFIGURAZIONE PER SIMBOLO" — un simbolo senza configurazioni non fa mai trade
          automatico.
        </div>
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
        <button className="btn-save" data-testid="save-auto-settings-btn" onClick={saveAutoSettings} style={{ marginTop: 10 }}>SALVA PARAMETRI AUTO</button>
      </div>

      <div className="sec-title">CONFIGURAZIONE PER SIMBOLO</div>
      <div className="risk-card">
        <div style={{ fontSize: 11, color: "var(--text2, #888)", marginBottom: 10 }}>
          Ogni simbolo può avere PIÙ configurazioni indipendenti, ciascuna con le proprie
          strategie e il proprio timeframe candele — es. XAU/USD a 1 minuto con Breakout E
          XAU/USD a 1 ora con Mean Reversion, entrambe attive insieme. Un simbolo senza
          nessuna configurazione (o senza strategie selezionate) NON fa mai trade automatico.
        </div>
        {(s.watchlist && s.watchlist.length ? s.watchlist : Object.keys(SYMBOL_LABELS)).map((sym) => {
          const configs = symbolConfigDraft[sym] || [];
          return (
            <div key={sym} style={{ border: "1px solid var(--border, #2a2d36)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{SYMBOL_LABELS[sym] || sym}</div>
                <button
                  data-testid={`add-symbol-config-${sym}`}
                  onClick={() => addSymbolConfig(sym)}
                  className="env-btn"
                  style={{ fontSize: 10, padding: "4px 8px" }}
                >
                  + Aggiungi
                </button>
              </div>
              {configs.length === 0 && (
                <div style={{ fontSize: 11, color: "var(--text2, #888)" }}>Nessuna configurazione: questo simbolo non farà trade automatico.</div>
              )}
              {configs.map((cfg) => (
                <div key={cfg.id} style={{ border: "1px solid var(--border, #2a2d36)", borderRadius: 8, padding: 8, marginTop: 8 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                    {(s.available_strategies || ["ict", "price_action", "combined", "trend_following", "mean_reversion", "breakout", "indicators"]).map((name) => {
                      const active = (cfg.strategies || []).includes(name);
                      return (
                        <button
                          key={name}
                          data-testid={`symbol-strategy-toggle-${sym}-${cfg.id}-${name}`}
                          onClick={() => toggleSymbolStrategy(sym, cfg.id, name)}
                          className={`env-btn ${active ? "active" : ""}`}
                          style={{ fontSize: 10 }}
                        >
                          {STRATEGY_LABELS[name] || name}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <select
                      value={cfg.granularity_sec || 60}
                      onChange={(e) => setSymbolConfigGranularity(sym, cfg.id, e.target.value)}
                      style={{ background: "var(--panel, #14161c)", color: "inherit", border: "1px solid var(--border, #2a2d36)", borderRadius: 8, padding: "6px 8px", fontFamily: "inherit", fontSize: 12 }}
                    >
                      <option value={60}>1 minuto</option>
                      <option value={300}>5 minuti</option>
                      <option value={900}>15 minuti</option>
                      <option value={3600}>1 ora</option>
                    </select>
                    <button
                      data-testid={`remove-symbol-config-${sym}-${cfg.id}`}
                      onClick={() => removeSymbolConfig(sym, cfg.id)}
                      style={{ background: "transparent", border: "none", color: "var(--red, #ff4d6d)", fontSize: 16, cursor: "pointer", marginLeft: "auto" }}
                      title="Rimuovi questa configurazione"
                    >
                      ✕
                    </button>
                  </div>
                  {(!cfg.strategies || cfg.strategies.length === 0) && (
                    <div style={{ fontSize: 10, color: "var(--gold)", marginTop: 6 }}>Seleziona almeno una strategia, altrimenti verrà scartata al salvataggio.</div>
                  )}
                </div>
              ))}
            </div>
          );
        })}
        <button className="btn-save" onClick={saveSymbolConfig} style={{ marginTop: 6 }}>SALVA CONFIGURAZIONE PER SIMBOLO</button>
      </div>
      </>
      )}

      {activeTab === "backtest" && (
      <>
      <div className="sec-title">BACKTEST STRATEGIE</div>
      <div className="risk-card">
        <div style={{ fontSize: 11, color: "var(--text2, #888)", marginBottom: 10 }}>
          Scarica lo storico REALE del simbolo scelto da Deriv e simula come si sarebbero
          comportate le strategie selezionate, con gli stessi TP/SL/leva impostati sopra.
        </div>
        <div className="risk-field" style={{ marginBottom: 10 }}>
          <label>Simbolo da testare</label>
          <select
            data-testid="backtest-symbol-select"
            value={backtestSymbol || s.active_symbol || ""}
            onChange={(e) => setBacktestSymbol(e.target.value)}
            style={{ width: "100%", padding: 8, background: "transparent", color: "inherit", border: "1px solid var(--border, #2a2d36)", borderRadius: 8 }}
          >
            {(s.watchlist && s.watchlist.length ? s.watchlist : Object.keys(SYMBOL_LABELS)).map((sym) => (
              <option key={sym} value={sym}>{SYMBOL_LABELS[sym] || sym}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          {(s.available_strategies || ["ict", "price_action", "combined", "trend_following", "mean_reversion", "breakout", "indicators"]).map((name) => {
            const active = backtestStrategies.includes(name);
            return (
              <button
                key={name}
                data-testid={`backtest-strategy-toggle-${name}`}
                onClick={() => toggleBacktestStrategy(name)}
                className={`env-btn ${active ? "active" : ""}`}
                style={{ fontSize: 11 }}
              >
                {STRATEGY_LABELS[name] || name}
              </button>
            );
          })}
        </div>
        <div className="risk-grid">
          <div className="risk-field">
            <label>Timeframe candele</label>
            <select value={backtestGranularity} onChange={(e) => setBacktestGranularity(e.target.value)} style={{ width: "100%", padding: 8, background: "transparent", color: "inherit", border: "1px solid var(--border, #2a2d36)", borderRadius: 8 }}>
              <option value={60}>1 minuto</option>
              <option value={300}>5 minuti</option>
              <option value={900}>15 minuti</option>
              <option value={3600}>1 ora</option>
            </select>
          </div>
          <div className="risk-field"><label>N. candele storiche (max 10000)</label><input type="number" value={backtestCount} onChange={(e) => setBacktestCount(e.target.value)} min="100" max="10000"/></div>
        </div>
        <button className="btn-save" onClick={runBacktest} disabled={backtestRunning || !s.authorized} style={{ marginTop: 10 }}>
          {backtestRunning ? "BACKTEST IN CORSO..." : "AVVIA BACKTEST"}
        </button>
        {backtestRunning && <div style={{ fontSize: 11, color: "var(--text2, #888)", marginTop: 6 }}>Le pagine di storico vengono scaricate in parallelo — con 10000 candele di solito ci vogliono pochi secondi, ma con molte strategie selezionate insieme può volerci qualche decina di secondi in più.</div>}
        {!s.authorized && <div style={{ fontSize: 11, color: "var(--text2, #888)", marginTop: 6 }}>Serve essere connessi a Deriv per scaricare lo storico.</div>}
        {backtestErr && <div style={{ fontSize: 12, color: "var(--red, #ff4d6d)", marginTop: 10 }}>{backtestErr}</div>}
        {backtestReport && (
          <div style={{ marginTop: 14, fontFamily: "var(--mono)", fontSize: 12 }}>
            <div style={{ color: "var(--text2, #888)", marginBottom: 8 }}>
              {backtestReport.candles_used} candele reali · {backtestReport.symbol}
              {backtestReport.candles_requested && backtestReport.candles_used < backtestReport.candles_requested && (
                <div style={{ color: "var(--gold)", marginTop: 4 }}>
                  ⚠ Richieste {backtestReport.candles_requested}, Deriv ne ha restituite solo {backtestReport.candles_used} — storico esaurito per questo simbolo/timeframe, non un errore dell'app.
                </div>
              )}
            </div>
            {Object.values(backtestReport.results).map((r) => (
              <div key={r.strategy || Math.random()} style={{ border: "1px solid var(--border, #2a2d36)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                {r.error ? (
                  <div>{STRATEGY_LABELS[r.strategy] || r.strategy}: {r.error}</div>
                ) : (
                  <>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{STRATEGY_LABELS[r.strategy] || r.strategy}</div>
                    <div>Trade chiusi: {r.n_trades_closed} (vinti {r.wins} · persi {r.losses})</div>
                    <div>Win rate: {r.win_rate_pct != null ? r.win_rate_pct + "%" : "n/d"}</div>
                    <div style={{ color: r.total_pnl_usd >= 0 ? "var(--green, #00d4a0)" : "var(--red, #ff4d6d)" }}>
                      P/L totale: {r.total_pnl_usd >= 0 ? "+" : ""}{r.total_pnl_usd} USD
                    </div>
                    <div>P/L medio per trade: {r.avg_pnl_usd != null ? r.avg_pnl_usd + " USD" : "n/d"}</div>
                    <div>Drawdown massimo: {r.max_drawdown_usd} USD</div>
                    {r.still_open_at_end > 0 && <div style={{ color: "var(--text2, #888)" }}>Ancora aperto a fine storico: {r.still_open_at_end}</div>}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      </>
      )}

      {activeTab === "notifiche" && (
      <>
      <div className="sec-title">NOTIFICHE TELEGRAM</div>
      <div className="risk-card">
        <div style={{ fontSize: 11, color: "var(--text2, #888)", marginBottom: 10 }}>
          Crea un bot con @BotFather su Telegram per avere il token, poi scrivi al bot e usa
          @userinfobot (o l'API getUpdates) per trovare il tuo chat id. Scegli qui sotto quali
          eventi vuoi ricevere.
        </div>
        <div className="risk-grid">
          <div className="risk-field"><label>Bot token</label><input type="text" value={tgToken} onChange={(e) => setTgToken(e.target.value)} placeholder="123456:ABC-..." /></div>
          <div className="risk-field"><label>Chat ID</label><input type="text" value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} placeholder="123456789" /></div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          {[
            ["trade_opened", "Trade aperto"],
            ["trade_closed_win", "Trade chiuso in profitto"],
            ["trade_closed_loss", "Trade chiuso in perdita"],
            ["connection_lost", "Connessione a Deriv persa"],
            ["auto_order_failed", "Ordine automatico fallito"],
          ].map(([key, label]) => (
            <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", border: "1px solid var(--border, #2a2d36)", borderRadius: 8 }}>
              <div style={{ fontSize: 12 }}>{label}</div>
              <button
                onClick={() => toggleNotifyEvent(key)}
                style={{
                  width: 40, height: 22, borderRadius: 11, border: "1px solid var(--border, #2a2d36)",
                  background: notifySettings[key] ? "var(--gold)" : "transparent", position: "relative", cursor: "pointer", flexShrink: 0,
                }}
              >
                <div style={{ width: 16, height: 16, borderRadius: "50%", background: notifySettings[key] ? "#000" : "var(--text2, #888)", position: "absolute", top: 2, left: notifySettings[key] ? 21 : 2, transition: "left .15s" }} />
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn-save" onClick={saveNotifySettings} style={{ flex: 1 }}>SALVA NOTIFICHE</button>
          <button className="env-btn" onClick={testNotify} style={{ flex: 1 }}>INVIA PROVA</button>
        </div>
      </div>
      </>
      )}

      {activeTab === "log" && (
      <>
      <div className="sec-title">LOG</div>
      <div className="log-box" data-testid="log-box">
        {(s.logs || []).map((l, i) => (
          <div key={i} className={`log-line ${l.level}`}>
            <span className="log-time">{timeFmt(l.ts)}</span>
            <span>{l.msg}</span>
          </div>
        ))}
      </div>
      </>
      )}

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
                  <span>Stake ${t.stake} · x{t.multiplier} · {formatStrategyMeta(t.strategy)}</span>
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
