#!/usr/bin/env node
/**
 * chrome-ai-bridge — ponte tra un agente AI (MCP) e il TUO Chrome reale.
 *
 * - Espone un server MCP su stdio (per opencode, Claude Code, ecc.)
 * - Riceve la connessione dell'estensione Chrome (WebSocket su 127.0.0.1)
 * - Inoltra i comandi del browser all'estensione, che usa chrome.debugger (CDP)
 *
 * Sicurezza: token obbligatorio, ascolto solo su 127.0.0.1 per default.
 * Il token viene creato al primo avvio in ~/.chrome-ai-bridge.json (chmod 600).
 *
 * Uso:
 *   node bridge.mjs                # server MCP su stdio + WS su 127.0.0.1:8765
 *   node bridge.mjs --print-config # mostra le istruzioni per l'estensione
 *   node bridge.mjs --bind 100.x.x.x  # esporre solo sulla rete Tailscale (per AI remota)
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const CONFIG_PATH = join(homedir(), ".chrome-ai-bridge.json");
const args = process.argv.slice(2);
const argOf = (nome, fallback) => {
  const i = args.indexOf(nome);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argOf("--port", "18990"));
const BIND = argOf("--bind", "127.0.0.1");

function caricaConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      /* riscrive */
    }
  }
  const cfg = { token: randomBytes(16).toString("hex") };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 1));
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {}
  return cfg;
}

const config = caricaConfig();

if (args.includes("--print-config")) {
  console.log(`Ponte pronto.\n\nNell'estensione Chrome (Opzioni) inserisci:\n  URL ponte: ws://${BIND}:${PORT}\n  Token:     ${config.token}\n`);
  process.exit(0);
}

/* ---------- WebSocket: l'estensione Chrome si collega qui ---------- */
let socketEstensione = null;
const attese = new Map(); // id -> {resolve, reject, timer}
let prossimoId = 1;

const wss = new WebSocketServer({ port: PORT, host: BIND });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", `ws://${BIND}`);
  if (url.searchParams.get("token") !== config.token) {
    log("Connessione rifiutata: token errato");
    ws.close(1008, "token errato");
    return;
  }
  const ruolo = url.searchParams.get("role");
  if (ruolo === "client") {
    log("Client MCP collegato via WebSocket");
    ws.on("message", async (dati) => {
      let msg;
      try {
        msg = JSON.parse(String(dati));
      } catch {
        return;
      }
      await gestisci(msg, (testo) => ws.send(testo));
    });
    return;
  }
  if (socketEstensione) {
    log("Nuova connessione: sostituisco quella precedente");
    try {
      socketEstensione.close();
    } catch {}
  }
  socketEstensione = ws;
  log("Estensione Chrome collegata");

  ws.on("message", (dati) => {
    let msg;
    try {
      msg = JSON.parse(String(dati));
    } catch {
      return;
    }
    const attesa = attese.get(msg.id);
    if (!attesa) return;
    clearTimeout(attesa.timer);
    attese.delete(msg.id);
    if (msg.ok) attesa.resolve(msg.result);
    else attesa.reject(new Error(msg.error || "errore sconosciuto"));
  });

  ws.on("close", () => {
    if (socketEstensione === ws) socketEstensione = null;
    log("Estensione disconnessa");
  });
});

function log(...parti) {
  process.stderr.write(`[chrome-ai-bridge] ${parti.join(" ")}\n`);
}

function comando(action, params = {}, timeoutMs = 60000) {
  if (!socketEstensione || socketEstensione.readyState !== 1) {
    return Promise.reject(
      new Error("Estensione Chrome non collegata: apri Chrome con l'estensione attiva e controlla il token nelle opzioni."),
    );
  }
  const id = prossimoId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      attese.delete(id);
      reject(new Error(`Timeout (${timeoutMs}ms) per ${action}`));
    }, timeoutMs);
    attese.set(id, { resolve, reject, timer });
    socketEstensione.send(JSON.stringify({ id, action, params }));
  });
}

/* ---------- MCP su stdio ---------- */
const TOOLS = [
  {
    name: "browser_navigate",
    description: "Apre un URL nel browser dell'utente (nella scheda attiva).",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: ({ url }) => comando("navigate", { url }),
  },
  {
    name: "browser_tabs",
    description: "Gestisce le schede: list (elenca), new (apre), select (attiva), close (chiude).",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["list", "new", "select", "close"] }, index: { type: "number" }, url: { type: "string" } },
      required: ["action"],
    },
    run: (p) => comando("tabs", p),
  },
  {
    name: "browser_snapshot",
    description: "Legge la pagina attiva: testo e elenco di elementi interattivi numerati (ref da usare in click/type).",
    inputSchema: { type: "object", properties: { tab: { type: "number" } } },
    run: (p) => comando("snapshot", p),
  },
  {
    name: "browser_get_text",
    description: "Testo della pagina attiva (troncato).",
    inputSchema: { type: "object", properties: { max: { type: "number" }, tab: { type: "number" } } },
    run: (p) => comando("get_text", p),
  },
  {
    name: "browser_click",
    description: "Clicca un elemento: usa il ref dello snapshot (es. mcp-12), un selettore CSS, oppure text=Testo visibile.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, tab: { type: "number" } }, required: ["target"] },
    run: (p) => comando("click", p),
  },
  {
    name: "browser_type",
    description: "Scrive in un campo: ref dello snapshot o selettore CSS. submit=true per premere Invio.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" }, tab: { type: "number" } },
      required: ["target", "text"],
    },
    run: (p) => comando("type", p),
  },
  {
    name: "browser_evaluate",
    description: "Esegue JavaScript nella pagina attiva e ritorna il risultato.",
    inputSchema: { type: "object", properties: { expression: { type: "string" }, tab: { type: "number" } }, required: ["expression"] },
    run: (p) => comando("evaluate", p),
  },
  {
    name: "browser_screenshot",
    description: "Screenshot della pagina attiva (immagine).",
    inputSchema: { type: "object", properties: { tab: { type: "number" } } },
    run: (p) => comando("screenshot", p, 30000),
  },
];

function rispondi(invia, id, result) {
  invia(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
function rispondiErrore(invia, id, code, message) {
  invia(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (pezzo) => {
  buffer += pezzo;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const riga = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!riga) continue;
    let msg;
    try {
      msg = JSON.parse(riga);
    } catch {
      continue;
    }
    const inviaStdout = (testo) => process.stdout.write(testo + "\n");
    await gestisci(msg, inviaStdout);
  }
});

async function gestisci(msg, invia) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    rispondi(invia, id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "chrome-ai-bridge", version: "0.1.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "ping") {
    if (method === "ping") rispondi(invia, id, {});
    return;
  }
  if (method === "tools/list") {
    rispondi(invia, id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
    return;
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      rispondiErrore(invia, id, -32602, `Strumento sconosciuto: ${params?.name}`);
      return;
    }
    try {
      const esito = await tool.run(params.arguments ?? {});
      const contenuto = [];
      if (typeof esito === "string") {
        contenuto.push({ type: "text", text: esito });
      } else if (esito && esito.image) {
        contenuto.push({ type: "image", data: esito.image.data, mimeType: esito.image.mimeType });
        if (esito.text) contenuto.push({ type: "text", text: esito.text });
      } else {
        contenuto.push({ type: "text", text: JSON.stringify(esito, null, 1) });
      }
      rispondi(invia, id, { content: contenuto });
    } catch (exc) {
      rispondi(invia, id, { content: [{ type: "text", text: `Errore: ${exc.message}` }], isError: true });
    }
    return;
  }
  if (id !== undefined) rispondiErrore(invia, id, -32601, `Metodo non supportato: ${method}`);
}

log(`in ascolto su ws://${BIND}:${PORT} (config: ${CONFIG_PATH})`);
