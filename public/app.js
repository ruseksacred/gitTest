const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const seconds = score => score == null ? '—' : (score / 100).toFixed(2);
let user = null, socket = null, mode = 'solo', size = 4, game = null, stats = null, authMode = 'login', renderKey = '', serverOffset = 0, toastTimer, connected = false;
const dialog = $('#auth-dialog');
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Nie udało się połączyć z serwerem.');
  return data;
}
function command(action, payload = {}) {
  if (!user) { openAuth(); return; }
  if (!connected || socket?.readyState !== WebSocket.OPEN) { toast('Brak połączenia. Użyj przycisku „Połącz ponownie”.'); return; }
  socket.send(JSON.stringify({ action, ...payload }));
}
function connect() {
  if (!user || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket = ws;
  ws.addEventListener('message', event => {
    if (socket !== ws) return;
    const data = JSON.parse(event.data);
    if (data.type === 'connected') { connected = true; $('#connection-banner').hidden = true; updateAccount(); }
    if (data.type === 'error') toast(data.message);
    if (data.type === 'state') {
      const old = game;
      game = data.game;
      if (game) {
        serverOffset = game.serverNow - Date.now();
        const currentMe = game.players.find(p => p.me), oldMe = old?.players.find(p => p.me);
        if (oldMe && currentMe?.errors > oldMe.errors) { $('#game').classList.remove('flash-error'); void $('#game').offsetWidth; $('#game').classList.add('flash-error'); }
      }
      renderGame();
      if (game?.phase === 'complete' || !game) refreshStats();
    }
  });
  ws.addEventListener('close', event => {
    if (socket !== ws) return;
    connected = false;
    if (user) {
      $('#connection-message').textContent = event.code === 4001 ? 'To konto jest już otwarte w innej karcie. Zamknij ją, aby zagrać tutaj.' : event.code === 4003 ? 'Sesja wygasła. Zaloguj się ponownie.' : 'Utracono połączenie. Aktywny pojedynek zostanie zakończony walkowerem.';
      $('#connection-banner').hidden = false;
      document.querySelectorAll('#game .number-cell, #ready-button').forEach(button => { button.disabled = true; });
    }
    updateAccount();
  });
  ws.addEventListener('error', () => {});
}
function updateAccount() {
  $('#account').innerHTML = user ? `<span class="user-chip">${escape(user.username)}</span><button class="logout" data-action="logout">Wyloguj</button>` : '<button class="button small secondary" data-action="auth">Zaloguj się <span>→</span></button>';
  $('#setup-footnote').textContent = user ? connected ? 'Twój wynik zapisze się automatycznie. Gotowy na start?' : 'Łączenie z centrum treningowym…' : 'Zaloguj się, żeby zapisywać wyniki i śledzić postępy.';
}
function setup() {
  document.querySelectorAll('[data-mode]').forEach(b => { const selected = b.dataset.mode === mode; b.classList.toggle('selected', selected); b.setAttribute('aria-selected', selected); });
  document.querySelectorAll('[data-size]').forEach(b => { const selected = +b.dataset.size === size; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', selected); });
  $('#size-description').textContent = `${size ** 2} liczb · ${size === 3 ? 'rozgrzewka' : size === 4 ? 'standard' : 'wyzwanie'}`;
  $('#mode-title').textContent = mode === 'solo' ? 'Ty kontra stoper.' : 'Dwa kokpity. Jeden zwycięzca.';
  $('#mode-description').textContent = mode === 'solo' ? 'Klikaj liczby od 1 do ostatniej, w rosnącej kolejności. Liczy się szybkość. I precyzja.' : 'Zaproś znajomego kodem pokoju. Ta sama plansza, wspólny start — wygrywa krótszy czas z karami.';
  $('#start-button').innerHTML = `${mode === 'solo' ? 'Rozpocznij trening' : 'Utwórz pokój'} <span>→</span>`;
  $('#join-section').hidden = mode !== 'duel';
  const preview = Array.from({ length: size ** 2 }, (_, i) => i + 1);
  for (let i = preview.length - 1; i > 0; i--) { const j = (i * 7 + 3) % (i + 1); [preview[i], preview[j]] = [preview[j], preview[i]]; }
  $('#preview-board').className = `preview-board preview-${size}`;
  $('#preview-board').innerHTML = preview.map(n => `<span${n === 1 ? ' class="preview-active"' : ''}>${n}</span>`).join('');
  renderStats();
}
async function refreshStats() { if (!user) return; try { stats = await api('stats'); renderStats(); } catch (error) { toast(error.message); } }
function renderStats() {
  const record = stats?.records.find(r => r.size === size);
  $('#record-size').textContent = `${size} × ${size}`;
  $('#best-time').textContent = seconds(record?.best);
  $('#record-meta').textContent = record ? `${record.runs} ukończonych treningów · średnio ${seconds(record.average)} s` : 'Twój pierwszy rekord czeka na start.';
  for (const key of ['wins', 'losses', 'draws']) $(`#total-${key}`).textContent = stats?.totals[key] || 0;
  const outcomes = { win: 'WYGRANA', loss: 'PRZEGRANA', draw: 'REMIS', solo: 'TRENING' };
  $('#history').innerHTML = stats?.history.length ? stats.history.slice(0, 6).map(h => `<div class="history-row"><div><strong>${h.mode === 'solo' ? 'Trening solo' : `vs ${escape(h.opponent)}`} <span class="muted">${h.size} × ${h.size}</span></strong><small>${new Date(h.finished_at).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' })} · ${outcomes[h.outcome]}${h.reason === 'forfeit' ? ' · WALKOWER' : h.reason === 'timeout' ? ' · LIMIT CZASU' : ''}</small></div><div class="history-score">${seconds(h.score)}${h.score == null ? '' : ' s'}<small>${h.errors} bł. / +${h.errors} s</small></div></div>`).join('') : '<div class="empty-history"><span>⚑</span><p>Tu zaczyna się Twoja historia.</p><small>Ukończ trening lub pierwszy pojedynek.</small></div>';
}
function shell(content) {
  return `<div class="game-body"><div class="game-top"><span class="eyebrow">${game.mode === 'solo' ? 'TRENING SOLO' : `POJEDYNEK / ${escape(game.code)}`} · ${game.size} × ${game.size}</span><button data-action="leave">${game.phase === 'complete' ? 'Wróć do centrum' : 'Opuść'} →</button></div>${content}<div id="leave-confirm" class="confirm-leave" hidden><p>${game.mode === 'duel' ? 'Wyjście po rozpoczęciu odliczania oznacza przegraną walkowerem.' : 'Bieżący trening nie zostanie zapisany.'}</p><div><button class="button small secondary" data-action="confirm-leave">Opuść grę</button><button class="button small primary" data-action="cancel-leave">Zostań</button></div></div></div>`;
}
function renderGame() {
  document.body.classList.toggle('in-game', !!game);
  $('#setup').hidden = !!game; $('#game').hidden = !game;
  if (!game) { renderKey = ''; $('#game').innerHTML = ''; setup(); return; }
  const me = game.players.find(p => p.me), opponent = game.players.find(p => !p.me);
  const key = `${game.id}:${game.phase}`;
  if (game.phase === 'waiting') {
    $('#game').innerHTML = shell(`<div class="waiting-room"><span class="eyebrow">GRID IS OPEN</span><h3>Zaproś rywala na start.</h3><p>Przekaż kod drugiej osobie.<br>Oboje kliknijcie „Gotowość”, aby rozpocząć.</p><div class="room-code" id="display-code">${escape(game.code)}</div><button class="auth-switch" data-action="copy-code">Kopiuj kod →</button><div class="players">${[me, opponent].map(p => `<div class="player-slot"><div class="avatar">${p ? escape(p.username[0].toUpperCase()) : '?'}</div><strong>${p ? escape(p.username) : 'Miejsce dla rywala'}</strong><small>${p ? p.ready ? '● Gotowość' : 'Na polach startowych' : 'Czekamy na dołączenie…'}</small></div>`).join('')}</div><button class="button primary" id="ready-button" data-action="ready" ${!opponent || me.ready ? 'disabled' : ''}>${me.ready ? 'Czekamy na gotowość rywala…' : opponent ? 'Gotowość — jedziemy →' : 'Czekamy na drugiego gracza…'}</button></div>`);
  } else if (game.phase === 'countdown') {
    if (key !== renderKey) $('#game').innerHTML = shell('<div class="countdown"><span class="eyebrow">SKUP SIĘ NA STARCIE</span><h3>Za chwilę zielone światło.</h3><div class="lights" aria-hidden="true"><span></span><span></span><span></span></div><div class="countdown-number" id="countdown-number">3</div><p>Znajdź 1. Dalej liczy się Twój rytm.</p></div>');
  } else if (game.phase === 'saving') {
    $('#game').innerHTML = shell('<div class="result-header"><span class="result-icon">✓</span><h3>Meta!</h3><p role="status">Zapisujemy wynik. Zaczekaj chwilę…</p></div>');
  } else if (game.phase === 'racing') {
    if (key !== renderKey) $('#game').innerHTML = shell(`<div class="game-metrics"><div class="metric next"><small>SZUKAJ LICZBY</small><strong id="next-number">1</strong></div><div class="metric"><small>CZAS + KARY</small><strong id="race-time">0.00</strong></div><div class="metric errors"><small>KARY</small><strong id="race-errors">+0 s</strong></div></div><div class="board size-${game.size}" id="number-board" aria-label="Klikaj liczby rosnąco">${game.board.map(n => `<button class="number-cell" data-number="${n}" aria-label="Liczba ${n}">${n}</button>`).join('')}</div><p class="game-hint" id="game-hint"></p>${opponent ? '<div class="opponent-progress"><div class="opponent-line"><span id="opponent-label"></span><span id="opponent-count"></span></div><progress id="opponent-bar" max="100" value="0" aria-label="Postęp rywala"></progress></div>' : ''}<p class="game-hint">Limit: 3 minuty. ${game.mode === 'duel' ? 'Zamknięcie lub odświeżenie strony oznacza walkower.' : 'Czas końcowy uwzględnia kary za pomyłki.'}</p>`);
    $('#next-number').textContent = me.score !== null ? '✓' : me.next;
    $('#race-errors').textContent = `+${me.errors} s`;
    $('#game-hint').textContent = me.score !== null ? 'Meta! Czekamy, aż rywal ukończy swoją planszę…' : `${me.next - 1} / ${game.size ** 2} trafień · klikaj liczby w rosnącej kolejności`;
    document.querySelectorAll('[data-number]').forEach(b => { const done = +b.dataset.number < me.next; b.disabled = done || me.score !== null || !connected; b.classList.toggle('done', done); });
    if (opponent) { $('#opponent-label').textContent = opponent.username; $('#opponent-count').textContent = `${opponent.next - 1} / ${game.size ** 2}`; $('#opponent-bar').value = (opponent.next - 1) / game.size ** 2 * 100; }
  } else if (game.phase === 'complete') {
    const heading = game.mode === 'solo' ? me.score !== null ? 'Dobry przejazd.' : 'Koniec czasu.' : me.outcome === 'win' ? 'Ten pojedynek jest Twój.' : me.outcome === 'draw' ? 'Równo na mecie.' : game.reason === 'forfeit' ? 'Porażka walkowerem.' : 'Rywal był szybszy.';
    const explanation = game.saved === false ? 'Nie udało się zapisać wyniku. Pozostań na tej stronie i ponów zapis, aby zachować go w statystykach.' : game.reason === 'forfeit' ? 'Pojedynek zakończony walkowerem po opuszczeniu gry przez jednego z graczy.' : game.reason === 'timeout' ? 'Upłynął limit 3 minut. Nieukończona plansza nie daje rekordu.' : game.mode === 'solo' ? 'Wynik zapisany. Kolejny przejazd, kolejna szansa na rekord.' : 'Wyniki i bilans pojedynków zostały zapisane.';
    $('#game').innerHTML = shell(`<div class="result-header"><span class="result-icon">${me.outcome === 'loss' ? '⚑' : '→'}</span><span class="eyebrow">${game.mode === 'solo' ? 'TRENING ZAKOŃCZONY' : 'FLAGA W SZACHOWNICĘ'}</span><h3>${heading}</h3><div class="result-time">${seconds(me.score)} <small>sek.</small></div><p>${explanation}</p></div><table class="result-table"><thead><tr><th>Gracz</th><th>Czas</th><th>Kara</th><th>Wynik</th></tr></thead><tbody>${game.players.map(p => `<tr><td>${escape(p.username)}${p.me ? ' (Ty)' : ''}</td><td>${p.elapsed === null ? '—' : (p.elapsed / 1000).toFixed(2)}</td><td>+${p.errors} s</td><td>${seconds(p.score)} s</td></tr>`).join('')}</tbody></table><div class="result-actions"><button class="button primary" data-action="again">${game.mode === 'solo' ? 'Jeszcze jeden przejazd' : 'Utwórz nowy pokój'} →</button><button class="button secondary" data-action="leave">Wróć</button></div>`);
  }
  if (game.phase === 'complete' && game.saved === false) $('.result-actions').insertAdjacentHTML('beforebegin', '<div class="notice"><button class="button secondary" data-action="retry-save">Ponów zapis wyniku</button></div>');
  renderKey = key;
}
function tick() {
  if (game) {
    const now = Date.now() + serverOffset;
    if (game.phase === 'countdown' && $('#countdown-number')) $('#countdown-number').textContent = Math.max(1, Math.ceil((game.startAt - now) / 1000));
    if (game.phase === 'racing' && $('#race-time')) { const me = game.players.find(p => p.me); $('#race-time').textContent = me.score === null ? (Math.max(0, Math.min(now - game.startAt, 180000) + me.errors * 1000) / 1000).toFixed(2) : seconds(me.score); }
  }
  requestAnimationFrame(tick);
}
function openAuth() { $('#auth-error').textContent = ''; if (!dialog.open) dialog.showModal(); }
function updateAuth() {
  $('#auth-title').textContent = authMode === 'login' ? 'Witaj na starcie.' : 'Dołącz do stawki.';
  $('#auth-description').textContent = authMode === 'login' ? 'Zaloguj się i wróć do walki o setne sekundy.' : 'Wybierz login i hasło. Zapisuj rekordy i rywalizuj ze znajomymi.';
  $('#auth-submit').textContent = authMode === 'login' ? 'Zaloguj się →' : 'Utwórz konto →';
  $('#password').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  $('.auth-switch[data-action="switch-auth"]').innerHTML = authMode === 'login' ? 'Nie masz konta? <strong>Załóż konto</strong>' : 'Masz już konto? <strong>Zaloguj się</strong>';
  $('#auth-error').textContent = '';
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.mode) { mode = button.dataset.mode; setup(); return; }
  if (button.dataset.size) { size = +button.dataset.size; setup(); return; }
  if (button.dataset.number) { command('hit', { number: +button.dataset.number }); return; }
  try {
    switch (button.dataset.action) {
      case 'auth': openAuth(); break;
      case 'close-auth': dialog.close(); break;
      case 'switch-auth': authMode = authMode === 'login' ? 'register' : 'login'; updateAuth(); break;
      case 'start': command(mode === 'solo' ? 'solo' : 'create', { size }); break;
      case 'ready': command('ready'); break;
      case 'retry-save': command('retry-save'); break;
      case 'again': command(game.mode === 'solo' ? 'solo' : 'create', { size: game.size }); break;
      case 'home': if (game) toast('Użyj przycisku „Opuść” lub „Wróć do centrum” na planszy.'); else window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'copy-code': try { await navigator.clipboard.writeText(game.code); toast('Kod pokoju skopiowany.'); } catch { toast(`Kod pokoju: ${game.code}`); } break;
      case 'leave': if (game && ['racing', 'countdown'].includes(game.phase)) $('#leave-confirm').hidden = false; else command('leave'); break;
      case 'confirm-leave': command('leave'); break;
      case 'cancel-leave': $('#leave-confirm').hidden = true; break;
      case 'logout':
        if (game && ['countdown', 'racing'].includes(game.phase)) { toast('Najpierw zakończ lub opuść grę.'); break; }
        await api('logout', {}); user = null; stats = null; game = null; connected = false; socket?.close(); socket = null; $('#connection-banner').hidden = true; updateAccount(); renderGame(); renderStats(); break;
      case 'reconnect':
        user = (await api('me')).user;
        if (!user) { $('#connection-banner').hidden = true; openAuth(); }
        game = null; renderGame(); updateAccount(); connect(); refreshStats(); break;
    }
  } catch (error) { toast(error.message); }
});
$('#join-form').addEventListener('submit', event => { event.preventDefault(); command('join', { code: $('#room-code').value }); });
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#auth-submit').disabled = true; $('#auth-error').textContent = '';
  try { const data = await api(authMode, { username: $('#username').value, password: $('#password').value }); user = data.user; $('#password').value = ''; dialog.close(); updateAccount(); connect(); await refreshStats(); toast(authMode === 'register' ? 'Konto gotowe. Wybierz tryb i ruszaj na start.' : 'Witaj z powrotem na torze.'); }
  catch (error) { $('#auth-error').textContent = error.message; }
  finally { $('#auth-submit').disabled = false; }
});
setup(); requestAnimationFrame(tick);
try { user = (await api('me')).user; updateAccount(); if (user) { connect(); await refreshStats(); } } catch { toast('Serwer jest niedostępny. Spróbuj odświeżyć stronę.'); }
