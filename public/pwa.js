export function initPwa() {
  const card = document.querySelector('#install-card');
  const installButton = document.querySelector('#install-button');
  const dialog = document.querySelector('#install-dialog');
  const networkNotice = document.querySelector('#network-notice');
  const updateNotice = document.querySelector('#update-notice');
  const updateButton = document.querySelector('#update-button');
  const updateText = document.querySelector('#update-text');
  const standalone = window.matchMedia('(display-mode: standalone)');
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let prompt = null, registration = null, activeGame = false, updateReady = false, requestedReload = false;

  function renderInstall() { card.hidden = standalone.matches || navigator.standalone === true; }
  function renderStatus() {
    const online = navigator.onLine;
    networkNotice.hidden = online;
    updateNotice.hidden = !updateReady || !online || activeGame;
    updateButton.disabled = activeGame || requestedReload;
    updateText.textContent = activeGame ? 'Nowa wersja czeka. Zaktualizuj po zakończeniu gry i zapisaniu wyniku.' : 'Nowa wersja Race Focus jest gotowa.';
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); prompt = event;
    installButton.textContent = 'Zainstaluj aplikację';
  });
  window.addEventListener('appinstalled', () => { prompt = null; card.hidden = true; if (dialog.open) dialog.close(); });
  standalone.addEventListener('change', renderInstall);
  installButton.addEventListener('click', async () => {
    if (prompt) {
      const pending = prompt; prompt = null;
      try { await pending.prompt(); await pending.userChoice; }
      catch { showInstructions(); }
    } else showInstructions();
  });
  function showInstructions() {
    document.querySelector('#install-title').textContent = ios ? 'Race Focus na iPhonie i iPadzie' : 'Race Focus na Twoim urządzeniu';
    document.querySelector('#install-steps').innerHTML = ios
      ? '<li>Otwórz adres gry w <strong>Safari</strong>.</li><li>Dotknij <strong>Udostępnij</strong> — ikony kwadratu ze strzałką w górę.</li><li>Wybierz <strong>Dodaj do ekranu początkowego</strong>. Jeśli widzisz opcję „Otwórz jako aplikację”, pozostaw ją włączoną.</li><li>Potwierdź <strong>Dodaj</strong> i otwórz grę z nowej ikony.</li>'
      : '<li>Otwórz grę w <strong>Chrome lub Edge</strong>.</li><li>W menu przeglądarki wybierz <strong>Zainstaluj aplikację</strong> albo <strong>Dodaj do ekranu głównego</strong>.</li><li>Potwierdź instalację i otwórz Race Focus z nowej ikony.</li>';
    if (!dialog.open) dialog.showModal();
  }
  document.querySelector('#close-install').addEventListener('click', () => dialog.close());
  window.addEventListener('offline', renderStatus);
  window.addEventListener('online', renderStatus);
  updateButton.addEventListener('click', () => {
    if (activeGame || !navigator.onLine || requestedReload) return;
    if (registration?.waiting) {
      requestedReload = true; renderStatus();
      registration.waiting.postMessage({ type: 'APPLY_UPDATE' });
    } else window.location.reload();
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (requestedReload && !activeGame) window.location.reload();
      else if (requestedReload) { requestedReload = false; updateReady = true; renderStatus(); }
      // A first install or an update in a different tab never reloads this tab.
    });
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(value => {
      registration = value;
      function checkWaiting() {
        if (registration.waiting && navigator.serviceWorker.controller) { updateReady = true; renderStatus(); }
      }
      checkWaiting();
      registration.addEventListener('updatefound', () => {
        registration.installing?.addEventListener('statechange', checkWaiting);
      });
      let lastCheck = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && navigator.onLine && Date.now() - lastCheck > 60000) {
          lastCheck = Date.now(); registration.update().catch(() => {});
        }
      });
    }).catch(() => {
      document.querySelector('#install-note').textContent = 'Nie udało się przygotować instalacji. Spróbuj ponownie po odświeżeniu strony. Gra w przeglądarce pozostaje dostępna.';
    });
  }
  renderInstall(); renderStatus();
  return { setGameActive(value) { activeGame = Boolean(value); renderStatus(); } };
}
