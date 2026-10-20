const IG_URL = /^https:\/\/www\.instagram\.com\//;

chrome.action.onClicked.addListener(async (tab) => {
  // Fora do Instagram: abre o site e pede para o painel abrir assim que carregar.
  if (!tab.url || !IG_URL.test(tab.url)) {
    await chrome.storage.local.set({ fc_openOnLoad: true });
    chrome.tabs.create({ url: 'https://www.instagram.com/' });
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'FC_TOGGLE' });
  } catch {
    // Aba aberta antes da instalação da extensão: injeta o content script na hora.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'FC_TOGGLE' });
  }
});

// Baixa a foto de perfil pelo service worker (sem as restrições da página) e devolve como data URL.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'FC_IMG') return;
  (async () => {
    try {
      const res = await fetch(msg.url, { credentials: 'omit' });
      if (!res.ok) throw new Error(res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const type = res.headers.get('content-type') || 'image/jpeg';
      sendResponse({ dataUrl: `data:${type};base64,${btoa(bin)}` });
    } catch {
      sendResponse({ dataUrl: null });
    }
  })();
  return true;
});
