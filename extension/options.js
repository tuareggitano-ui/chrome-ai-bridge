/* Impostazioni dell'estensione: salva URL e token, mostra lo stato. */

const campoUrl = document.getElementById("bridgeUrl");
const campoToken = document.getElementById("token");
const esito = document.getElementById("esito");

async function carica() {
  const { bridgeUrl = "ws://127.0.0.1:8765", token = "" } = await chrome.storage.local.get(["bridgeUrl", "token"]);
  campoUrl.value = bridgeUrl;
  campoToken.value = token;
  aggiornaStato();
}

async function aggiornaStato() {
  const risposta = await chrome.runtime.sendMessage({ tipo: "stato" });
  if (risposta?.connesso) {
    esito.innerHTML = '<span class="ok">Collegato al ponte</span>';
  } else {
    esito.innerHTML = '<span class="ko">Non collegato</span> (controlla che il ponte sia avviato e che il token sia giusto)';
  }
}

document.getElementById("salva").addEventListener("click", async () => {
  await chrome.storage.local.set({
    bridgeUrl: campoUrl.value.trim() || "ws://127.0.0.1:8765",
    token: campoToken.value.trim(),
  });
  esito.textContent = "Salvato, provo a collegare...";
  await chrome.runtime.sendMessage({ tipo: "collega" });
  setTimeout(aggiornaStato, 1500);
});

document.getElementById("stato").addEventListener("click", aggiornaStato);

carica();
