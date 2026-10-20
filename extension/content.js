(() => {
  if (window.__followerCheckLoaded) return;
  window.__followerCheckLoaded = true;

  // Mesmo App ID que o instagram.com web envia no header X-IG-App-ID (ver insta.html).
  const APP_ID = '936619743392459';
  const PAGE_SIZE = 50;
  const API = 'https://www.instagram.com/api/v1';

  const state = {
    running: false,
    cancel: false,
    uid: null,
    username: null,
    followers: [],
    following: [],
    updatedAt: null,
    tab: 'notBack', // 'notBack' | 'fans' | 'ignored'
    ignored: new Set(),
    search: '',
    hideVerified: false,
  };

  // ---------- utilidades ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => min + Math.random() * (max - min);

  function getCookie(name) {
    const row = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
    return row ? decodeURIComponent(row.slice(name.length + 1)) : null;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function igFetch(path, { method = 'GET', body, retries = 5 } = {}) {
    const headers = {
      'X-IG-App-ID': APP_ID,
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (method !== 'GET') {
      headers['X-CSRFToken'] = getCookie('csrftoken') || '';
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    let lastError = '';
    for (let attempt = 0; attempt < retries; attempt++) {
      if (state.cancel) throw new Error('Cancelado.');
      const res = await fetch(API + path, { method, body, headers, credentials: 'include' });

      let data = null;
      try { data = await res.json(); } catch { /* resposta não-JSON */ }
      const detail = `HTTP ${res.status}${data?.message ? ` – ${data.message}` : ''}`;
      console.debug('[Follower Check]', method, path, detail, data);

      if (res.status === 401 || data?.message === 'login_required' || data?.require_login) {
        throw new Error('Sessão inválida. Faça login no Instagram e tente novamente.');
      }

      const rateLimited = res.status === 429 ||
        (data?.status === 'fail' && /wait|aguarde|few minutes/i.test(data.message || ''));
      if (rateLimited || res.status >= 500) {
        lastError = detail;
        if (attempt + 1 >= retries) break;
        // 429 = limite real (espera longa); 5xx = instabilidade (espera curta).
        const wait = rateLimited ? 60_000 * (attempt + 1) : 5_000 * (attempt + 1);
        setStatus(`Instagram respondeu ${detail}. Tentando de novo em ${wait / 1000}s…`);
        for (let t = 0; t < wait && !state.cancel; t += 1000) await sleep(1000);
        continue;
      }
      if (!res.ok || !data || data.status === 'fail') {
        throw new Error(`Instagram respondeu ${detail}`);
      }
      return data;
    }
    throw new Error(`Instagram continua recusando (${lastError}). Tente novamente mais tarde.`);
  }

  async function fetchList(uid, kind, total, label) {
    const users = new Map();
    let maxId = '';
    let page = 0;
    do {
      const qs = new URLSearchParams({ count: PAGE_SIZE });
      if (kind === 'followers') qs.set('search_surface', 'follow_list_page');
      if (maxId) qs.set('max_id', maxId);

      const data = await igFetch(`/friendships/${uid}/${kind}/?${qs}`);
      for (const u of data.users || []) {
        users.set(String(u.pk), {
          pk: String(u.pk),
          username: u.username,
          full_name: u.full_name || '',
          pic: u.profile_pic_url || '',
          is_private: !!u.is_private,
          is_verified: !!u.is_verified,
        });
      }
      maxId = data.next_max_id || '';
      page++;

      const pct = total ? Math.min(100, Math.round((users.size / total) * 100)) : null;
      setStatus(`Carregando ${label}: ${users.size}${total ? ` de ${total}` : ''}…`, pct);

      // Pausas para não disparar o rate limit do Instagram.
      if (maxId) await sleep(page % 10 === 0 ? jitter(4000, 7000) : jitter(700, 1500));
    } while (maxId);
    return [...users.values()];
  }

  // ---------- persistência ----------

  const storeKey = () => `fc_data_${state.uid}`;

  async function loadSaved() {
    const key = storeKey();
    const ignKey = `fc_ignored_${state.uid}`;
    const saved = await chrome.storage.local.get([key, ignKey]);
    if (saved[key]) Object.assign(state, saved[key]);
    state.ignored = new Set(saved[ignKey] || []);
  }

  function saveData() {
    return chrome.storage.local.set({
      [storeKey()]: {
        username: state.username,
        followers: state.followers,
        following: state.following,
        updatedAt: state.updatedAt,
      },
    });
  }

  function saveIgnored() {
    return chrome.storage.local.set({ [`fc_ignored_${state.uid}`]: [...state.ignored] });
  }

  // ---------- lógica ----------

  function computeLists() {
    const followerIds = new Set(state.followers.map((u) => u.pk));
    const followingIds = new Set(state.following.map((u) => u.pk));
    const notBackAll = state.following.filter((u) => !followerIds.has(u.pk));
    return {
      notBack: notBackAll.filter((u) => !state.ignored.has(u.pk)),
      ignored: notBackAll.filter((u) => state.ignored.has(u.pk)),
      fans: state.followers.filter((u) => !followingIds.has(u.pk)),
    };
  }

  function currentList() {
    let list = computeLists()[state.tab];
    const q = state.search.trim().toLowerCase();
    if (q) {
      list = list.filter((u) =>
        u.username.toLowerCase().includes(q) || u.full_name.toLowerCase().includes(q));
    }
    if (state.hideVerified) list = list.filter((u) => !u.is_verified);
    return list;
  }

  async function scan() {
    if (state.running) return;
    state.running = true;
    state.cancel = false;
    render();
    try {
      setStatus('Buscando informações do perfil…');
      let followerCount = 0;
      let followingCount = 0;
      try {
        // Só serve para mostrar o @ e o total no progresso: uma tentativa, sem espera.
        const info = await igFetch(`/users/${state.uid}/info/`, { retries: 1 });
        state.username = info.user?.username || state.username;
        followerCount = info.user?.follower_count || 0;
        followingCount = info.user?.following_count || 0;
      } catch (e) {
        if (state.cancel) throw e;
        // Sem contagem total: o progresso só mostra o número carregado.
      }

      state.following = await fetchList(state.uid, 'following', followingCount, 'quem você segue');
      await sleep(jitter(1500, 3000));
      state.followers = await fetchList(state.uid, 'followers', followerCount, 'seus seguidores');
      state.updatedAt = Date.now();
      await saveData();
      setStatus('');
    } catch (e) {
      setStatus(e.message, null, true);
    } finally {
      state.running = false;
      render();
    }
  }

  async function unfollow(pk, btn) {
    const user = state.following.find((u) => u.pk === pk);
    if (!user || !confirm(`Deixar de seguir @${user.username}?`)) return;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await igFetch(`/friendships/destroy/${pk}/`, { method: 'POST', body: '' });
      state.following = state.following.filter((u) => u.pk !== pk);
      await saveData();
      render();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Deixar de seguir';
      setStatus(`Falha ao deixar de seguir @${user.username}: ${e.message}`, null, true);
    }
  }

  function toggleIgnore(pk) {
    if (state.ignored.has(pk)) state.ignored.delete(pk);
    else state.ignored.add(pk);
    saveIgnored();
    render();
  }

  function exportCsv() {
    const list = currentList();
    const rows = [['username', 'nome', 'privado', 'verificado', 'url']];
    for (const u of list) {
      rows.push([u.username, u.full_name, u.is_private ? 'sim' : 'nao', u.is_verified ? 'sim' : 'nao',
        `https://www.instagram.com/${u.username}/`]);
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.username || state.uid}_${state.tab}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyUsernames(btn) {
    await navigator.clipboard.writeText(currentList().map((u) => '@' + u.username).join('\n'));
    const old = btn.textContent;
    btn.textContent = 'Copiado!';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }

  // ---------- UI (Shadow DOM para isolar do CSS do Instagram) ----------

  let host, root;

  const CSS = `
    :host { all: initial; color-scheme: light; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .panel {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      width: 400px; max-height: calc(100vh - 32px); display: flex; flex-direction: column;
      background: #fff; color: #111; border-radius: 14px; overflow: hidden;
      box-shadow: 0 12px 40px rgba(0,0,0,.35); font-size: 14px;
    }
    header { display: flex; align-items: center; gap: 8px; padding: 14px 16px;
      background: linear-gradient(45deg, #f58529, #dd2a7b, #8134af); color: #fff; }
    header h1 { flex: 1; margin: 0; font-size: 16px; font-weight: 700; }
    header small { display: block; font-weight: 400; opacity: .9; font-size: 12px; }
    .icon-btn { background: rgba(255,255,255,.2); border: 0; color: #fff; width: 28px; height: 28px;
      border-radius: 50%; cursor: pointer; font-size: 18px; line-height: 1; padding: 0;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .icon-btn:hover { background: rgba(255,255,255,.35); }
    .body { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1; }
    button.primary { background: #0095f6; color: #fff; border: 0; border-radius: 8px; padding: 9px 14px;
      font-weight: 600; cursor: pointer; font-size: 14px; }
    button.primary:hover { background: #1877f2; }
    button.primary:disabled { opacity: .6; cursor: default; }
    button.ghost { background: #efefef; color: #111; border: 0; border-radius: 8px; padding: 7px 10px;
      font-weight: 600; cursor: pointer; font-size: 12px; }
    button.ghost:hover { background: #dbdbdb; }
    button.danger { background: #fff; color: #ed4956; border: 1px solid #ed4956; }
    button.danger:hover { background: #ed4956; color: #fff; }
    .row { display: flex; gap: 8px; align-items: center; }
    .status { font-size: 12px; color: #555; }
    .status.error { color: #ed4956; }
    .bar { height: 4px; background: #efefef; border-radius: 2px; overflow: hidden; }
    .bar > div { height: 100%; background: #0095f6; transition: width .3s; }
    .tabs { display: flex; border-bottom: 1px solid #dbdbdb; }
    .tabs button { flex: 1; background: none; border: 0; padding: 8px 4px; cursor: pointer; font-size: 12px;
      font-weight: 600; color: #737373; border-bottom: 2px solid transparent; }
    .tabs button.active { color: #111; border-bottom-color: #111; }
    input[type=search] { flex: 1; padding: 7px 10px; border: 1px solid #dbdbdb; border-radius: 8px; font-size: 13px;
      background: #fafafa; color: #111; outline: none; }
    input[type=search]:focus { border-color: #a8a8a8; background: #fff; }
    input[type=search]::placeholder { color: #8e8e8e; }
    input[type=checkbox] { accent-color: #0095f6; }
    label { font-size: 12px; color: #555; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
    ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; min-height: 120px; }
    li { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid #f2f2f2; }
    .avatar { position: relative; width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; overflow: hidden;
      background: linear-gradient(45deg, #f58529, #dd2a7b, #8134af); color: #fff; font-weight: 700; font-size: 16px;
      display: flex; align-items: center; justify-content: center; text-transform: uppercase; }
    .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    li .info { flex: 1; min-width: 0; }
    li a { color: #111; font-weight: 600; text-decoration: none; }
    li a:hover { text-decoration: underline; }
    li .name { font-size: 12px; color: #737373; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .badge { color: #0095f6; font-size: 12px; }
    .lock { font-size: 11px; }
    li .actions { display: flex; gap: 4px; }
    li .actions button { padding: 5px 8px; font-size: 11px; }
    .empty { color: #737373; text-align: center; padding: 24px 0; font-size: 13px; }
    .meta { font-size: 11px; color: #737373; }
  `;

  function ensureUi() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'follower-check-root';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="panel"></div>`;
    document.documentElement.appendChild(host);

    // Delegação de eventos: o conteúdo do painel é re-renderizado com frequência.
    const panel = root.querySelector('.panel');
    panel.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      const { action, pk, tab } = btn.dataset;
      if (action === 'close') hide();
      else if (action === 'scan') scan();
      else if (action === 'cancel') { state.cancel = true; setStatus('Cancelando…'); }
      else if (action === 'tab') { state.tab = tab; render(); }
      else if (action === 'unfollow') unfollow(pk, btn);
      else if (action === 'ignore') toggleIgnore(pk);
      else if (action === 'csv') exportCsv();
      else if (action === 'copy') copyUsernames(btn);
    });
    panel.addEventListener('input', (ev) => {
      if (ev.target.matches('input[type=search]')) {
        state.search = ev.target.value;
        renderList();
      } else if (ev.target.matches('input[name=hideVerified]')) {
        state.hideVerified = ev.target.checked;
        renderList();
      }
    });
    // Evita que os atalhos de teclado do Instagram capturem o que é digitado na busca.
    panel.addEventListener('keydown', (ev) => ev.stopPropagation());
    // Se a foto não carregar direto, pede para o service worker baixá-la; se falhar de novo, fica a inicial.
    panel.addEventListener('error', async (ev) => {
      const img = ev.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (img.dataset.retried) { img.remove(); return; }
      img.dataset.retried = '1';
      const res = await chrome.runtime.sendMessage({ type: 'FC_IMG', url: img.src }).catch(() => null);
      if (res?.dataUrl) img.src = res.dataUrl;
      else img.remove();
    }, true);
  }

  let statusText = '';
  let statusPct = null;
  let statusError = false;

  function setStatus(text, pct = null, error = false) {
    statusText = text;
    statusPct = pct;
    statusError = error;
    const el = root?.querySelector('.status-wrap');
    if (el) el.innerHTML = statusHtml();
  }

  function statusHtml() {
    if (!statusText) return '';
    return `<div class="status ${statusError ? 'error' : ''}">${esc(statusText)}</div>` +
      (statusPct != null ? `<div class="bar"><div style="width:${statusPct}%"></div></div>` : '');
  }

  function render() {
    if (!root) return;
    const panel = root.querySelector('.panel');
    const hasData = state.updatedAt != null;
    const lists = hasData ? computeLists() : null;

    panel.innerHTML = `
      <header>
        <h1>Follower Check<small>${state.username ? '@' + esc(state.username) : 'Quem não te segue de volta'}</small></h1>
        <button class="icon-btn" data-action="close" title="Fechar">×</button>
      </header>
      <div class="body">
        <div class="row">
          ${state.running
            ? `<button class="primary" disabled>Analisando…</button>
               <button class="ghost" data-action="cancel">Cancelar</button>`
            : `<button class="primary" data-action="scan">${hasData ? 'Atualizar análise' : 'Analisar seguidores'}</button>`}
          ${hasData ? `<span class="meta">Seguidores: ${state.followers.length} · Seguindo: ${state.following.length}<br>
            Atualizado em ${new Date(state.updatedAt).toLocaleString('pt-BR')}</span>` : ''}
        </div>
        <div class="status-wrap">${statusHtml()}</div>
        ${hasData ? `
          <div class="tabs">
            <button data-action="tab" data-tab="notBack" class="${state.tab === 'notBack' ? 'active' : ''}">Não te seguem (${lists.notBack.length})</button>
            <button data-action="tab" data-tab="fans" class="${state.tab === 'fans' ? 'active' : ''}">Você não segue (${lists.fans.length})</button>
            <button data-action="tab" data-tab="ignored" class="${state.tab === 'ignored' ? 'active' : ''}">Ignorados (${lists.ignored.length})</button>
          </div>
          <div class="row">
            <input type="search" placeholder="Buscar…" value="${esc(state.search)}">
            <label><input type="checkbox" name="hideVerified" ${state.hideVerified ? 'checked' : ''}>Ocultar verificados</label>
          </div>
          <div class="row">
            <button class="ghost" data-action="copy">Copiar @s</button>
            <button class="ghost" data-action="csv">Exportar CSV</button>
          </div>
          <ul></ul>
        ` : state.running ? '' : `<div class="empty">Clique em "Analisar seguidores" para comparar quem você segue com quem te segue.<br><br>
              Contas grandes podem levar alguns minutos — o Instagram limita a velocidade das requisições.</div>`}
      </div>`;
    if (hasData) renderList();
  }

  function renderList() {
    const ul = root?.querySelector('ul');
    if (!ul) return;
    const list = currentList();
    if (!list.length) {
      ul.innerHTML = `<li class="empty" style="display:block;border:0">${
        state.tab === 'notBack' ? 'Todo mundo que você segue te segue de volta 🎉' : 'Nenhuma conta aqui.'}</li>`;
      return;
    }
    ul.innerHTML = list.map((u) => `
      <li>
        <div class="avatar">${esc(u.username[0] || '?')}<img src="${esc(u.pic)}" loading="lazy" alt=""></div>
        <div class="info">
          <a href="https://www.instagram.com/${esc(u.username)}/" target="_blank" rel="noopener">${esc(u.username)}</a>
          ${u.is_verified ? '<span class="badge" title="Verificado">✔</span>' : ''}
          ${u.is_private ? '<span class="lock" title="Conta privada">🔒</span>' : ''}
          <div class="name">${esc(u.full_name)}</div>
        </div>
        <div class="actions">
          ${state.tab !== 'fans' ? `
            <button class="ghost" data-action="ignore" data-pk="${u.pk}" title="${state.tab === 'ignored' ? 'Voltar para a lista' : 'Não mostrar mais esta conta'}">${state.tab === 'ignored' ? 'Restaurar' : 'Ignorar'}</button>
            <button class="ghost danger" data-action="unfollow" data-pk="${u.pk}">Deixar de seguir</button>` : ''}
        </div>
      </li>`).join('');
  }

  // ---------- abrir/fechar ----------

  async function show() {
    const uid = getCookie('ds_user_id');
    ensureUi();
    host.style.display = '';
    if (!uid) {
      root.querySelector('.panel').innerHTML = `
        <header><h1>Follower Check</h1><button class="icon-btn" data-action="close">×</button></header>
        <div class="body"><div class="empty">Faça login no Instagram para usar a extensão.</div></div>`;
      return;
    }
    if (uid !== state.uid) {
      state.uid = uid;
      state.followers = [];
      state.following = [];
      state.updatedAt = null;
      state.username = null;
      await loadSaved();
    }
    render();
  }

  function hide() {
    if (host) host.style.display = 'none';
  }

  function toggle() {
    if (host && host.style.display !== 'none') hide();
    else show();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'FC_TOGGLE') {
      toggle();
      sendResponse({ ok: true });
    }
  });

  chrome.storage.local.get('fc_openOnLoad').then(({ fc_openOnLoad }) => {
    if (fc_openOnLoad) {
      chrome.storage.local.remove('fc_openOnLoad');
      show();
    }
  });
})();
