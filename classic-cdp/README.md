# Metodo classico (senza estensione)

Se non puoi (o non vuoi) caricare un'estensione, puoi controllare Chrome
aprendo la porta di debug e facendo da ponte con un relay TCP.

**Limite importante**: Chrome 136+ ignora `--remote-debugging-port` sul profilo
normale. Serve una **copia** del profilo, quindi il browser controllato non è
esattamente quello di tutti i giorni (ma contiene gli stessi accessi).

## Passi (Linux, PC dell'utente)

```bash
# 1. chiudi Chrome, poi copia il profilo (una volta sola)
cp -r ~/.config/google-chrome ~/.config/chrome-ai-bridge

# 2. avvia Chrome con il debug (ascolta solo in locale)
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/chrome-ai-bridge" &

# 3. apri il passaggio verso la macchina dell'agente (rete privata Tailscale)
socat TCP-LISTEN:9223,bind=IP-TAILSCALE,reuseaddr,fork TCP:127.0.0.1:9222 &
```

## Lato agente

Collega Playwright MCP all'endpoint CDP:

```jsonc
{
  "mcp": {
    "chrome-classic": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp@latest",
                  "--cdp-endpoint", "http://IP-TAILSCALE:9223"],
      "enabled": true
    }
  }
}
```

Avvertenze: la porta 9222 non ha autenticazione: tienila legata alla rete
privata, mai su internet. Quando hai finito: `pkill -f chrome-ai-bridge` e
`pkill socat`.
