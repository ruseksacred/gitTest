const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = value => value == null ? '—' : `${(value / 100).toFixed(2)} s`;
export const points = value => Number(value).toLocaleString('pl-PL', { maximumFractionDigits: 2 });
const gap = value => value == null ? '—' : value === 0 ? 'Lider' : `+${time(value)}`;
const statuses = { active: 'W trakcie', complete: 'Zakończony', forfeit: 'Walkower', interrupted: 'Przerwany restartem' };

export function trackPlan(tracks) {
  return `<ol class="duel-plan">${tracks.map(t => `<li><strong>${t.size} × ${t.size}</strong><span>${t.laps} okr. · ${points(t.points)} pkt za wygraną</span></li>`).join('')}</ol>`;
}

export function renderDuelReport(report, userId) {
  const name = p => `${escape(p.username)}${p.id === userId ? ' (Ty)' : ''}`;
  const winner = report.players.find(p => p.id === report.winner);
  const title = report.status === 'active' ? 'Klasyfikacja po okrążeniu' : report.status === 'interrupted' ? 'Mecz przerwany' : winner ? `Wygrywa ${escape(winner.username)}` : 'Remis w meczu';
  const summary = `<div class="duel-report-heading"><span class="eyebrow">${statuses[report.status]} · ${report.completedRounds} / ${report.totalRounds} RUND</span><h3>${title}</h3><p>Punkty rozstrzygają wynik meczu. Czasy poniżej uwzględniają kary.</p></div><div class="duel-standings">${report.players.map(p => `<article><span class="eyebrow">MIEJSCE ${p.place}</span><h4>${name(p)}</h4><div class="duel-points">${points(p.points)} <small>pkt</small></div><p>${p.pointsGap ? `Strata punktowa: ${points(p.pointsGap)} pkt` : 'Bez straty punktowej'}</p><dl><div><dt>Wygrane rundy</dt><dd>${p.wins}</dd></div><div><dt>Ukończone okrążenia</dt><dd>${p.completed} / ${p.attempted}</dd></div><div><dt>Błędy / kary</dt><dd>${p.errors} / +${p.errors} s</dd></div><div><dt>Suma czasów z karami</dt><dd>${time(p.total)}</dd></div><div><dt>Strata w sumie czasów</dt><dd>${gap(p.timeGap)}</dd></div></dl></article>`).join('')}</div>`;
  const tracks = report.tracks.map(track => `<details class="duel-track-report" open><summary>Tor ${track.size} × ${track.size} · ${track.laps} okr. · ${points(track.points)} pkt / wygraną</summary><div class="duel-table-scroll" role="region" aria-label="Statystyki toru ${track.size} na ${track.size}" tabindex="0"><table class="duel-table"><thead><tr><th>Gracz</th><th>Ukończone</th><th>Najlepszy czas</th><th>Strata rekordu</th><th>Średni czas</th><th>Suma czasów</th><th>Strata sumy</th><th>Kary</th><th>Punkty</th></tr></thead><tbody>${track.players.map(p => `<tr><th scope="row">${name(p)}</th><td>${p.completed} / ${p.attempted}</td><td>${time(p.best)}</td><td>${gap(p.bestGap)}</td><td>${time(p.average)}</td><td>${time(p.total)}</td><td>${gap(p.totalGap)}</td><td>+${p.errors} s</td><td>${points(p.points)}</td></tr>`).join('')}</tbody></table></div></details>`).join('');
  const rounds = `<details class="duel-track-report" open><summary>Wszystkie okrążenia obu graczy</summary><p class="duel-scroll-note">Na telefonie przesuń tabelę, aby zobaczyć wszystkie kolumny →</p><div class="duel-table-scroll" role="region" aria-label="Czasy wszystkich okrążeń" tabindex="0"><table class="duel-table duel-laps"><thead><tr><th>Runda / tor</th><th>Gracz</th><th>Czas jazdy</th><th>Błędy / kara</th><th>Czas z karami</th><th>Strata w rundzie</th><th>Punkty</th></tr></thead><tbody>${report.rounds.map(round => round.players.map(p => {
    const best = report.tracks.find(t => t.size === round.size).players.find(x => x.id === p.id).best;
    return `<tr><td>${round.index} · ${round.size} × ${round.size}<small>okr. ${round.lap} / ${round.laps}${round.reason === 'forfeit' ? ' · walkower' : round.reason === 'timeout' ? ' · limit czasu' : ''}</small></td><th scope="row">${name(p)}</th><td>${time(p.elapsed === null ? null : Math.round(p.elapsed / 10))}</td><td>${p.errors} / +${p.errors} s</td><td>${p.score === null ? 'DNF' : time(p.score)}${p.score !== null && p.score === best ? '<small class="duel-best">Najlepszy na torze</small>' : ''}</td><td>${gap(p.gap)}</td><td>${points(p.points)}</td></tr>`;
  }).join('')).join('')}</tbody></table></div></details>`;
  return `${summary}${tracks}${rounds}<p class="duel-report-note">DNF = nieukończone okrążenie. Średnia i rekord obejmują ukończone przejazdy. Suma i jej strata są porównywane wyłącznie, gdy obaj zawodnicy ukończyli wszystkie dotąd rozegrane okrążenia. Przy równych czasach punkty za rundę dzielą się na pół; obustronne DNF daje 0 pkt. Walkower rozstrzyga mecz niezależnie od punktów, bez doliczania nieodbytych rund.</p>`;
}

export function initDuels({ api, getUser, toast }) {
  let sequence = 0, reportRequest = 0;
  const dialog = $('#duel-report-dialog');
  function config() {
    const tracks = [...document.querySelectorAll('[data-duel-track]:checked')].map(input => ({ size: +input.dataset.duelTrack, laps: $('#duel-laps-' + input.dataset.duelTrack).valueAsNumber }));
    if (!tracks.length || tracks.some(t => !Number.isInteger(t.laps) || t.laps < 1 || t.laps > 10)) throw Error('Wybierz przynajmniej jeden tor i od 1 do 10 okrążeń na każdym.');
    return tracks;
  }
  function updateConfig() {
    for (const input of document.querySelectorAll('[data-duel-track]')) $('#duel-laps-' + input.dataset.duelTrack).disabled = !input.checked;
    try {
      const tracks = config();
      const laps = tracks.reduce((sum, t) => sum + t.laps, 0), total = tracks.reduce((sum, t) => sum + t.laps * (1 + (t.size - 4) / 2), 0);
      $('#duel-config-summary').textContent = `${tracks.map(t => `${t.size}×${t.size}: ${t.laps} okr.`).join(' → ')} · ${laps} rund · pula ${points(total)} pkt`;
    } catch (error) { $('#duel-config-summary').textContent = error.message; }
  }
  $('#duel-settings').addEventListener('input', updateConfig);
  updateConfig();
  function clear() {
    sequence++; reportRequest++;
    $('#duel-history').innerHTML = '<p class="ranking-status">Zaloguj się, aby zobaczyć historię meczów.</p>';
    $('#duel-report-content').innerHTML = '';
    if (dialog.open) dialog.close();
  }
  async function refresh() {
    const user = getUser();
    if (!user) { clear(); return; }
    const request = ++sequence;
    try {
      const data = await api('duels');
      if (request !== sequence || getUser()?.id !== user.id) return;
      $('#duel-history').innerHTML = data.matches.length ? data.matches.map(match => {
        const me = match.players.find(p => p.id === user.id), rival = match.players.find(p => p.id !== user.id);
        const outcome = match.status === 'active' || match.status === 'interrupted' ? statuses[match.status] : match.winner === null ? 'Remis' : match.winner === user.id ? 'Wygrana' : 'Przegrana';
        return `<article class="duel-history-row"><div><strong>vs ${escape(rival.username)}</strong><small>${escape(new Date(match.createdAt).toLocaleString('pl-PL'))} · ${outcome}${match.status === 'forfeit' ? ' · walkower' : ''}</small><small>${match.tracks.map(t => `${t.size}×${t.size}: ${t.laps} okr.`).join(' → ')} · ${match.completedRounds} / ${match.totalRounds} rund</small></div><div><strong>${points(me.points)} : ${points(rival.points)}</strong><button class="button small secondary" data-duel-report="${match.id}">Raport meczu →</button></div></article>`;
      }).join('') : '<p class="ranking-status">Tu pojawią się mecze z wybranymi torami i ich pełne raporty. Lista pokazuje ostatnich 20 meczów.</p>';
    } catch (error) {
      if (request !== sequence || getUser()?.id !== user.id) return;
      $('#duel-history').innerHTML = '<p class="ranking-status">Nie udało się pobrać historii meczów.</p><button class="button small secondary" data-duel-retry>Spróbuj ponownie</button>';
    }
  }
  $('#duel-history').addEventListener('click', async event => {
    if (event.target.closest('[data-duel-retry]')) { refresh(); return; }
    const button = event.target.closest('[data-duel-report]'), user = getUser();
    if (!button || !user) return;
    const request = ++reportRequest;
    try {
      button.disabled = true;
      const data = await api(`duels/${button.dataset.duelReport}`);
      if (request !== reportRequest || getUser()?.id !== user.id) return;
      $('#duel-report-content').innerHTML = renderDuelReport(data.report, user.id);
      if (!dialog.open) dialog.showModal();
    } catch (error) { if (getUser()?.id === user.id) toast(error.message); }
    finally { button.disabled = false; }
  });
  $('#duel-report-close').addEventListener('click', () => dialog.close());
  return { config, refresh, clear };
}
