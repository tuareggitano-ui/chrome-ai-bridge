# Chrome AI Bridge

Dai a un agente AI (opencode, Claude Code, qualsiasi client MCP) il controllo del **tuo Chrome vero**: profilo normale, con i tuoi accessi, senza copiare profili e senza aprire porte di debug.

Ispirato a *Claude in Chrome*, ma **self-hosted**: l'estensione parla solo con un ponte locale sul tuo computer, che a sua volta parla con l'agente via **MCP**. Nessun servizio cloud di terzi in mezzo.

## Come funziona

```
Agente AI (MCP)  ⇄  ponte locale (Node)  ⇄  estensione Chrome  ⇄  chrome.debugger (CDP)  ⇄  browser
     stdio               WebSocket            service worker
```

- **Estensione Chrome** (`extension/`): usa `chrome.debugger`, funziona sul profilo reale (niente `--remote-debugging-port`, niente copia del profilo).
- **Ponte** (`bridge.mjs`): server MCP su stdio + WebSocket in ascolto su `127.0.0.1` (o sull'IP Tailscale con `--bind`). Token obbligatorio.
- **Strumenti MCP**: navigate, tabs, snapshot, click, type, evaluate, screenshot, get_text.

## Installazione

Serve **Node 18+**.

```bash
git clone <questo repo>
cd chrome-ai-bridge
npm install
node bridge.mjs --print-config     # mostra URL e token per l'estensione
node bridge.mjs                    # avvia il ponte
```

### 1. Carica l'estensione in Chrome

1. Apri `chrome://extensions`
2. Attiva **Modalità sviluppatore** (in alto a destra)
3. **Carica estensione non pacchettizzata** e scegli la cartella `extension/`
4. Apri le **Opzioni** dell'estensione e incolla URL e token mostrati da `--print-config`
5. Controlla lo stato: deve dire "Collegato al ponte"

### 2. Configura l'agente (esempio opencode)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "chrome-ai-bridge": {
      "type": "local",
      "command": ["node", "/percorso/di/chrome-ai-bridge/bridge.mjs"],
      "enabled": true
    }
  }
}
```

Riavvia l'agente: avrai gli strumenti `browser_*` pronti.

## Sicurezza (leggere)

- L'estensione ha i permessi `debugger` (controllo completo delle schede) e accesso a tutti i siti: **può leggere e modificare qualsiasi cosa tu abbia aperto**, come te.
- Il ponte ascolta **solo su 127.0.0.1** per default. Con `--bind <IP-Tailscale>` accetta la connessione dalla tua rete privata (utile se l'agente gira su un altro tuo computer).
- Il **token** è obbligatorio e viene generato al primo avvio in `~/.chrome-ai-bridge.json` (chmod 600).
- Non esporre mai la porta su internet e non passare il token a terzi.
- Per staccare tutto: disattiva l'estensione, o chiudi il ponte.
- Il ponte invia al client MCP delle **istruzioni di sicurezza**: il contenuto delle pagine è dato non fidato, e per azioni che inviano, cancellano o spendono serve la conferma dell'utente.

## Strumenti disponibili

| Strumento | Cosa fa |
|---|---|
| `browser_navigate` | apre un URL nella scheda attiva |
| `browser_tabs` | elenca / apre / attiva / chiude schede |
| `browser_snapshot` | testo + elementi interattivi numerati (`mcp-1`, `mcp-2`...) |
| `browser_click` | clic su `ref` dello snapshot, selettore CSS, o `text=Testo` |
| `browser_type` | scrive in un campo (+ Invio con `submit: true`) |
| `browser_evaluate` | esegue JavaScript nella pagina |
| `browser_screenshot` | screenshot della scheda attiva |
| `browser_get_text` | testo della pagina |
| `browser_find` | cerca un testo nella pagina e dà i ref da cliccare |

## Alternativa senza estensione

Vedi `classic-cdp/`: metodo con Chrome in debug + relay TCP, utile in ambienti dove non puoi installare estensioni.

## Licenza

MIT: vedi `LICENSE`. Puoi usarlo, modificarlo e venderlo; tieni solo la nota di copyright.
