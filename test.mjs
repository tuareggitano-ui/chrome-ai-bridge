/* Test end-to-end: spawn del ponte + estensione finta che risponde ai comandi. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const PORTA = 8790;
const attese = new Map();
let esiti = 0, falliti = 0;
const check = (nome, ok, extra = "") => { ok ? esiti++ : falliti++; console.log(`${ok ? "PASS" : "FAIL"} ${nome}${extra ? " | " + extra : ""}`); };

const watchdog = setTimeout(() => { console.log("TIMEOUT del test"); ponte.kill("SIGKILL"); process.exit(2); }, 22000);

const ponte = spawn("node", ["bridge.mjs"], { cwd: "/root/chrome-ai-bridge", stdio: ["pipe", "pipe", "ignore"] });
ponte.stdout.setEncoding("utf8");
let buffer = "";
ponte.stdout.on("data", (pezzo) => {
  buffer += pezzo;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const riga = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
    if (!riga) continue;
    const msg = JSON.parse(riga);
    const attesa = attese.get(msg.id);
    if (attesa) { attese.delete(msg.id); attesa(msg); }
  }
});

const invia = (id, method, params) => new Promise((resolve) => {
  attese.set(id, resolve);
  ponte.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});

await new Promise((r) => setTimeout(r, 1500));

const config = JSON.parse(readFileSync(join(homedir(), ".chrome-ai-bridge.json"), "utf8"));
const ws = new WebSocket(`ws://127.0.0.1:${PORTA}/?token=${config.token}`);
ws.on("message", (d) => {
  const msg = JSON.parse(String(d));
  const risultato = msg.action === "screenshot"
    ? { image: { data: "AAAA", mimeType: "image/jpeg" }, text: "MOCK screenshot" }
    : `MOCK:${msg.action}`;
  ws.send(JSON.stringify({ id: msg.id, ok: true, result: risultato }));
});
await new Promise((r) => ws.on("open", r));

const init = await invia(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {} });
check("initialize", init?.result?.serverInfo?.name === "chrome-ai-bridge");
const lista = await invia(2, "tools/list");
const nomi = (lista?.result?.tools ?? []).map((t) => t.name);
check("tools/list (8 strumenti)", nomi.length === 8, nomi.join(","));
const chiamata = await invia(3, "tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
check("tools/call navigate", chiamata?.result?.content?.[0]?.text === "MOCK:navigate", JSON.stringify(chiamata).slice(0, 140));
const scatto = await invia(4, "tools/call", { name: "browser_screenshot", arguments: {} });
check("tools/call screenshot (immagine)", scatto?.result?.content?.[0]?.type === "image");

console.log(`\nRISULTATO: ${esiti} PASS, ${falliti} FAIL`);
clearTimeout(watchdog);
ponte.kill("SIGKILL");
ws.close();
process.exit(falliti ? 1 : 0);
