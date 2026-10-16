const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const seconds = score => score == null ? '—' : `${(score / 100).toFixed(2)} s`;
const outcomes = { win: 'Wygrana', loss: 'Przegrana', draw: 'Remis', solo: 'Trening' };
const runCount = count => `${count} ${count === 1 ? 'przejazd' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'przejazdy' : 'przejazdów'}`;

export function createRanking({ api, getUser }) {
  let page = 1, pages = 1, highlight = null, lastMatch = null, sequence = 0, pending = null;
  function clear() {
    sequence++; pending = null; page = pages = 1; highlight = lastMatch = null;
    $('#ranking-results').hidden = $('#ranking-summary').hidden = $('#ranking-retry').hidden = true;
    $('#ranking-rows').innerHTML = $('#ranking-summary').innerHTML = '';
    $('#ranking-status').textContent = 'Zaloguj się, aby zobaczyć swój ranking przejazdów.';
    $('#run-ranking').setAttribute('aria-busy', 'false');
  }
  async function refresh() {
    const user = getUser();
    if (!user) { clear(); return; }
    const query = new URLSearchParams({ mode: $('#ranking-mode').value, size: $('#ranking-size').value, page });
    if (highlight) query.set('highlight', highlight);
    const key = `${user.id}:${query}`;
    if (pending === key) return;
    const request = ++sequence;
    pending = key;
    $('#run-ranking').setAttribute('aria-busy', 'true');
    $('#ranking-results').hidden = $('#ranking-summary').hidden = $('#ranking-retry').hidden = true;
    $('#ranking-status').textContent = 'Wczytywanie przejazdów…';
    try {
      const data = await api(`runs?${query}`);
      if (request !== sequence || getUser()?.id !== user.id) return;
      page = data.page; pages = data.pages;
      $('#ranking-summary').innerHTML = [
        ['Ukończone przejazdy', data.total], ['Najlepszy wynik', seconds(data.summary.best)],
        ['Średni wynik z karami', seconds(data.summary.average)], ['Suma kar', `+${data.summary.errors} s`],
      ].map(([label, value]) => `<div><small>${label}</small><strong>${value}</strong></div>`).join('');
      $('#ranking-summary').hidden = !data.total;
      $('#ranking-status').textContent = data.total
        ? `${runCount(data.total)} · bez błędów: ${data.summary.clean}.${data.highlight ? ` Nowy przejazd: miejsce ${data.highlight.place}.` : ''}`
        : 'Brak ukończonych przejazdów dla tych filtrów. Wybierz inny tryb lub rozmiar planszy albo rozpocznij trening.';
      $('#ranking-rows').innerHTML = data.rows.map(row => {
        const isNew = row.id === data.highlight?.id;
        const date = new Date(row.finished_at).toLocaleString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const reason = row.reason === 'forfeit' ? ' · walkower' : row.reason === 'timeout' ? ' · limit czasu' : '';
        return `<tr data-run-id="${row.id}"${isNew ? ' class="ranking-new"' : ''}><td class="ranking-place">${row.place}${isNew ? '<small class="new-label">NOWY</small>' : ''}</td><td><strong>${row.mode === 'solo' ? 'Trening solo' : `vs ${escape(row.opponent || 'Rywal')}`}</strong><small>${escape(date)} · ${outcomes[row.outcome] || ''}${reason}</small></td><td>${row.size} × ${row.size}</td><td>${seconds(Math.round(row.elapsed / 10))}</td><td>+${row.errors} s<small>${row.errors} bł.</small></td><td class="ranking-score">${seconds(row.score)}</td></tr>`;
      }).join('');
      $('#ranking-results').hidden = !data.total;
      $('#ranking-page').textContent = `${page} / ${pages}`;
      $('#ranking-prev').disabled = page <= 1;
      $('#ranking-next').disabled = page >= pages;
    } catch (error) {
      if (request !== sequence || getUser()?.id !== user.id) return;
      $('#ranking-status').textContent = `Nie udało się wczytać rankingu. ${error.message}`;
      $('#ranking-retry').hidden = false;
    } finally {
      if (request === sequence) { pending = null; $('#run-ranking').setAttribute('aria-busy', 'false'); }
    }
  }
  for (const selector of ['#ranking-mode', '#ranking-size']) $(selector).addEventListener('change', () => { page = 1; highlight = null; refresh(); });
  $('#ranking-prev').addEventListener('click', () => { if (page > 1) { page--; highlight = null; refresh(); } });
  $('#ranking-next').addEventListener('click', () => { if (page < pages) { page++; highlight = null; refresh(); } });
  $('#ranking-retry').addEventListener('click', refresh);
  function finished(game) {
    if (!game?.saved || !game.matchId || game.matchId === lastMatch || game.players.find(p => p.me)?.score == null) return;
    lastMatch = highlight = game.matchId;
    $('#ranking-mode').value = game.mode;
    $('#ranking-size').value = String(game.size);
    page = 1;
  }
  return { refresh, clear, finished };
}
