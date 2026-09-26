/**
 * Chrome AI Bridge: service worker dell'estensione.
 * Si collega al ponte locale (WebSocket) e esegue i comandi sul browser
 * tramite chrome.debugger (Chrome DevTools Protocol).
 *
 * Il ponte NON è raggiungibile da internet: ascolta su 127.0.0.1
 * (o sull'IP Tailscale se avviato con --bind).
 */

let ws = null;
let connesso = false;
const scheda = { allegate: new Set() };

chrome.alarms.create("riconnessione", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => { if (!connesso) collega(); });
collega();

async function configurazione() {
  const { bridgeUrl = "ws://127.0.0.1:8765", token = "" } = await chrome.storage.local.get(["bridgeUrl", "token"]);
  return { bridgeUrl, token };
}

async function collega() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const { bridgeUrl, token } = await configurazione();
  if (!token) return; // non configurata: niente da fare
  try {
    ws = new WebSocket(`${bridgeUrl}/?token=${encodeURIComponent(token)}`);
  } catch {
    return;
  }
  ws.onopen = () => { connesso = true; };
  ws.onclose = () => { connesso = false; ws = null; };
  ws.onerror = () => { connesso = false; };
  ws.onmessage = async (evento) => {
    let msg;
    try { msg = JSON.parse(evento.data); } catch { return; }
    try {
      const risultato = await esegui(msg.action, msg.params || {});
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: risultato }));
    } catch (errore) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(errore.message || errore) }));
    }
  };
}

/* ---------- helper CDP ---------- */

function debug(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (!err) { scheda.allegate.add(tabId); return resolve(); }
      if (/already attached/i.test(err.message || "")) { scheda.allegate.add(tabId); return resolve(); }
      if (/Another debugger|DevTools/i.test(err.message || "")) {
        return reject(new Error("Questa scheda è già controllata da DevTools o da un'altra estensione. Chiudi i DevTools e riprova."));
      }
      reject(new Error(err.message));
    });
  });
}

function invia(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (risultato) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(risultato);
    });
  });
}

async function schedaAttiva(tabRichiesta) {
  if (tabRichiesta) return tabRichiesta;
  const [attiva] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!attiva) throw new Error("Nessuna scheda attiva");
  return attiva.id;
}

async function valuta(tabId, expression) {
  const esito = await invia(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (esito.exceptionDetails) {
    throw new Error(esito.exceptionDetails.exception?.description || esito.exceptionDetails.text || "Errore JavaScript");
  }
  return esito.result?.value;
}

async function attendiCaricamento(tabId, timeoutMs = 30000) {
  const scadenza = Date.now() + timeoutMs;
  while (Date.now() < scadenza) {
    try {
      const stato = await valuta(tabId, "document.readyState");
      if (stato === "complete" || stato === "interactive") return;
    } catch { /* pagina in navigazione */ }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* ---------- azioni ---------- */

async function actionNavigate({ url, tab }) {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("Serve un URL http(s) valido");
  const tabId = await schedaAttiva(tab);
  await debug(tabId);
  await invia(tabId, "Page.enable");
  await invia(tabId, "Page.navigate", { url });
  await attendiCaricamento(tabId);
  const info = await chrome.tabs.get(tabId);
  return `Aperto: ${info.title || "(senza titolo)"} | ${info.url}`;
}

async function actionTabs({ action, index, url }) {
  if (action === "list") {
    const schede = await chrome.tabs.query({});
    return schede.map((t, i) => `[${i}] ${t.active ? "* " : ""}${(t.title || "").slice(0, 60)} | ${(t.url || "").slice(0, 80)}`).join("\n");
  }
  if (action === "new") {
    const creata = await chrome.tabs.create({ url: url || "about:blank" });
    return `Nuova scheda: ${creata.id}`;
  }
  const schede = await chrome.tabs.query({});
  const scelta = schede[index ?? 0];
  if (!scelta) throw new Error(`Scheda ${index} inesistente`);
  if (action === "select") {
    await chrome.tabs.update(scelta.id, { active: true });
    await chrome.windows.update(scelta.windowId, { focused: true });
    return `Attivata: ${(scelta.title || "").slice(0, 60)}`;
  }
  if (action === "close") {
    await chrome.tabs.remove(scelta.id);
    return "Scheda chiusa";
  }
  throw new Error(`Azione schede sconosciuta: ${action}`);
}

const SCRIPT_SNAPSHOT = `(() => {
  const elementi = [];
  const selettori = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[contenteditable=true]";
  document.querySelectorAll(selettori).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return;
    const stile = getComputedStyle(el);
    if (stile.visibility === "hidden" || stile.display === "none" || stile.opacity === "0") return;
    const ref = "mcp-" + (elementi.length + 1);
    el.setAttribute("data-mcp-id", ref);
    elementi.push({
      ref,
      tag: el.tagName.toLowerCase(),
      tipo: el.getAttribute("type") || "",
      testo: (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 80),
    });
  });
  const testo = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 4000);
  return { titolo: document.title, url: location.href, testo, elementi };
})()`;

async function actionSnapshot({ tab }) {
  const tabId = await schedaAttiva(tab);
  await debug(tabId);
  const dati = await valuta(tabId, SCRIPT_SNAPSHOT);
  const elenco = (dati.elementi || []).map((e) => `${e.ref} | ${e.tag}${e.tipo ? "[" + e.tipo + "]" : ""} | ${e.testo}`).join("\n");
  return `# ${dati.titolo}\n${dati.url}\n\n## Elementi interattivi\n${elenco || "(nessuno)"}\n\n## Testo\n${dati.testo || ""}`;
}

async function actionFind({ query, tab }) {
  if (!query) throw new Error("Serve un testo da cercare");
  const tabId = await schedaAttiva(tab);
  await debug(tabId);
  const frase = String(query).replace(/"/g, '\\"');
  const esito = await valuta(tabId, `(() => {
    const frase = "${frase}".toLowerCase();
    const trovati = [];
    const candidati = Array.from(document.querySelectorAll("a,button,[role=button],input,select,textarea,summary,li,td,h1,h2,h3,p,span,div"))
      .filter(el => {
        const testo = (el.innerText || el.value || el.placeholder || "").toLowerCase();
        if (!testo.includes(frase)) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) return false;
        const figli = Array.from(el.children).some(c => ((c.innerText || "").toLowerCase().includes(frase)));
        return !figli; // preferisci l'elemento piu' specifico
      });
    candidati.slice(0, 20).forEach(el => {
      const ref = "mcp-" + (trovati.length + 1);
      el.setAttribute("data-mcp-id", ref);
      const r = el.getBoundingClientRect();
      trovati.push({ ref, tag: el.tagName.toLowerCase(), testo: (el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 100), x: Math.round(r.left), y: Math.round(r.top) });
    });
    return trovati;
  })()`);
  if (!Array.isArray(esito) || !esito.length) return `Nessuna occorrenza di "${query}" nella pagina.`;
  return `Trovate ${esito.length} occorrenze di "${query}":\n` + esito.map(e => `${e.ref} | ${e.tag} | (${e.x},${e.y}) | ${e.testo}`).join("\n");
}

async function actionGetText({ max = 4000, tab }) {
  const tabId = await schedaAttiva(tab);
  await debug(tabId);
  const testo = await valuta(tabId, "document.body ? document.body.innerText : ''");
  return String(testo || "").slice(0, max);
}

function espressionePerTarget(target) {
  const t = String(target || "").replace(/"/g, '\\"');
  if (/^mcp-\d+$/.test(t)) return `document.querySelector('[data-mcp-id="${t}"]')`;
  if (t.startsWith("text=")) {
    const frase = t.slice(5).replace(/"/g, '\\"');
    return `(() => {
      const candidati = Array.from(document.querySelectorAll("a,button,[role=button],input,select,textarea,summary,label,span,div"))
        .filter(el => (el.innerText || "").toLowerCase().includes("${frase}".toLowerCase()));
      return candidati.find(el => el.offsetParent !== null) || null;
    })()`;
  }
  return `document.querySelector("${t}")`;
}

async function actionClick({ target, tab }) {
  const tabId = await schedaAttiva(tab);
  await debug(tabId);
  const espressione = espressionePerTarget(target);
  const pos = await valuta(tabId, `(() => {
    const el = ${espressione};
    if (!el) return null;
    el.scrollIntoView({block: "center"});
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase() };
  })()`);
  if (!pos) throw new Error(`Elemento non trovato: ${target}`);
  await invia(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await invia(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 800));
  const dopotitolo = await valuta(tabId, "document.title");
  return `Cliccato ${target} (${pos.tag}) | ora: ${dopotitolo}`;
}

async function actionType({ target, text, submit, tab }) {
  const tabId = await schedaAttiva(tab);
  await debug(tabId);
  const espressione = espressionePerTarget(target);
  const trovato = await valuta(tabId, `(() => {
    const el = ${espressione};
    if (!el) return false;
    el.scrollIntoView({block: "center"});
    el.focus();
    if (el.isContentEditable) { el.textContent = ""; }
    else if ("value" in el) {
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value")?.set;
      setter ? setter.call(el, "") : (el.value = "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  })()`);
  if (!trovato) throw new Error(`Campo non trovato: ${target}`);
  await invia(tabId, "Input.insertText", { text });
  if (submit) {
    await invia(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await invia(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await new Promise((r) => setTimeout(r, 1200));
  }
  return `Scritto in ${target}${submit ? " + Invio" : ""}`;
}

async function actionEvaluate({ expression, tab }) {
  if (!expression) throw new Error("Serve una espressione JavaScript");
  const tabId = await schedaAttiva(tab);
  await debug(tabId);
  const risultato = await valuta(tabId, expression);
  return typeof risultato === "string" ? risultato : JSON.stringify(risultato, null, 1);
}

async function actionScreenshot({ tab }) {
  const tabId = await schedaAttiva(tab);
  await debug(tabId);
  const scatto = await invia(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
  const info = await chrome.tabs.get(tabId);
  return { image: { data: scatto.data, mimeType: "image/jpeg" }, text: `Screenshot: ${info.title || ""} | ${info.url || ""}` };
}

async function esegui(action, params) {
  switch (action) {
    case "navigate": return actionNavigate(params);
    case "tabs": return actionTabs(params);
    case "snapshot": return actionSnapshot(params);
    case "get_text": return actionGetText(params);
    case "find": return actionFind(params);
    case "click": return actionClick(params);
    case "type": return actionType(params);
    case "evaluate": return actionEvaluate(params);
    case "screenshot": return actionScreenshot(params);
    default: throw new Error(`Azione sconosciuta: ${action}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, rispondi) => {
  if (msg?.tipo === "stato") rispondi({ connesso, url: ws?.url || null });
  if (msg?.tipo === "collega") collega().then(() => rispondi({ ok: true }));
  return true;
});
