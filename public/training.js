const $ = selector => document.querySelector(selector);
const time = value => value == null ? '—' : `${(value / 100).toFixed(2)} s`;
const signed = value => value == null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${(Math.abs(value) / 100).toFixed(2)} s`;
const deltaClass = value => value < 0 ? 'timing-ahead' : value > 0 ? 'timing-behind' : '';
let viewKey = '';

function lapTable(training, complete = false) {
  const { driver, summary } = training;
  return `<div class="solo-lap-scroll" tabindex="0" role="region" aria-label="Czasy okrążeń treningu"><table class="live-lap-table solo-lap-table"><thead><tr><th>Okr.</th><th>Czas jazdy</th><th>Kary</th><th>Czas z karami</th><th>Delta PB</th><th>Łączny czas</th></tr></thead><tbody>${Array.from({ length: training.laps }, (_, i) => {
    const lap = driver.laps[i], best = lap && lap.score === summary.best;
    return `<tr data-solo-lap="${i + 1}"${best ? ' class="solo-best-lap"' : ''}><th scope="row">${i + 1}${best ? '<small>NAJLEPSZE</small>' : ''}</th><td>${time(lap ? Math.round(lap.elapsed / 10) : null)}</td><td>${lap ? `+${lap.errors} s` : '—'}</td><td>${time(lap?.score)}${!lap && complete ? '<small>Nieukończone</small>' : ''}</td><td class="${deltaClass(lap?.delta)}">${signed(lap?.delta)}</td><td>${time(lap?.total)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function wrapper(game, body) {
  return `<div class="game-body solo-training"><div class="game-top"><span class="eyebrow">TRENING SOLO · TOR ${game.size}×${game.size} · ${game.training.laps} OKR.</span><button data-action="leave">${game.phase === 'complete' ? 'Wróć do ustawień' : 'Opuść'} →</button></div>${body}</div>`;
}

export function renderTraining(game, connected) {
  const t = game.training, me = t.driver;
  const key = `${game.raceId}:${game.phase}:${me.lap}`;
  if (['preparing', 'saving'].includes(game.phase)) {
    $('#game').innerHTML = wrapper(game, `<div class="result-header"><h3>${game.phase === 'preparing' ? 'Przygotowujemy trening.' : 'Meta!'}</h3><p role="status">${game.phase === 'preparing' ? 'Wczytujemy pomiar Twojego najlepszego kółka…' : 'Zapisujemy czasy wszystkich ukończonych okrążeń…'}</p></div>`);
  } else if (game.phase === 'countdown') {
    if (key !== viewKey) $('#game').innerHTML = wrapper(game, `<div class="countdown"><span class="eyebrow">SKUP SIĘ NA STARCIE</span><h3>Za chwilę zielone światło.</h3><div class="lights" aria-hidden="true"><span></span><span></span><span></span></div><div class="countdown-number" id="countdown-number">3</div><p>Tor ${game.size}×${game.size} · ${t.laps} okr. Kolejne plansze ruszają bez przerwy.</p></div>`);
  } else if (game.phase === 'racing') {
    if (key !== viewKey) {
      const detailsOpen = $('#race-details')?.open ?? matchMedia('(min-width: 801px)').matches;
      $('#game').innerHTML = wrapper(game, `<div class="race-layout"><div class="race-driving"><div class="champ-race-title"><h3>Tor ${game.size}×${game.size}</h3><span id="solo-lap-label"></span></div><div class="champ-timing"><div><small>TRENING + KARY</small><strong id="race-time">0.00 s</strong></div><div><small>KÓŁKO + KARY</small><strong id="lap-time">0.00 s</strong></div><div><small>DELTA DO PB</small><strong id="pb-delta">—</strong></div><div><small>NAJLEPSZE KÓŁKO</small><strong id="pb-time">—</strong></div><div><small>KARA KÓŁKA</small><strong id="race-errors">+0 s</strong></div><div><small>UKOŃCZONE KÓŁKA</small><strong id="completed-laps"></strong></div></div><div class="champ-next">SZUKAJ LICZBY <strong id="next-number">${me.next}</strong></div><div class="board size-${game.size}" id="number-board" aria-label="Klikaj liczby rosnąco">${game.board.map(n => `<button class="number-cell" data-number="${n}" data-lap="${me.lap}" data-race-id="${game.raceId}" aria-label="Liczba ${n}">${n}</button>`).join('')}</div><p class="game-hint" id="game-hint"></p></div><details id="race-details" class="race-details" ${detailsOpen ? 'open' : ''}><summary>Okrążenia i szczegóły pomiaru</summary><div class="race-details-content"><p class="game-hint solo-scroll-hint">Przesuń tabelę, aby zobaczyć wszystkie czasy →</p><div id="solo-live-laps"></div><div class="timing-notes"><p><strong>Delta: </strong><span id="delta-meta"></span></p><p><strong>Rekord: </strong><span id="pb-meta"></span></p><p id="total-errors"></p></div><p class="game-hint">Delta porównuje czas z karami przy tej samej liczbie z własnym najlepszym kółkiem z pomiarem. Ujemna oznacza szybsze tempo. Limit treningu: ${t.laps * 3} min.</p></div></details></div>`);
    }
    $('#solo-lap-label').textContent = `Okrążenie ${me.lap}/${t.laps}`;
    $('#next-number').textContent = me.next;
    $('#race-errors').textContent = `+${me.errors} s`;
    $('#total-errors').textContent = `W treningu: +${me.totalErrors} s`;
    $('#completed-laps').textContent = `${me.laps.length} / ${t.laps}`;
    $('#pb-time').textContent = time(me.best?.score);
    $('#pb-meta').textContent = me.best ? me.best.historical ? 'PB z poprzednich przejazdów na tym torze' : `Najlepsze kółko w tym treningu: ${me.best.lap}` : 'Pierwsze kółko będzie referencją';
    $('#pb-delta').textContent = signed(me.delta?.value);
    $('#pb-delta').className = deltaClass(me.delta?.value);
    $('#delta-meta').textContent = me.delta ? `PB ${time(me.delta.reference)} · po liczbie ${me.delta.checkpoint}` : me.best ? 'Pomiar po pierwszym trafieniu' : 'Brak kółka referencyjnego';
    document.querySelectorAll('[data-number]').forEach(button => { const done = +button.dataset.number < me.next; button.disabled = done || !connected; button.classList.toggle('done', done); });
    $('#game-hint').textContent = `${me.next - 1}/${game.size ** 2} trafień · ${me.lap < t.laps ? 'następne okrążenie ruszy od razu' : 'ostatnie okrążenie'}`;
    $('#solo-live-laps').innerHTML = lapTable(t);
  } else if (game.phase === 'complete') {
    const s = t.summary;
    const title = game.reason === 'timeout' ? 'Koniec czasu.' : game.reason === 'abandoned' ? 'Trening przerwany.' : t.laps === 1 ? 'Dobry przejazd.' : 'Trening ukończony.';
    const note = !game.saved ? 'Nie udało się zapisać okrążeń. Pozostań na tej stronie i ponów zapis.' : s.completed ? `Zapisano ${s.completed} / ${t.laps} okr. Każde ukończone kółko trafia osobno do rankingu solo.` : 'Brak ukończonych okrążeń. Nie dodano wyniku do rankingu.';
    $('#game').innerHTML = wrapper(game, `<div class="result-header"><span class="eyebrow">PODSUMOWANIE TRENINGU · TOR ${game.size}×${game.size}</span><h3>${title}</h3><div class="result-time">${s.completed ? (s.total / 100).toFixed(2) : '—'} <small>sek.</small></div><p>Łączny czas ukończonych okrążeń z karami.</p><p id="solo-save-status" role="status">${note}</p></div><div class="ranking-summary solo-summary"><div><small>Ukończone okrążenia</small><strong>${s.completed} / ${t.laps}</strong></div><div><small>Najlepsze kółko</small><strong>${time(s.best)}</strong></div><div><small>Średnie kółko</small><strong>${time(s.average)}</strong></div><div><small>Kary ukończonych kółek</small><strong>+${s.errors} s</strong></div></div><h4>Czasy okrążeń</h4><p class="game-hint solo-scroll-hint">Przesuń tabelę, aby zobaczyć wszystkie czasy →</p>${lapTable(t, true)}${!game.saved ? '<div class="notice"><button class="button secondary" data-action="retry-save">Ponów zapis okrążeń</button></div>' : ''}<div class="result-actions solo-result-actions"><button class="button primary" data-action="again" ${!game.saved ? 'disabled' : ''}>Powtórz trening →</button><button class="button secondary" data-action="leave">Wróć</button></div>`);
  }
  viewKey = key;
}

export function tickTraining(game, now) {
  if (game.phase !== 'racing') return;
  const me = game.training.driver;
  const lap = Math.round((Math.max(0, Math.min(now, game.deadline) - me.lapStartAt) + me.errors * 1000) / 10);
  if ($('#lap-time')) $('#lap-time').textContent = time(lap);
  if ($('#race-time')) $('#race-time').textContent = time(me.completedScore + lap);
}
