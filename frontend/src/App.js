import React, { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";

const API = (() => {
  const env = process.env.REACT_APP_BACKEND_URL;
  // In production, the deployed host serves both frontend and /api on the same origin.
  // If the build-time REACT_APP_BACKEND_URL points to a different host than where the app
  // is currently running, fall back to window.location.origin (same-origin /api).
  try {
    if (typeof window !== "undefined" && window.location?.host) {
      if (!env) return `${window.location.origin}/api`;
      const envHost = new URL(env).host;
      if (envHost !== window.location.host) return `${window.location.origin}/api`;
    }
  } catch {}
  return `${env || ""}/api`;
})();
const POLL_MS = 1000;

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

  // Setup/Settings form fields
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState("1089");
  const [env, setEnv] = useState("demo");

  // Risk fields
  const [stake, setStake] = useState(1);
  const [mult, setMult] = useState(10);

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
    try {
      const r = await axios.post(`${API}/config`, { token: token.trim(), app_id: appId.trim(), env });
      setState(r.data);
      if (r.data?.last_error) setSetupErr(r.data.last_error);
      else showToast("Connessione avviata...");
    } catch (e) {
      setSetupErr(e?.response?.data?.detail || e.message);
    }
  };

  const saveSettings = async () => {
    try {
      const r = await axios.post(`${API}/config`, { token: token.trim() || state?.token || "", app_id: appId.trim() || state?.app_id || "1089", env });
      setState(r.data);
      setSettingsOpen(false);
      showToast("Salvato — riconnessione");
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
      await axios.post(`${API}/order`, { direction: dir, stake: Number(stake) || 1, multiplier: Number(mult) || 10 });
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

  const toggleAuto = async () => {
    try {
      const r = await axios.post(`${API}/auto`, { enabled: !state?.auto_mode });
      showToast(`AUTO ${r.data.auto_mode ? "ON" : "OFF"}`);
    } catch (e) {
      showToast(e?.response?.data?.detail || e.message);
    }
  };

  // ── Loading ──
  if (loading) {
    return <div className="setup-screen"><div style={{ color: "var(--gold)", fontFamily: "var(--mono)", letterSpacing: "4px" }}>CARICAMENTO...</div></div>;
  }

  // ── Setup ──
  if (!isConfigured) {
    return (
      <div className="setup-screen" data-testid="setup-screen">
        <div className="setup-title">XAUBOT</div>
        <div className="setup-badge"><div className="setup-badge-dot"></div><div className="setup-badge-txt">DERIV</div></div>
        <div className="setup-card">
          <div className="setup-steps">
            <div className="setup-steps-title">COME OTTENERE IL TOKEN</div>
            <div className="setup-step"><span className="setup-step-num">1.</span> Vai su <a href="https://app.deriv.com/account/api-token" target="_blank" rel="noreferrer">app.deriv.com/account/api-token</a></div>
            <div className="setup-step"><span className="setup-step-num">2.</span> Crea token con scope: <b>Read, Trade, Trading info, Payments, Admin</b></div>
            <div className="setup-step"><span className="setup-step-num">3.</span> Copia il token (stringa alfanumerica, NON "pat_...")</div>
            <div className="setup-step"><span className="setup-step-num">4.</span> Incollalo qui sotto. App ID <b>1089</b> = test pubblico.</div>
          </div>

          <div className="setup-section-label">TOKEN API DERIV</div>
          <div className="setup-field">
            <label>Token</label>
            <div className="input-wrap">
              <span className="input-icon">🔑</span>
              <input data-testid="setup-token-input" type="text" value={token} onChange={(e) => setToken(e.target.value)} placeholder="es: a1B2c3D4e5F6..." autoComplete="off" spellCheck="false" />
            </div>
          </div>

          <div className="setup-section-label">APP ID DERIV</div>
          <div className="setup-field">
            <label>App ID (numero, default 1089)</label>
            <div className="input-wrap">
              <span className="input-icon">🆔</span>
              <input data-testid="setup-appid-input" type="text" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="1089" autoComplete="off" spellCheck="false" />
            </div>
          </div>

          <div className="setup-section-label">TIPO DI CONTO (sceglie il token)</div>
          <div className="setup-env">
            <button data-testid="env-demo-btn" className={`env-btn ${env === "demo" ? "active" : ""}`} onClick={() => setEnv("demo")}>DEMO</button>
            <button data-testid="env-real-btn" className={`env-btn ${env === "real" ? "active" : ""}`} onClick={() => setEnv("real")}>REALE</button>
          </div>

          {setupErr && <div className="setup-err" data-testid="setup-error">✗ {setupErr}</div>}

          <button data-testid="setup-start-btn" className="btn-start" onClick={submitSetup}>AVVIA XAUBOT</button>
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
          <div className="hdr-logo">XAU<span>BOT</span></div>
          <div className={`hdr-env ${s.account_type || "demo"}`} data-testid="env-badge">{(s.account_type || "demo").toUpperCase()}</div>
        </div>
        <div className="hdr-right">
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div className={`status-dot ${s.authorized ? "ok" : s.connected ? "connecting" : "err"}`} data-testid="status-dot"></div>
            <span className="status-txt" data-testid="status-text">{s.authorized ? `LIVE · ${s.loginid || ""}` : s.connected ? "CONNESSO" : "OFFLINE"}</span>
          </div>
          <button className="btn-settings" onClick={() => { setToken(""); setAppId(s.app_id || "1089"); setEnv(s.env || "demo"); setSettingsOpen(true); }} data-testid="settings-btn">⚙</button>
        </div>
      </div>

      {!s.authorized && (
        <div className={`conn-banner ${s.last_error ? "err" : ""}`} data-testid="conn-banner">
          {s.last_error ? "✗ " + s.last_error : "⟳ CONNESSIONE A DERIV..."}
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
                <div className={`pos-pnl ${pnl >= 0 ? "pos" : "neg"}`}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}</div>
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

      <div className="sec-title">GESTIONE RISCHIO</div>
      <div className="risk-card">
        <div className="risk-grid">
          <div className="risk-field"><label>Stake ($)</label><input data-testid="cfg-stake-input" type="number" value={stake} onChange={(e) => setStake(e.target.value)} min="1"/></div>
          <div className="risk-field"><label>Leva</label><input data-testid="cfg-mult-input" type="number" value={mult} onChange={(e) => setMult(e.target.value)} min="1" max="1000"/></div>
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
              WebSocket: ws.derivws.com<br/>
              Token: <a href="https://app.deriv.com/account/api-token" target="_blank" rel="noreferrer">app.deriv.com/account/api-token</a><br/>
              Symbol: frxXAUUSD<br/>
              Bot server-side: il bot continua a girare anche con app chiusa.
            </div>
          </div>
        </div>
      </div>

      <div className={`toast ${toastMsg ? "show" : ""}`} data-testid="toast">{toastMsg}</div>
    </div>
  );
}
