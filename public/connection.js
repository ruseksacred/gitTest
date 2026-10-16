// A transport connection is not a game session. Reconnect only the transport;
// never replay clicks or readiness messages from an interrupted match.
import { HttpChannel } from './http-channel.js';

export function createGameConnection({ onMessage, onStatus, onDisconnect }) {
  const clientId = crypto.randomUUID();
  let socket = null, ready = false, stopped = true, blocked = null;
  let opening = null, openingReject = null, handshakeTimer = null, retryTimer = null, attempts = 0, pingId = 0;
  const probes = new Map();
  let transport = 'websocket';
  const connected = () => ready && socket?.readyState === WebSocket.OPEN;
  const status = (state, message) => onStatus({ state, message });
  function rejectProbes() {
    for (const probe of probes.values()) { clearTimeout(probe.timer); probe.reject(Error('Połączenie zostało przerwane.')); }
    probes.clear();
  }
  function retry() {
    if (stopped || blocked || !navigator.onLine || document.hidden || retryTimer) return;
    if (attempts >= 4) { status('disconnected', 'Nie udało się połączyć. Wybierz „Połącz ponownie”, aby spróbować jeszcze raz.'); return; }
    retryTimer = setTimeout(() => { retryTimer = null; open().catch(() => {}); }, Math.min(500 * 2 ** attempts++, 4000));
  }
  function drop(reason = 'reconnect') {
    const previous = socket, wasReady = ready;
    socket = null; ready = false;
    clearTimeout(handshakeTimer); handshakeTimer = null;
    openingReject?.(Error('Połączenie zostało przerwane.')); openingReject = null; opening = null;
    rejectProbes();
    previous?.close();
    if (wasReady) onDisconnect(reason);
  }
  function open() {
    if (stopped) return Promise.reject(Error('Połącz się ponownie, aby rozpocząć grę.'));
    if (blocked) return Promise.reject(Error(blocked));
    if (!navigator.onLine) return Promise.reject(Error('Brak internetu. Sprawdź połączenie z siecią.'));
    if (connected()) return Promise.resolve();
    if (opening) return opening;
    if (socket) drop();
    clearTimeout(retryTimer); retryTimer = null;
    status('connecting', 'Łączenie z serwerem…');
    let ws;
    try {
      ws = transport === 'http' ? new HttpChannel(clientId) : new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?client=${clientId}`);
    } catch {
      // Safari can throw SecurityError synchronously instead of emitting a
      // close event. A connecting state must never be left without a timeout.
      if (transport === 'websocket') { transport = 'http'; return open(); }
      status('disconnected', 'Nie udało się uruchomić połączenia. Spróbuj ponownie.');
      retry(); return Promise.reject(Error('Nie udało się uruchomić połączenia.'));
    }
    socket = ws;
    opening = new Promise((resolve, reject) => {
      openingReject = reject;
      handshakeTimer = setTimeout(() => {
        if (socket !== ws) return;
        if (transport === 'websocket') transport = 'http';
        drop(); status('disconnected', 'Serwer nie odpowiada. Spróbuj połączyć się ponownie.'); retry();
      }, transport === 'websocket' ? 5000 : 15000);
      ws.addEventListener('message', event => {
        if (socket !== ws) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'connected') {
          clearTimeout(handshakeTimer); handshakeTimer = null;
          ready = true; attempts = 0; opening = null; openingReject = null;
          status('connected'); resolve();
        } else if (data.type === 'pong') {
          const probe = probes.get(data.id);
          if (probe) { clearTimeout(probe.timer); probes.delete(data.id); probe.resolve(); }
        } else onMessage(data);
      });
      ws.addEventListener('close', event => {
        if (socket !== ws) return;
        const wasReady = ready;
        ready = false; socket = null;
        clearTimeout(handshakeTimer); handshakeTimer = null;
        opening = null; openingReject = null; rejectProbes();
        if (wasReady) onDisconnect(event.code);
        if (event.code === 4001) {
          blocked = 'To konto jest otwarte w innej karcie. Zamknij ją i wybierz „Połącz ponownie”.';
          status('duplicate', blocked);
        } else if (event.code === 4003) {
          blocked = 'Sesja wygasła. Zaloguj się ponownie.';
          status('expired', blocked);
        } else {
          if (transport === 'websocket') transport = 'http';
          status('disconnected', navigator.onLine ? 'Połączenie przerwane. Próbujemy połączyć ponownie…' : 'Brak internetu. Połączymy się po przywróceniu sieci.');
          retry();
        }
        reject(Error(blocked || 'Nie udało się połączyć z serwerem. Spróbuj ponownie za chwilę.'));
      });
      ws.addEventListener('error', () => {});
    });
    return opening;
  }
  function probe() {
    if (!connected()) return Promise.reject(Error('Brak połączenia z serwerem.'));
    return new Promise((resolve, reject) => {
      const id = ++pingId;
      const timer = setTimeout(() => { probes.delete(id); reject(Error('Serwer nie odpowiada.')); }, 3000);
      probes.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ action: 'ping', id })); }
      catch { clearTimeout(timer); probes.delete(id); reject(Error('Połączenie zostało przerwane.')); }
    });
  }
  async function ensureAlive() {
    await open();
    try { await probe(); }
    catch {
      drop();
      await open(); await probe();
    }
  }
  function wake() {
    if (!stopped && !blocked && navigator.onLine && !document.hidden) ensureAlive().catch(() => retry());
  }
  window.addEventListener('online', wake);
  window.addEventListener('offline', () => { if (!stopped) { drop('offline'); status('disconnected', 'Brak internetu. Połączymy się po przywróceniu sieci.'); } });
  window.addEventListener('pageshow', wake);
  document.addEventListener('visibilitychange', wake);
  return {
    connected,
    ensureAlive,
    start() { stopped = false; blocked = null; attempts = 0; return open(); },
    reconnect() { stopped = false; blocked = null; attempts = 0; drop(); return ensureAlive(); },
    stop() { stopped = true; blocked = null; clearTimeout(retryTimer); retryTimer = null; drop('logout'); },
    send(action, payload = {}) {
      if (!connected()) throw Error('Połączenie przerwane. Zaczekaj na ponowne połączenie.');
      socket.send(JSON.stringify({ action, ...payload }));
    },
  };
}
