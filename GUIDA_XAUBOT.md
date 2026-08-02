# XAUBOT — Guida installazione & utilizzo

**Bot di trading automatico XAU/USD via Deriv**

---

## 1. Cos'è XAUBot

XAUBot è un bot di trading automatico per il simbolo **XAU/USD** (oro contro dollaro) che usa l'API ufficiale del broker [Deriv](https://deriv.com). Si compone di:

- **Backend Python (FastAPI)** — mantiene una connessione WebSocket persistente a Deriv 24/7, calcola gli indicatori tecnici, prende decisioni di trading.
- **PWA (Progressive Web App)** — dashboard mobile installabile dal browser, mostra prezzo live, segnali, indicatori, posizioni, P&L.
- **MongoDB** — salva la configurazione e lo storico dei trade.

Il bot gira **server-side**: continua a operare anche con la PWA chiusa o lo smartphone spento.

---

## 2. Requisiti

Per installare e usare XAUBot ti serve:

- Un account **Deriv** attivo (https://deriv.com) — conto DEMO per testare, REAL per soldi reali
- Un **token API Deriv** (vedi sezione 4)
- Una VM cloud **gratuita 24/7** dove far girare il backend (vedi sezione 5)
- Python 3.10+, Node.js 18+, MongoDB (installati automaticamente dallo script)

---

## 3. Struttura del repository

Lo ZIP contiene:

```
xaubot/
├── backend/
│   ├── server.py            ← FastAPI + Deriv WS client
│   ├── requirements.txt
│   └── .env                  ← config locale
├── frontend/
│   ├── src/                  ← React PWA
│   ├── public/               ← manifest, icon, SW
│   ├── package.json
│   └── .env                  ← URL del backend
├── deploy/
│   └── setup_gcp.sh          ← script di setup automatico Google Cloud
├── README.md
└── GUIDA_XAUBOT.md           ← questo file
```

---

## 4. Come creare il token Deriv

1. Vai su **https://app.deriv.com/account/api-token**
2. Inserisci un nome (es. `xaubot`)
3. Spunta **tutti gli scope**: Read, Trade, Trading information, Payments, Admin
4. Clicca **Crea**. Copia il token che appare (stringa alfanumerica tipo `a1B2c3D4e5F6...`).

> ⚠️ Il token Deriv **NON** ha il prefisso `pat_`. Se vedi quel prefisso, non è un token Deriv valido.

> 🔒 **NON condividere mai il tuo token.** Chi lo possiede può aprire/chiudere ordini e prelevare denaro dal tuo conto.

**Tip:** per testare crea prima un token associato al tuo conto **DEMO (VRTC)**. Quando sarai pronto al reale, creane uno associato al conto **REAL (CR)**.

---

## 5. Hosting gratuito: **Google Cloud Always Free** ⭐

> **Perché Google Cloud e non Oracle Cloud?**
> Google Cloud offre la VM **e2-micro gratis a vita** senza i problemi di Oracle Cloud (reclaim aggressivo delle istanze idle, restrizioni in alcuni paesi, account spesso bloccati). È l'opzione più stabile e affidabile per un bot 24/7.

**Cosa ottieni gratis per sempre:**
- 1 VM `e2-micro` (1 vCPU shared, **1 GB RAM**, 30 GB disco SSD)
- 1 GB di traffico in uscita/mese
- IP esterno effimero (basta per il bot)
- Funziona indefinitamente finché resti nei limiti

---

## ⚡ INSTALLAZIONE SUPER-FACILE (consigliata) — Docker in 4 comandi

> **Questa è la procedura più semplice.** Non devi installare Python, Node.js, MongoDB, Nginx separatamente. Docker fa tutto da solo.

### 5.0.1 Crea l'account Google Cloud e la VM

1. Vai su **https://console.cloud.google.com** → accedi → accetta i termini
2. Richiede una **carta di credito solo per verifica** (non viene addebitato nulla nel free tier)
3. Crea un progetto (es. `xaubot-prod`)
4. Menu → **Compute Engine** → **Istanze VM** → **CREA ISTANZA**

   | Campo | Valore |
   |---|---|
   | **Nome** | `xaubot` |
   | **Regione** | `us-west1` **oppure** `us-central1` **oppure** `us-east1` |
   | **Tipo macchina** | **`e2-micro`** ← OBBLIGATORIO per il free tier |
   | **Disco** | Ubuntu 22.04 LTS, **30 GB** Standard |
   | **Firewall** | ✅ Consenti HTTP — ✅ Consenti HTTPS |

5. **CREA**. Aspetta 30 secondi. Annota l'**IP esterno**.

### 5.0.2 Connettiti alla VM
Clicca il pulsante **SSH** di fianco alla VM nella console Google Cloud → si apre un terminale nel browser.

### 5.0.3 Esegui questi 4 comandi (copia-incolla)

```bash
# 1) Installa Docker (una volta sola)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# 2) Carica i file di XAUBot sulla VM
#    Il modo più semplice: trascina lo zip xaubot_gcp.zip nel terminale SSH
#    (pulsante "⚙ Carica file" in alto a destra nella console SSH)
unzip xaubot_gcp.zip && cd xaubot

# 3) Avvia tutto (MongoDB + backend + frontend con nginx)
docker compose up -d --build

# 4) Apri il firewall (una volta sola)
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
```

**FINE.** Apri nel browser: **`http://IP-VM`** e segui il setup della PWA.

Per vedere i log: `docker compose logs -f`
Per riavviare: `docker compose restart`
Per fermare: `docker compose down`
Per aggiornare il codice (dopo aver caricato nuovi file): `docker compose up -d --build`

> 💾 I dati (token Deriv, storico trade) sono persistenti su volume Docker — restano anche se ricrei i container.

---

## 5.1 Installazione classica (se preferisci senza Docker)

1. Vai su **https://console.cloud.google.com**
2. Accedi con il tuo account Google e accetta i termini
3. Clicca **"Inizia gratis"** → ti verrà chiesta una carta di credito **solo per verifica** (non viene addebitato nulla se resti nel free tier)
4. Crea un nuovo progetto, es. `xaubot-prod`

### 5.2 Crea la VM e2-micro (Always Free)

1. Dal menu a sinistra → **Compute Engine** → **Istanze VM**
2. Abilita l'API se richiesto
3. Clicca **"CREA ISTANZA"** e imposta esattamente questi parametri:

   | Campo | Valore |
   |---|---|
   | **Nome** | `xaubot` |
   | **Regione** | `us-west1` (Oregon) **oppure** `us-central1` (Iowa) **oppure** `us-east1` (South Carolina) |
   | **Zona** | qualsiasi (es. `us-west1-a`) |
   | **Serie** | E2 |
   | **Tipo di macchina** | **`e2-micro`** (2 vCPU, 1 GB) ← **OBBLIGATORIO per il free tier** |
   | **Disco di avvio** | Ubuntu 22.04 LTS, **30 GB** Standard persistent disk |
   | **Firewall** | ✅ Consenti traffico HTTP — ✅ Consenti traffico HTTPS |

4. Clicca **CREA**. In 30 secondi la VM è pronta.
5. Annota l'**IP esterno** (colonna "IP esterno" nella lista istanze).

> ⚠️ **DEVE essere in `us-west1`, `us-central1` o `us-east1`** e di tipo **`e2-micro`**. Qualsiasi altra combinazione esce dal free tier.

### 5.3 Connettiti alla VM via SSH

Il modo più semplice: clicca il pulsante **SSH** di fianco all'istanza nella console Google Cloud → si apre un terminale nel browser.

In alternativa via gcloud CLI:
```bash
gcloud compute ssh xaubot --zone us-west1-a
```

### 5.4 Installa XAUBot (un solo comando)

Una volta dentro la VM, esegui:

```bash
# 1) Carica i file del progetto sulla VM
#    (dal tuo PC locale, NON dalla VM):
#    scp -r xaubot/ utente@IP-VM:~/

# 2) Avvia lo script di setup
cd ~/xaubot
bash deploy/setup_gcp.sh
```

Lo script installa automaticamente:
- Python 3, Node.js 20, Yarn
- MongoDB Community 7.0
- Build del frontend React
- Reverse proxy **Nginx** (o **Caddy** se hai un dominio → HTTPS gratis automatico)
- Servizio **systemd** `xaubot-backend` che si riavvia da solo se crasha
- Firewall UFW configurato

**Setup con dominio personalizzato (HTTPS automatico):**
```bash
DOMAIN=miobot.miosito.it bash deploy/setup_gcp.sh
```
Assicurati che il record DNS A del dominio punti all'IP esterno della VM **prima** di lanciare lo script.

### 5.5 Risultato finale

A fine installazione lo script stampa:
```
🌐 Frontend: http://IP-PUBBLICO   (o https://miobot.miosito.it se hai dominio)
🔧 API:      http://IP-PUBBLICO/api/
```

Apri quell'URL nel browser → vedrai la dashboard di setup di XAUBot.

### 5.6 Comandi utili

```bash
# Stato del backend
sudo systemctl status xaubot-backend

# Log in tempo reale
sudo journalctl -u xaubot-backend -f

# Riavvio
sudo systemctl restart xaubot-backend

# Stato MongoDB
sudo systemctl status mongod

# Aggiornamento codice (dopo modifiche al backend)
cd /opt/xaubot/backend
source venv/bin/activate
pip install -r requirements.txt
deactivate
sudo systemctl restart xaubot-backend

# Aggiornamento frontend
cd /opt/xaubot/frontend
yarn install
yarn build
# Nginx/Caddy servono i file build/ direttamente, niente da riavviare
```

---

## 6. Alternativa: setup locale (solo per test)

Se vuoi solo testare sul tuo PC (NON adatto al trading reale 24/7, perché serve PC sempre acceso):

### Backend
```bash
cd backend
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8001 --reload
```
Verifica: apri `http://localhost:8001/api/` → deve rispondere `{"service":"XAUBot","status":"ok"}`.

### Frontend
```bash
cd frontend
yarn install
yarn start
```
Configura `frontend/.env`:
```
REACT_APP_BACKEND_URL=http://localhost:8001
```

---

## 7. Come usare la PWA

### 7.1 Primo avvio (setup)
Apri il dominio (o IP) della tua app. Vedrai lo schermo di setup.

1. **Incolla il token Deriv** nel primo campo.
2. Lascia **App ID = 1089** (è l'app pubblica Deriv di test).
3. Seleziona **DEMO** per testare o **REALE** per soldi veri (deve corrispondere al tuo token).
4. Clicca **AVVIA XAUBOT**.

### 7.2 Dashboard principale
Una volta connesso vedrai:

- **Header** — logo + badge DEMO/REAL + dot di stato (verde = LIVE). Il loginid (es. `VRTC1234`) appare di fianco.
- **Prezzo XAU/USD live** con bid/ask/spread/saldo.
- **Signal Card** — direzione BUY/SELL/WAIT, percentuale di confidenza, livelli entry/TP/SL.
- **Indicatori** — RSI, MACD, EMA 9/21, ATR, Momentum, Stochastic, Score globale.
- **Posizioni aperte** con P&L real-time per ogni contratto.
- **Statistiche** — trades totali, win rate, P&L cumulativo, balance.
- **Gestione rischio** — stake (in USD) e leva.
- **Ordini manuali** — BUY / SELL / AUTO ON-OFF / CHIUDI TUTTO.
- **Log** — eventi del bot in tempo reale.

### 7.3 Trading manuale
1. Imposta **Stake** (es. $1) e **Leva** (es. 10).
2. Clicca **BUY** per long o **SELL** per short.
3. La posizione apparirà in *Posizioni aperte* con P&L che aggiorna ogni tick.
4. Per chiudere: **CHIUDI TUTTO** (chiude tutte le posizioni a mercato).

### 7.4 Auto-trading
Clicca **AUTO OFF → AUTO ON**. Il bot:

- Monitora il prezzo XAU/USD ogni tick.
- Quando lo **score raggiunge ±4** e si conferma per **5 tick consecutivi**, apre un ordine.
- Apre **max 3 posizioni** contemporanee.
- Trada solo in sessione **UTC 7:00–17:00** (sessione europea + apertura USA) e quando l'**ATR** è sufficiente.
- Il bot continua anche se chiudi l'app! Gira sul server. Riapri la PWA quando vuoi per controllare.

> ⚠️ **Importante:** i Multipliers Deriv **NON** hanno SL/TP automatici in questa versione. Devi chiudere manualmente le posizioni o aspettare lo stop-out della piattaforma.

---

## 8. Passaggio a soldi reali

Quando vuoi passare al trading reale:

1. **Testa a lungo in DEMO.** Minimo 2-4 settimane con la stessa size che userai in reale.
2. Vai su https://app.deriv.com/account/api-token, crea un **nuovo token associandolo al tuo conto REAL (CR)**.
3. Apri la PWA → **Impostazioni** → incolla il nuovo token → seleziona **REALE** → salva.
4. Inizia con **stake minimo** ($1, leva 5-10x) per validare in reale prima di scalare.
5. Tieni le prime sessioni **sotto supervisione**: non lasciare AUTO ON e dormirci sopra.

---

## 9. Sicurezza

- Il token Deriv è salvato sul tuo MongoDB **in chiaro**. Tieni il server privato (non esporlo pubblicamente senza HTTPS + autenticazione).
- Lo script `setup_gcp.sh` configura **UFW** (firewall) lasciando aperte solo le porte 22 (SSH), 80, 443.
- MongoDB è in ascolto solo su **localhost** (default sicuro).
- Se usi un **dominio**, Caddy fornisce automaticamente HTTPS gratuito tramite Let's Encrypt.
- Non condividere screenshot della dashboard se sono visibili token, loginid, balance reali.
- Se sospetti compromissione: **revoca subito il token** su https://app.deriv.com/account/api-token.

---

## 10. Backup & manutenzione

### Backup del database MongoDB
```bash
# Sulla VM Google Cloud
mongodump --db xaubot --out ~/backup-$(date +%F)
# Scarica sul tuo PC
gcloud compute scp --recurse xaubot:~/backup-2026-01-15 ./
```

### Aggiornamento sistema
```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo reboot   # se necessario
```

Lo script systemd riavvia automaticamente il backend dopo il reboot.

---

## 11. Troubleshooting

### Schermo nero / 'CARICAMENTO...' infinito
Il frontend non riesce a parlare col backend. Verifica:
- `REACT_APP_BACKEND_URL` in `frontend/.env` punta al backend giusto.
- Il backend sta girando: `sudo systemctl status xaubot-backend`
- Test diretto: `curl http://IP-VM/api/` → deve rispondere ok
- CORS: il backend ha `allow_origins=['*']` di default.

### 'Auth fallita'
Token Deriv non valido o scaduto. Ricreane uno nuovo su https://app.deriv.com/account/api-token.

### Nessun prezzo dopo connessione
Verifica che il simbolo `frxXAUUSD` sia disponibile sul tuo conto (alcuni paesi/conti hanno restrizioni). I conti DEMO standard hanno sempre accesso a XAU/USD.

### 'AUTO trigger' ma nessun ordine
Controlla i log:
```bash
sudo journalctl -u xaubot-backend -f
```
Probabilmente filtro ATR/sessione non passato, o saldo insufficiente, o limite di 3 posizioni aperte raggiunto.

### Backend non parte dopo reboot
```bash
sudo systemctl status mongod          # MongoDB up?
sudo systemctl status xaubot-backend  # Backend up?
sudo journalctl -u xaubot-backend -n 50
```

### La VM è lenta
La e2-micro ha solo 1 GB RAM. Se MongoDB + Python + Node build saturano la memoria durante l'installazione:
```bash
# Aggiungi 2 GB di swap (una volta sola)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 12. Alternative gratuite (in caso Google Cloud non sia disponibile nel tuo paese)

| Provider | VM gratuita 24/7 | Note |
|---|---|---|
| **Google Cloud Always Free** ⭐ | Sì, e2-micro a vita | Consigliato. Richiede carta solo per verifica. |
| **AWS Free Tier** | t2.micro 12 mesi | Gratis solo il primo anno, poi a pagamento. |
| **Hetzner CAX11** | ~€3.79/mese (ARM) | A pagamento ma economico ed eccellente (datacenter EU). |
| **Self-hosted (PC casa + ngrok/cloudflare tunnel)** | Sì, 100% gratis | Serve PC sempre acceso e connessione stabile. |
| ~~Fly.io~~ | ~~Non più free~~ | Rimosso il free tier nel 2024. |
| ~~Render Free~~ | ~~Va in sleep~~ | NON adatto a bot 24/7. |
| ~~Railway~~ | ~~$5 credito/mese~~ | Insufficiente per uso continuo. |

---

## 13. Disclaimer

Il trading comporta **rischio elevato di perdita del capitale**. XAUBot è uno strumento **educativo open-source**: gli autori non garantiscono profitti né si assumono responsabilità per perdite finanziarie. Usa **solo capitale che puoi permetterti di perdere**. Testa sempre in **DEMO prima del reale**.

---

*Documento aggiornato — Gennaio 2026*
