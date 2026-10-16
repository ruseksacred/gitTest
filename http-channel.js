import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

export function createHttpChannel(req, res) {
  const channel = new EventEmitter();
  channel.readyState = WebSocket.OPEN;
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  channel.send = payload => { if (channel.readyState === WebSocket.OPEN) res.write(`data: ${payload}\n\n`); };
  channel.close = (code = 1000) => {
    if (channel.readyState === WebSocket.CLOSED) return;
    channel.readyState = WebSocket.CLOSED;
    if (!res.destroyed) { res.write(`event: transport-close\ndata: ${JSON.stringify({ code })}\n\n`); res.end(); }
    channel.emit('close');
  };
  channel.terminate = () => channel.close(1006);
  channel.ping = () => channel.send(JSON.stringify({ type: 'transport-ping' }));
  res.on('close', () => channel.close());
  return channel;
}
