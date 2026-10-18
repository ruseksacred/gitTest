const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = value => value == null ? '—' : `${(value / 100).toFixed(2)} s`;
const signed = value => value == null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${(Math.abs(value) / 100).toFixed(2)} s`;
const pts = value => Number(value).toLocaleString('pl-PL', { maximumFractionDigits: 2 });
let viewKey = '';

function plan(tracks) {
  return `<ol class="duel-plan">${tracks.map((t, i) => `<li><strong>Wyścig ${i + 1} · ${t.size} × ${t.size}</strong><span>${t.laps} okr.</span></li>`).join('')}</ol>`;
}

export function renderChampionshipReport(report, userId) {
  const name = p => `${escape(p.username)}${p.id === userId ? ' (Ty)' : ''}`;
  const winner = report.players.find(p => p.id === report.winner);
  const title = report.status === 'active' ? 'Klasyfikacja mistrzostw' : report.status === 'interrupted' ? 'Mistrzostwa przerwane' : winner ? `Mistrzostwa wygrywa ${escape(winner.username)}` : 'Remis w mistrzostwach';
  return `<div class="duel-report-heading"><span class="eyebrow">MISTRZOSTWA · ${report.completedRounds} / ${report.totalRounds} WYŚCIGÓW${report.status === 'forfeit' ? ' · WALKOWER' : ''}</span><h3>${title}</h3><p>Punkty przyznajemy po wyścigu na całym torze: przy dwóch graczach 2 pkt za pierwsze i 1 pkt za drugie miejsce. Remis: po 1,5 pkt. DNF: 0 pkt.</p></div><div class="duel-standings">${report.players.map(p => `<article><span class="eyebrow">MIEJSCE ${p.place}</span><h4>${name(p)}</h4><div class="duel-points">${pts(p.points)} <small>pkt</small></div><dl><div><dt>Strata do lidera mistrzostw</dt><dd>${pts(p.pointsGap)} pkt</dd></div><div><dt>Wygrane wyścigi</dt><dd>${p.wins}</dd></div><div><dt>Ukończone okrążenia</dt><dd>${p.completed} / ${report.totalLaps}</dd></div><div><dt>Błędy / kary</dt><dd>${p.errors} / +${p.errors} s</dd></div><div><dt>Suma czasów wyścigów</dt><dd>${time(p.total)}</dd></div></dl></article>`).join('')}</div>${report.races.map(race => `<details class="duel-track-report" open><summary>Wyścig ${race.index} · Tor ${race.size}×${race.size} · ${race.laps} okrążeń${race.reason === 'timeout' ? ' · limit czasu' : race.reason === 'forfeit' ? ' · walkower' : ''}</summary><div class="duel-table-scroll" tabindex="0" role="region" aria-label="Wynik wyścigu ${race.index}"><table class="duel-table"><thead><tr><th>Gracz</th><th>Miejsce</th><th>Czas wyścigu + kary</th><th>Strata</th><th>Najlepsze kółko</th><th>Średnie kółko</th><th>Kary</th><th>Punkty za wyścig</th></tr></thead><tbody>${race.players.map(p => `<tr><th scope="row">${name(p)}</th><td>${p.place ?? 'DNF'}</td><td>${time(p.score)}</td><td>${signed(p.gap)}</td><td>${time(p.best)}</td><td>${time(p.average)}</td><td>+${p.errors} s</td><td>${pts(p.points)}</td></tr>`).join('')}</tbody></table></div><p class="duel-scroll-note">Czasy okrążeń — przesuń tabelę, aby zobaczyć wszystkie kolumny →</p><div class="duel-table-scroll" tabindex="0" role="region" aria-label="Okrążenia wyścigu ${race.index}"><table class="duel-table championship-laps"><thead><tr><th>Okrążenie</th><th>Gracz</th><th>Czas jazdy</th><th>Kara</th><th>Czas kółka z karą</th><th>Łączny czas</th><th>Łączna strata</th><th>Delta PB na mecie</th></tr></thead><tbody>${Array.from({ length: race.laps }, (_, i) => race.players.map(p => {
    const lap = p.laps[i]; if (!lap) return '';
    const rival = race.players.find(q => q.id !== p.id)?.laps[i];
    return `<tr><td>${i + 1}</td><th scope="row">${name(p)}</th><td>${time(Math.round(lap.elapsed / 10))}</td><td>+${lap.errors} s</td><td>${time(lap.score)}</td><td>${time(lap.total)}</td><td>${signed(rival ? lap.total - rival.total : null)}</td><td>${signed(lap.delta)}</td></tr>`;
  }).join('')).join('')}</tbody></table></div></details>`).join('')}<p class="duel-report-note">Suma czasów z karami decyduje o wyniku wyścigu, a suma punktów z wyścigów o mistrzostwach. Punkty nie są przyznawane za poszczególne okrążenia. Strata na żywo porównuje ostatni wspólny punkt planszy; delta PB porównuje ten sam punkt własnego najlepszego kółka z pomiarem. DNF oznacza nieukończony wyścig. Walkower kończy mistrzostwa bez dopisywania nieodbytych wyścigów.</p>`;
}

function lapTable(c, me, rival) {
  return `<table class="live-lap-table"><thead><tr><th>Okr.</th><th>${escape(me.username)}</th><th>${escape(rival?.username ?? 'Rywal')}</th><th>Łączna strata</th></tr></thead><tbody>${Array.from({ length: c.laps }, (_, i) => {
    const a = me.laps[i], b = rival?.laps[i];
    return `<tr data-live-lap="${i + 1}"><th scope="row">${i + 1}</th><td>${time(a?.score)}${a ? `<small>kara +${a.errors} s</small>` : ''}</td><td>${time(b?.score)}${b ? `<small>kara +${b.errors} s</small>` : ''}</td><td>${signed(a && b ? a.total - b.total : null)}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function wrapper(game, body) {
  const c = game.championship;
  return `<div class="game-body championship-game"><div class="game-top"><span class="eyebrow">MISTRZOSTWA / ${escape(game.code)} · WYŚCIG ${c.race}/${c.races} · ${game.size}×${game.size}</span><button data-action="leave">${game.phase === 'complete' && c.status !== 'active' ? 'Wróć do centrum' : 'Opuść'} →</button></div>${body}<div id="leave-confirm" class="confirm-leave" hidden><p>Opuszczenie rozpoczętych mistrzostw oznacza walkower, także między wyścigami.</p><div><button class="button small secondary" data-action="confirm-leave">Opuść mistrzostwa</button><button class="button small primary" data-action="cancel-leave">Zostań</button></div></div></div>`;
}

export function renderChampionship(game, connected, userId) {
  const c = game.championship, me = c.drivers.find(p => p.me), rival = c.drivers.find(p => !p.me);
  const key = `${c.raceId}:${game.phase}:${me.lap}:${me.finished}`;
  if (game.phase === 'waiting') {
    $('#game').innerHTML = wrapper(game, `<div class="waiting-room"><span class="eyebrow">MISTRZOSTWA 1 VS 1</span><h3>Zaproś rywala do wyścigu.</h3><p>Jeden tor to wyścig. Każda plansza to jedno okrążenie.</p><div class="room-code" id="display-code">${escape(game.code)}</div><button class="auth-switch" data-action="copy-code">Kopiuj kod →</button>${plan(c.tracks)}<p>Na jednym torze jedziecie płynnie, każdy we własnym tempie. Gotowość jest potrzebna przed kolejnym torem.</p><div class="players">${[me, rival].map(p => `<div class="player-slot"><strong>${p ? escape(p.username) : 'Czekamy na rywala…'}</strong><small>${p?.ready ? '● Gotowość' : 'Na polach startowych'}</small></div>`).join('')}</div><button class="button primary" data-action="ready" id="ready-button" ${!rival || me.ready ? 'disabled' : ''}>${me.ready ? 'Czekamy na rywala…' : 'Gotowość — start wyścigu →'}</button></div>`);
  } else if (['preparing', 'saving'].includes(game.phase)) {
    $('#game').innerHTML = wrapper(game, `<div class="result-header"><h3>${game.phase === 'preparing' ? 'Przygotowujemy wyścig.' : 'Meta wyścigu!'}</h3><p role="status">${game.phase === 'preparing' ? 'Wczytujemy pomiar najlepszego kółka…' : 'Zapisujemy okrążenia i klasyfikację…'}</p></div>`);
  } else if (game.phase === 'countdown') {
    if (key !== viewKey) $('#game').innerHTML = wrapper(game, '<div class="countdown"><h3>Za chwilę zielone światło.</h3><div class="countdown-number" id="countdown-number">3</div><p>Po każdym kółku kolejna plansza pojawia się od razu.</p></div>');
  } else if (game.phase === 'racing') {
    if (key !== viewKey) $('#game').innerHTML = wrapper(game, `<div class="champ-race-title"><h3>Tor ${game.size}×${game.size}</h3><span id="champ-lap-label"></span></div><div class="champ-timing"><div><small>CZAS WYŚCIGU + KARY</small><strong id="race-time">0.00 s</strong></div><div><small>AKTUALNE KÓŁKO + KARY</small><strong id="lap-time">0.00 s</strong></div><div><small>ŁĄCZNA STRATA DO RYWALA</small><strong id="gap-time">—</strong><span id="gap-meta"></span></div><div><small>DELTA DO WŁASNEGO PB</small><strong id="pb-delta">—</strong><span id="delta-meta"></span></div><div><small>NAJLEPSZE WŁASNE KÓŁKO</small><strong id="pb-time">—</strong><span id="pb-meta"></span></div><div><small>KARY TEGO KÓŁKA</small><strong id="race-errors">+0 s</strong><span id="total-errors"></span></div></div>${me.finished ? '<div class="champ-finished"><strong>Meta! Wszystkie Twoje okrążenia ukończone.</strong><p>Rywal jedzie dalej. Poniżej śledzisz jego czasy.</p></div>' : `<div class="champ-next">SZUKAJ LICZBY <strong id="next-number">${me.next}</strong></div><div class="board size-${game.size}" id="number-board" aria-label="Klikaj liczby rosnąco">${game.board.map(n => `<button class="number-cell" data-number="${n}" data-lap="${me.lap}" data-race-id="${c.raceId}" aria-label="Liczba ${n}">${n}</button>`).join('')}</div>`}<p class="game-hint" id="game-hint"></p><div class="opponent-progress"><div class="opponent-line"><span id="opponent-label"></span><span id="opponent-count"></span></div><progress id="opponent-bar" max="${c.laps * game.size ** 2}" value="0" aria-label="Postęp rywala"></progress></div><h4>Czasy okrążeń</h4><div class="live-laps-scroll" id="live-laps"></div><p class="game-hint">Strata i delta są mierzone przy tych samych liczbach. Wartość ujemna oznacza przewagę. PB obejmuje kółka z zapisanym pomiarem punktów.</p>`);
    $('#champ-lap-label').textContent = me.finished ? `Meta · ${c.laps}/${c.laps} okr.` : `Okrążenie ${me.lap}/${c.laps}`;
    if ($('#next-number')) $('#next-number').textContent = me.next;
    $('#race-errors').textContent = `+${me.errors} s`;
    $('#total-errors').textContent = `W wyścigu: +${me.totalErrors} s`;
    $('#pb-time').textContent = time(me.best?.score);
    $('#pb-meta').textContent = me.best ? me.best.historical ? 'Najlepsze z poprzednich wyścigów' : `Najlepsze kółko w tym wyścigu: ${me.best.lap}` : 'Pierwsze kółko będzie referencją';
    $('#pb-delta').textContent = signed(me.delta?.value);
    $('#pb-delta').className = me.delta?.value < 0 ? 'timing-ahead' : me.delta?.value > 0 ? 'timing-behind' : '';
    $('#delta-meta').textContent = me.delta ? `PB ${time(me.delta.reference)} · po liczbie ${me.delta.checkpoint}` : me.best ? 'Pomiar po pierwszym trafieniu' : 'Brak kółka referencyjnego';
    $('#gap-time').textContent = signed(c.gap?.value);
    $('#gap-time').className = c.gap?.value < 0 ? 'timing-ahead' : c.gap?.value > 0 ? 'timing-behind' : '';
    $('#gap-meta').textContent = c.gap ? `Ostatni wspólny punkt: okr. ${c.gap.lap}, liczba ${c.gap.checkpoint}` : 'Pomiar po pierwszym wspólnym punkcie';
    document.querySelectorAll('[data-number]').forEach(button => { const done = +button.dataset.number < me.next; button.disabled = done || !connected; button.classList.toggle('done', done); });
    $('#game-hint').textContent = me.finished ? 'Meta! Czekamy na ukończenie wyścigu przez rywala.' : `${me.next - 1}/${game.size ** 2} trafień · kolejna plansza ruszy od razu po mecie tego kółka`;
    $('#opponent-label').textContent = rival?.username ?? 'Rywal';
    $('#opponent-count').textContent = rival?.finished ? 'Meta' : `Okr. ${rival?.lap ?? 1}/${c.laps} · ${Math.max(0, (rival?.next ?? 1) - 1)}/${game.size ** 2}`;
    $('#opponent-bar').value = rival?.finished ? c.laps * game.size ** 2 : ((rival?.lap ?? 1) - 1) * game.size ** 2 + (rival?.next ?? 1) - 1;
    $('#live-laps').innerHTML = lapTable(c, me, rival);
  } else if (game.phase === 'complete') {
    const report = c.report, race = report?.races.find(r => r.index === c.race), final = c.status !== 'active';
    const winner = final ? report?.winner : race?.winner;
    const a = report?.players.find(p => p.id === userId), b = report?.players.find(p => p.id !== userId);
    $('#game').innerHTML = wrapper(game, `<div class="result-header"><span class="eyebrow">${final ? 'KLASYFIKACJA MISTRZOSTW' : 'WYNIK WYŚCIGU'}</span><h3>${!game.saved ? 'Nie udało się zapisać wyścigu.' : winner === null ? final ? 'Remis w mistrzostwach.' : 'Remis w wyścigu.' : winner === userId ? final ? 'Wygrywasz mistrzostwa.' : 'Wygrywasz wyścig.' : final ? 'Rywal wygrywa mistrzostwa.' : 'Rywal wygrywa wyścig.'}</h3><div class="result-time duel-final-score">${pts(a?.points ?? 0)} : ${pts(b?.points ?? 0)} <small>pkt</small></div><p>Punkty mistrzostw po zakończonych wyścigach. Każdy tor daje punkty jeden raz.</p></div><div class="rematch-info"><p id="rematch-status" role="status">${!game.saved ? 'Ponów zapis, aby zachować okrążenia i klasyfikację.' : !connected ? 'Połącz ponownie, aby sprawdzić pokój.' : !game.canRematch ? 'Rywal opuścił pokój.' : me.ready ? 'Czekamy na rywala…' : final ? 'Możecie rozpocząć kolejne mistrzostwa z tym samym planem.' : `Następny wyścig: tor ${c.next.size}×${c.next.size}, ${c.next.laps} okr. Oboje potwierdźcie gotowość.`}</p><button class="button primary" data-action="rematch" ${!game.saved || !game.canRematch || !connected || me.ready ? 'disabled' : ''}>${me.ready ? 'Czekamy na rywala…' : final ? 'Rewanż — nowe mistrzostwa →' : 'Gotowość do następnego wyścigu →'}</button>${!game.saved ? '<button class="button secondary" data-action="retry-save">Ponów zapis wyścigu</button>' : ''}</div>${report ? `<div id="current-championship-report">${renderChampionshipReport(report, userId)}</div>` : ''}<div class="result-actions"><button class="button secondary" data-action="again">Nowe mistrzostwa</button><button class="button secondary" data-action="leave">Wróć</button></div>`);
  }
  viewKey = key;
}

export function tickChampionship(game, now) {
  if (game.phase !== 'racing') return;
  const me = game.championship.drivers.find(p => p.me);
  const lap = me.finished ? me.laps.at(-1)?.score ?? 0 : Math.round((Math.max(0, now - me.lapStartAt) + me.errors * 1000) / 10);
  if ($('#lap-time')) $('#lap-time').textContent = time(lap);
  if ($('#race-time')) $('#race-time').textContent = time(me.finished ? me.completedScore : me.completedScore + lap);
}
