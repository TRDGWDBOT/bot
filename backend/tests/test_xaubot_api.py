"""XAUBot backend API tests."""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://64a4c8b5-b63a-473b-bde0-7b8e21a9c791.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module", autouse=True)
def cleanup_at_start(client):
    """Ensure clean state — disconnect any prior config."""
    try:
        client.post(f"{API}/disconnect", timeout=10)
        time.sleep(1)
    except Exception:
        pass
    yield
    try:
        client.post(f"{API}/disconnect", timeout=10)
    except Exception:
        pass


# ── Root ───────────────────────────────────────────────
class TestRoot:
    def test_root(self, client):
        r = client.get(f"{API}/", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert data.get("service") == "XAUBot"
        assert data.get("status") == "ok"


# ── State (unconfigured) ───────────────────────────────
class TestStateUnconfigured:
    def test_state_shape_unconfigured(self, client):
        r = client.get(f"{API}/state", timeout=15)
        assert r.status_code == 200
        d = r.json()
        for key in ("connected", "authorized", "configured", "balance",
                    "signal", "indicators", "positions", "stats", "logs"):
            assert key in d, f"missing key {key}"
        assert d["configured"] is False
        assert d["connected"] is False
        assert d["authorized"] is False
        assert isinstance(d["positions"], list)
        assert isinstance(d["logs"], list)
        assert isinstance(d["stats"], dict)
        for sk in ("trades_total", "trades_win", "profit_total", "session_pnl"):
            assert sk in d["stats"]


# ── Unauthorized order endpoints ───────────────────────
class TestUnauthorized:
    def test_order_requires_auth(self, client):
        r = client.post(f"{API}/order",
                        json={"direction": "BUY", "stake": 1.0, "multiplier": 10},
                        timeout=15)
        assert r.status_code == 400
        assert "Non autenticato" in r.text

    def test_close_all_requires_auth(self, client):
        r = client.post(f"{API}/close_all", timeout=15)
        assert r.status_code == 400
        assert "Non autenticato" in r.text


# ── Auto-mode toggle ───────────────────────────────────
class TestAutoMode:
    def test_enable_auto(self, client):
        r = client.post(f"{API}/auto", json={"enabled": True}, timeout=15)
        assert r.status_code == 200
        assert r.json().get("auto_mode") is True
        s = client.get(f"{API}/state", timeout=15).json()
        assert s["auto_mode"] is True

    def test_disable_auto(self, client):
        r = client.post(f"{API}/auto", json={"enabled": False}, timeout=15)
        assert r.status_code == 200
        assert r.json().get("auto_mode") is False
        s = client.get(f"{API}/state", timeout=15).json()
        assert s["auto_mode"] is False


# ── Trades ─────────────────────────────────────────────
class TestTrades:
    def test_trades_returns_array(self, client):
        r = client.get(f"{API}/trades", timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)


# ── Config with invalid token (validates WS attempt) ───
class TestConfigInvalidToken:
    def test_config_invalid_token_attempts_connection(self, client):
        r = client.post(f"{API}/config",
                        json={"token": "test-invalid-token-12345",
                              "app_id": "1089", "env": "demo"},
                        timeout=30)
        assert r.status_code == 200, f"config returned {r.status_code}: {r.text}"
        d = r.json()
        assert d["configured"] is True
        # Wait additional time for handshake/auth failure to register
        time.sleep(4)
        s = client.get(f"{API}/state", timeout=15).json()
        assert s["configured"] is True
        # Auth must have failed
        assert s["authorized"] is False, f"unexpected authorized=True with invalid token: {s}"
        # WS connection was attempted: either last_error populated or we see connection attempt log
        connection_attempted = (
            s.get("last_error") is not None
            or any("Connessione" in log.get("msg", "") or "Auth fallita" in log.get("msg", "")
                   for log in s.get("logs", []))
        )
        assert connection_attempted, f"No evidence of Deriv WS connection attempt. State: {s}"

    def test_config_invalid_env_rejected(self, client):
        r = client.post(f"{API}/config",
                        json={"token": "abcd", "app_id": "1089", "env": "bogus"},
                        timeout=15)
        assert r.status_code == 400


# ── Disconnect clears config ───────────────────────────
class TestDisconnect:
    def test_disconnect_clears_config(self, client):
        # ensure configured
        client.post(f"{API}/config",
                    json={"token": "another-bad-token", "app_id": "1089", "env": "demo"},
                    timeout=30)
        time.sleep(1)
        r = client.post(f"{API}/disconnect", timeout=15)
        assert r.status_code == 200
        assert r.json().get("ok") is True
        time.sleep(1)
        s = client.get(f"{API}/state", timeout=15).json()
        assert s["configured"] is False
