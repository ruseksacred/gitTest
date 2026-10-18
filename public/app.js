import { initPwa } from './pwa.js';
import { createGameConnection } from './connection.js';
import { createRanking } from './ranking.js';
import { initDuels, trackPlan, renderDuelReport, points } from './duels.js';
import { renderChampionship, tickChampionship } from './championship.js';
import { renderTraining, tickTraining } from './training.js';

const $ = selector => document.querySelector(selector);
const pwa = initPwa();
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const seconds = score => score == null ? '—' : (score / 100).toFixed(2);
let user = null, mode = 'solo', size = 4, game = null, stats = null, authMode = 'login', renderKey = '', serverOffset = 0, toastTimer, connected = false;
let connectionState = 'idle';
const dialog = $('#auth-dialog');
const ranking = createRanking({ api, getUser: () => user });
const duels = initDuels({ api, getUser: () => user, toast });
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
async function api(path, body) {
  if (!navigator.onLine) throw Error('Brak internetu. Połącz się z siecią i spróbuj ponownie.');
  const response = await fetch(`/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Nie udało się połączyć z serwerem.');
  return data;
}
async function command(action, payload = {}) {
  if (!navigator.onLine) { toast('Brak internetu. Gra wymaga połączenia z serwerem.'); return; }
  if (!user) { openAuth(); return; }
  try {
    // Probe before starting a round. Never replay a timed hit or send readiness
    // for a result that changed while the transport was reconnecting.
    if (['solo', 'create', 'join', 'rematch'].includes(action)) await connection.ensureAlive();
    if (action === 'rematch' && (game?.phase !== 'complete' || game.matchId !== payload.matchId || !game.canRematch)) { toast('Pokój nie jest już dostępny do rewanżu. Możesz utworzyć nowy.'); return; }
    connection.send(action, payload);
  } catch (error) { toast(error.message); }
}
const connection = createGameConnection({
  onMessage(data) {
    if (data.type === 'refresh-stats') refreshStats();
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
      if (game?.phase === 'complete') ranking.finished(game);
      if (!game || (game.phase === 'complete' && (old?.phase !== 'complete' || old.matchId !== game.matchId || old.saved !== game.saved))) refreshStats();
    }
  },
  onDisconnect(reason) {
    connected = false;
    if (game && (game.phase !== 'complete' || game.saved === false || game.duel?.status === 'active' || game.championship?.status === 'active')) {
      const interrupted = game.mode === 'duel' && (['countdown', 'racing', 'saving'].includes(game.phase) || game.duel?.status === 'active' || game.championship?.status === 'active');
      const unsaved = game.saved === false;
      game = null; renderGame();
      if (interrupted && reason !== 'logout') toast('Połączenie przerwało pojedynek. Po ponownym połączeniu sprawdzimy wynik w statystykach.');
      else if (unsaved) toast('Utracono połączenie przed potwierdzeniem zapisu. Sprawdź ostatnie wyniki po ponownym połączeniu.');
    }
    if (game?.phase === 'complete') { game.canRematch = false; for (const p of game.players) p.ready = false; renderGame(); }
    updateAccount();
  },
  onStatus({ state, message }) {
    connectionState = state;
    connected = state === 'connected';
    if (state === 'expired') { user = null; game = null; stats = null; renderGame(); renderStats(); }
    if (user || state === 'expired') {
      $('#connection-banner').hidden = connected;
      $('#connection-message').textContent = message || '';
    }
    updateAccount();
    if (connected) refreshStats();
  },
});
function connect() { if (user) connection.start().catch(() => {}); }
function updateAccount() {
  $('#account').innerHTML = user ? `<span class="user-chip">${escape(user.username)}</span><button class="logout" data-action="logout">Wyloguj</button>` : '<button class="button small secondary" data-action="auth">Zaloguj się <span>→</span></button>';
  $('#setup-footnote').textContent = user ? connected ? 'Twój wynik zapisze się automatycznie. Gotowy na start?' : connectionState === 'connecting' ? 'Łączenie z centrum treningowym…' : 'Brak połączenia z grą. Wybierz „Połącz ponownie”.' : 'Zaloguj się, żeby zapisywać wyniki i śledzić postępy.';
}
function setup() {
  document.querySelectorAll('[data-mode]').forEach(b => { const selected = b.dataset.mode === mode; b.classList.toggle('selected', selected); b.setAttribute('aria-selected', selected); });
  document.querySelectorAll('[data-size]').forEach(b => { const selected = +b.dataset.size === size; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', selected); });
  $('#size-description').textContent = `${size ** 2} liczb · ${{ 4: 'standard', 5: 'wyzwanie', 6: 'ekspert', 7: 'mistrz' }[size]}`;
  $('#mode-title').textContent = mode === 'solo' ? 'Ty kontra stoper.' : 'Wasze własne mistrzostwa.';
  $('#mode-description').textContent = mode === 'solo' ? 'Wybierz tor i liczbę okrążeń. Każda plansza to jedno kółko. Śledź czasy i deltę do własnego najlepszego przejazdu.' : 'Jeden tor to wyścig, jedna plansza to okrążenie. Jedziecie płynnie, a punkty z wyścigów tworzą klasyfikację mistrzostw.';
  $('#start-button').innerHTML = `${mode === 'solo' ? 'Rozpocznij trening' : 'Utwórz mistrzostwa'} <span>→</span>`;
  $('#join-section').hidden = mode !== 'duel';
  $('#solo-settings').hidden = mode !== 'solo';
  $('#duel-settings').hidden = mode !== 'duel';
  const preview = Array.from({ length: size ** 2 }, (_, i) => i + 1);
  for (let i = preview.length - 1; i > 0; i--) { const j = (i * 7 + 3) % (i + 1); [preview[i], preview[j]] = [preview[j], preview[i]]; }
  $('#preview-board').className = `preview-board preview-${size}`;
  $('#preview-board').innerHTML = preview.map(n => `<span${n === 1 ? ' class="preview-active"' : ''}>${n}</span>`).join('');
  renderStats();
  updateSoloPlan();
}
function updateSoloPlan() {
  const input = $('#solo-laps'), valid = input.validity.valid && input.value !== '';
  $('#solo-plan-summary').textContent = valid ? `Tor ${size}×${size} · ${input.value} okr. · limit treningu ${+input.value * 3} min. Kolejne plansze ruszają płynnie, bez potwierdzania gotowości.` : 'Wybierz od 1 do 10 okrążeń.';
  $('#rules-limit').textContent = mode === 'solo' && valid ? `Limit ${+input.value * 3} min` : '3 min / okr.';
}
function soloConfig() {
  const input = $('#solo-laps');
  if (!input.reportValidity()) throw Error('Wybierz od 1 do 10 okrążeń.');
  return { size, laps: +input.value };
}
async function refreshStats() { if (!user) return; ranking.refresh(); duels.refresh(); const id = user.id; try { const data = await api('stats'); if (user?.id === id) { stats = data; renderStats(); } } catch (error) { if (user?.id === id) toast(error.message); } }
function renderStats() {
  const record = stats?.records.find(r => r.size === size);
  $('#record-size').textContent = `${size} × ${size}`;
  $('#best-time').textContent = seconds(record?.best);
  $('#record-meta').textContent = record ? `${record.runs} ukończonych okrążeń · średnio ${seconds(record.average)} s` : 'Twój pierwszy rekord czeka na start.';
  for (const key of ['wins', 'losses', 'draws']) $(`#total-${key}`).textContent = stats?.totals[key] || 0;
  if (!user) { ranking.clear(); duels.clear(); }
}
function shell(content) {
  const duel = game.duel;
  const progress = duel && game.phase !== 'waiting' ? `<div class="duel-progress"><strong>Runda ${game.round} / ${duel.totalRounds}</strong> · Tor ${game.size}×${game.size} · okrążenie ${duel.lap} / ${duel.laps} · ${points(duel.points)} pkt za wygraną<br>${game.players.map(p => `${escape(p.username)}: ${points(duel.standings.find(x => x.id === p.id)?.points ?? 0)} pkt`).join(' · ')}</div>` : '';
  return `<div class="game-body"><div class="game-top"><span class="eyebrow">${game.mode === 'solo' ? 'TRENING SOLO' : `POJEDYNEK / ${escape(game.code)} · RUNDA ${game.round}`} · ${game.size} × ${game.size}</span><button data-action="leave">${game.phase === 'complete' ? duel?.status === 'active' ? 'Opuść mecz' : 'Wróć do centrum' : 'Opuść'} →</button></div>${progress}${content}<div id="leave-confirm" class="confirm-leave" hidden><p>${game.mode === 'duel' ? 'Opuszczenie rozpoczętego meczu oznacza przegraną walkowerem, także między okrążeniami.' : 'Bieżący trening nie zostanie zapisany.'}</p><div><button class="button small secondary" data-action="confirm-leave">Opuść grę</button><button class="button small primary" data-action="cancel-leave">Zostań</button></div></div></div>`;
}
function renderGame() {
  pwa.setGameActive(game && (game.phase !== 'complete' || game.saved === false || game.duel?.status === 'active' || game.championship?.status === 'active'));
  document.body.classList.toggle('in-game', !!game);
  $('#setup').hidden = !!game; $('#game').hidden = !game;
  if (!game) { renderKey = ''; $('#game').innerHTML = ''; setup(); return; }
  if (game.training) { renderTraining(game, connected); renderKey = ''; return; }
  if (game.championship) { renderChampionship(game, connected, user.id); renderKey = ''; return; }
  const me = game.players.find(p => p.me), opponent = game.players.find(p => !p.me);
  const key = `${game.id}:${game.round}:${game.phase}`;
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
    const rematch = game.mode === 'duel' ? `<div class="rematch-info"><p id="rematch-status" role="status">${game.saved === false ? 'Zapisz wynik, aby odblokować kolejną rundę.' : !connected ? 'Połącz ponownie, aby sprawdzić dostępność pokoju.' : !game.canRematch ? 'Rywal opuścił pokój. Możesz utworzyć nowy pokój.' : me.ready ? 'Twoja gotowość potwierdzona. Czekamy na rywala…' : opponent?.ready ? 'Rywal jest gotowy. Potwierdź start kolejnej rundy.' : 'Zostajecie w tym samym pokoju. Oboje potwierdźcie gotowość do kolejnej rundy.'}</p><button class="button primary" data-action="rematch" ${!connected || !game.canRematch || me.ready ? 'disabled' : ''}>${me.ready ? 'Czekamy na rywala…' : 'Gotowość do kolejnej rundy'} →</button></div>` : '';
    $('#game').innerHTML = shell(`<div class="result-header"><span class="result-icon">${me.outcome === 'loss' ? '⚑' : '→'}</span><span class="eyebrow">${game.mode === 'solo' ? 'TRENING ZAKOŃCZONY' : 'FLAGA W SZACHOWNICĘ'}</span><h3>${heading}</h3><div class="result-time">${seconds(me.score)} <small>sek.</small></div><p>${explanation}</p></div><table class="result-table"><thead><tr><th>Gracz</th><th>Czas</th><th>Kara</th><th>Wynik</th></tr></thead><tbody>${game.players.map(p => `<tr><td>${escape(p.username)}${p.me ? ' (Ty)' : ''}</td><td>${p.elapsed === null ? '—' : (p.elapsed / 1000).toFixed(2)}</td><td>+${p.errors} s</td><td>${seconds(p.score)} s</td></tr>`).join('')}</tbody></table>${rematch}<div class="result-actions"><button class="button ${game.mode === 'solo' ? 'primary' : 'secondary'}" data-action="again">${game.mode === 'solo' ? 'Jeszcze jeden przejazd' : 'Utwórz nowy pokój'} →</button><button class="button secondary" data-action="leave">Wróć</button></div>`);
  }
  if (game.phase === 'complete' && game.saved === false) $('.result-actions').insertAdjacentHTML('beforebegin', '<div class="notice"><button class="button secondary" data-action="retry-save">Ponów zapis wyniku</button></div>');
  if (game.duel && game.phase === 'waiting') $('#ready-button').insertAdjacentHTML('beforebegin', trackPlan(game.duel.tracks));
  if (game.duel && game.phase === 'complete') {
    const duel = game.duel;
    const next = duel.next;
    $('.result-table').insertAdjacentHTML('afterbegin', `<caption>Ostatnie okrążenie · Tor ${game.size}×${game.size}</caption>`);
    if (duel.report) $('.result-actions').insertAdjacentHTML('beforebegin', `<div id="current-duel-report">${renderDuelReport(duel.report, user.id)}</div>`);
    if (game.saved) {
      if (duel.status !== 'active') {
        const report = duel.report;
        $('.result-header .eyebrow').textContent = 'MECZ ZAKOŃCZONY';
        $('.result-header h3').textContent = report.winner === null ? 'Remis w meczu.' : report.winner === me.id ? 'Wygrywasz mecz.' : 'Rywal wygrywa mecz.';
        $('.result-time').classList.add('duel-final-score');
        $('.result-time').innerHTML = `${points(report.players.find(p => p.id === me.id).points)} : ${points(report.players.find(p => p.id !== me.id).points)} <small>pkt</small>`;
        $('.result-header p').textContent = duel.status === 'forfeit' ? 'Mecz zakończony walkowerem. Rozegrane okrążenia i punkty są zapisane w raporcie.' : 'Wszystkie okrążenia rozegrane. Wynik i pełny raport meczu zostały zapisane.';
      }
      const text = duel.status === 'active' ? me.ready ? 'Twoja gotowość potwierdzona. Czekamy na rywala…' : `Następnie: tor ${next.size}×${next.size}, okrążenie ${next.lap} / ${next.laps}. Oboje potwierdźcie gotowość.` : 'Mecz zakończony. Możecie rozegrać rewanż z tym samym harmonogramem.';
      if (game.canRematch) $('#rematch-status').textContent = text;
      const button = $('[data-action="rematch"]');
      if (game.canRematch && !me.ready) button.textContent = duel.status === 'active' ? 'Gotowość do kolejnej rundy →' : 'Rewanż — ten sam mecz →';
    }
  }
  renderKey = key;
}
function tick() {
  if (game) {
    const now = Date.now() + serverOffset;
    if (game.phase === 'countdown' && $('#countdown-number')) $('#countdown-number').textContent = Math.max(1, Math.ceil((game.startAt - now) / 1000));
    if (game.training) tickTraining(game, now);
    else if (game.championship) tickChampionship(game, now);
    else if (game.phase === 'racing' && $('#race-time')) { const me = game.players.find(p => p.me); $('#race-time').textContent = me.score === null ? (Math.max(0, Math.min(now - game.startAt, 180000) + me.errors * 1000) / 1000).toFixed(2) : seconds(me.score); }
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
  if (button.dataset.number) { command('hit', { number: +button.dataset.number, ...(game?.championship || game?.training ? { lap: +button.dataset.lap, raceId: button.dataset.raceId } : {}) }); return; }
  try {
    switch (button.dataset.action) {
      case 'auth': openAuth(); break;
      case 'close-auth': dialog.close(); break;
      case 'switch-auth': authMode = authMode === 'login' ? 'register' : 'login'; updateAuth(); break;
      case 'start': command(mode === 'solo' ? 'solo' : 'create', mode === 'solo' ? soloConfig() : { tracks: duels.config(), championship: true }); break;
      case 'ready': command('ready'); break;
      case 'retry-save': command('retry-save'); break;
      case 'again': if (game.duel?.status === 'active' || game.championship?.status === 'active') { toast('Zakończ lub opuść bieżące mistrzostwa przed utworzeniem nowych.'); break; } command(game.mode === 'solo' ? 'solo' : 'create', game.training ? { size: game.size, laps: game.training.laps } : game.championship ? { tracks: game.championship.tracks, championship: true } : game.duel ? { tracks: game.duel.tracks.map(({ size, laps }) => ({ size, laps })) } : { size: game.size }); break;
      case 'rematch': command('rematch', { matchId: game.matchId }); break;
      case 'home': if (game) toast('Użyj przycisku „Opuść” lub „Wróć do centrum” na planszy.'); else window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'copy-code': try { await navigator.clipboard.writeText(game.code); toast('Kod pokoju skopiowany.'); } catch { toast(`Kod pokoju: ${game.code}`); } break;
      case 'leave': if (game && (['racing', 'countdown', 'preparing'].includes(game.phase) || ((game.duel?.status === 'active' || game.championship?.status === 'active') && game.phase !== 'waiting'))) $('#leave-confirm').hidden = false; else if (game?.phase === 'complete' && !connected) { game = null; renderGame(); } else command('leave'); break;
      case 'confirm-leave': command('leave'); break;
      case 'cancel-leave': $('#leave-confirm').hidden = true; break;
      case 'logout':
        if (game && (['countdown', 'racing', 'preparing'].includes(game.phase) || ((game.duel?.status === 'active' || game.championship?.status === 'active') && game.phase !== 'waiting'))) { toast('Najpierw zakończ lub opuść mistrzostwa.'); break; }
        await api('logout', {}); user = null; stats = null; game = null; connected = false; connection.stop(); $('#connection-banner').hidden = true; updateAccount(); renderGame(); renderStats(); break;
      case 'reconnect':
        user = (await api('me')).user;
        if (!user) { $('#connection-banner').hidden = true; openAuth(); }
        if (user) await connection.reconnect();
        else connection.stop();
        updateAccount(); break;
    }
  } catch (error) { toast(error.message); }
});
$('#join-form').addEventListener('submit', event => { event.preventDefault(); command('join', { code: $('#room-code').value }); });
$('#solo-laps').addEventListener('input', updateSoloPlan);
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#auth-submit').disabled = true; $('#auth-error').textContent = '';
  try { const data = await api(authMode, { username: $('#username').value, password: $('#password').value }); user = data.user; $('#password').value = ''; dialog.close(); updateAccount(); connect(); await refreshStats(); toast(authMode === 'register' ? 'Konto gotowe. Wybierz tryb i ruszaj na start.' : 'Witaj z powrotem na torze.'); }
  catch (error) { $('#auth-error').textContent = error.message; }
  finally { $('#auth-submit').disabled = false; }
});
setup(); requestAnimationFrame(tick);
try { user = (await api('me')).user; updateAccount(); if (user) { connect(); await refreshStats(); } } catch { toast('Serwer jest niedostępny. Spróbuj odświeżyć stronę.'); }
