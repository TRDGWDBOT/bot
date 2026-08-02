# XAUBot — Trading automatico XAU/USD via Deriv

Bot di trading automatico per oro (XAU/USD) sul broker [Deriv](https://deriv.com).

## 🏗 Architettura

- **Backend** (`/backend`) — FastAPI + Python con connessione WebSocket persistente all'API Deriv (`wss://ws.derivws.com/websockets/v3`). Esegue indicatori, segnali e ordini server-side 24/7.
- **Frontend** (`/frontend`) — PWA React installabile su mobile. Dashboard real-time con prezzo, segnali, indicatori e controllo manuale/automatico.
- **Database** — MongoDB per config persistita e storico trades.

## ☁️  Hosting consigliato: **Google Cloud Always Free**

Il provider gratuito a vita più affidabile (sostituto di Oracle Cloud):

- VM **e2-micro** gratis **per sempre** (1 vCPU shared, 1 GB RAM, 30 GB disco)
- Regioni gratis: `us-west1` (Oregon), `us-central1` (Iowa), `us-east1` (S. Carolina)
- Nessuno sleep, gira 24/7 come serve a un bot di trading
- 1 GB egress/mese gratis (più che sufficiente)

➡️  **Guida completa di installazione**: vedi [`GUIDA_XAUBOT.md`](GUIDA_XAUBOT.md)
➡️  **Setup automatico**: [`deploy/setup_gcp.sh`](deploy/setup_gcp.sh)

## 🚀 Setup locale (sviluppo)

### Prerequisiti
- Python 3.10+
- Node.js 18+ e Yarn
- MongoDB in esecuzione su localhost:27017

### Backend
```bash
cd backend
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8001 --reload
```

Variabili `.env` del backend:
```
MONGO_URL=mongodb://localhost:27017
DB_NAME=xaubot
DERIV_DEFAULT_APP_ID=1089
```

### Frontend
```bash
cd frontend
yarn install
yarn start
```

Variabili `.env` del frontend:
```
REACT_APP_BACKEND_URL=http://localhost:8001
```

Apri `http://localhost:3000`, segui il setup, inserisci il tuo token Deriv.

## 📖 Guida utente
Vedi [`GUIDA_XAUBOT.md`](GUIDA_XAUBOT.md) (versione aggiornata Markdown) oppure `GUIDA_XAUBOT.pdf`.

## 🔑 Come ottenere il token Deriv
1. Vai su https://app.deriv.com/account/api-token
2. Crea token con scope: **Read, Trade, Trading information, Payments, Admin**
3. Copia il token (stringa alfanumerica, **NON** ha prefisso `pat_`)

## ⚠️ Disclaimer
Il trading comporta rischio di perdita del capitale. Testa **a lungo in DEMO** prima del reale. Gli autori non sono responsabili di perdite finanziarie.
