// HTTPS fallback for networks/browsers that reject WebSocket upgrades.
// Server events are streamed; commands are serialized to preserve click order.
export class HttpChannel extends EventTarget {
  readyState = WebSocket.CONNECTING;
  queue = Promise.resolve();
  constructor(clientId) {
    super();
    this.clientId = clientId;
    this.events = new EventSource(`/api/events?client=${clientId}`);
    this.events.addEventListener('open', () => { this.readyState = WebSocket.OPEN; });
    this.events.addEventListener('message', event => {
      if (this.readyState === WebSocket.CLOSED) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'transport-ready') this.stream = data.stream;
      else if (data.type === 'transport-ping') this.send(JSON.stringify({ action: 'transport-pong' }));
      else this.dispatchEvent(new MessageEvent('message', { data: event.data }));
    });
    this.events.addEventListener('transport-close', event => {
      try { this.fail(JSON.parse(event.data).code); } catch { this.fail(); }
    });
    this.events.addEventListener('error', async () => {
      if (this.readyState === WebSocket.CLOSED) return;
      this.readyState = WebSocket.CONNECTING;
      this.events.close();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      // EventSource does not expose HTTP error status. Check only on failure,
      // never on a timed click or a healthy heartbeat.
      try {
        const response = await fetch('/api/me', { signal: controller.signal });
        if (response.ok && !(await response.json()).user) { this.fail(4003); return; }
      } catch { /* A network failure is retried by the connection manager. */ }
      finally { clearTimeout(timer); }
      this.fail();
    });
  }
  send(raw) {
    if (this.readyState !== WebSocket.OPEN) throw Error('Połączenie przerwane.');
    const payload = { ...JSON.parse(raw), client: this.clientId, stream: this.stream };
    this.queue = this.queue.then(async () => {
      if (this.readyState !== WebSocket.OPEN) return;
      this.pending = new AbortController();
      const timer = setTimeout(() => this.pending?.abort(), 10000);
      try {
        const response = await fetch('/api/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: this.pending.signal });
        if (response.status === 401) this.fail(4003);
        else if (!response.ok) this.fail();
      } catch { this.fail(); }
      finally { clearTimeout(timer); this.pending = null; }
    });
  }
  fail(code = 1006) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.events.close(); this.pending?.abort();
    this.dispatchEvent(new CloseEvent('close', { code }));
  }
  close() { this.fail(1000); }
}
