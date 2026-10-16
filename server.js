import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, randomInt, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.js';
import { createHttpChannel } from './http-channel.js';
import { parseRunFilters, rankedRuns } from './runs.js';

const scrypt = promisify(scryptCallback);
const root = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const cookieToken = req => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('rf_session='))?.slice(11);

export async function createApp({ database = process.env.DATABASE_URL || process.env.DB_PATH || resolve(root, 'data/race-focus.sqlite'), databaseSchema, countdownMs = 3000, roundMs = 180000, publicOrigin = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL, cookieSecure = process.env.COOKIE_SECURE === '1' || !!process.env.RENDER } = {}) {
  if (process.env.RENDER && !/^postgres(?:ql)?:/.test(database)) throw Error('Render wymaga DATABASE_URL do trwałej bazy PostgreSQL. Lokalny plik nie jest trwały w planie Free.');
  if (publicOrigin) {
    try { const parsed = new URL(publicOrigin); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw Error(); publicOrigin = parsed.origin; }
    catch { throw Error('PUBLIC_ORIGIN musi być samym adresem strony, np. https://gra.onrender.com.'); }
  }
  const db = await openDatabase(database, { schema: databaseSchema });
  const clients = new Map(), rooms = new Map(), games = new Map();
  const app = express();
  const expectedOrigin = req => publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const websocketOrigin = new URL(expectedOrigin(req));
    websocketOrigin.protocol = websocketOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${websocketOrigin.origin}; img-src 'self' data:; frame-ancestors 'none'` });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  // Render health probes must not keep a free Neon database awake all day.
  // /api/ready is the explicit database readiness check used during deployment.
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/version', (req, res) => res.json({ release: 'room-rematches-1', commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || 'local', transports: ['websocket', 'https'] }));
  app.get('/api/ready', async (req, res) => { await db.get('SELECT 1'); res.json({ ok: true, database: db.dialect }); });
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && (req.headers.origin && req.headers.origin !== expectedOrigin(req))) return res.status(403).json({ error: 'Niedozwolone pochodzenie żądania.' });
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Wymagany format JSON.' });
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.post('/api/play', async (req, res) => {
    const token = cookieToken(req);
    if (!token) return res.status(401).json({ error: 'Zaloguj się ponownie.' });
    // Authenticate against the live, already-authenticated stream; no database
    // query is made per click. Commands use exactly the same rules as WS.
    const c = [...clients.values()].find(c => c.clientId === req.body?.client && c.streamId === req.body?.stream && c.tokenHash === hash(token) && c.http);
    if (!c) return res.status(409).json({ error: 'Połączenie gry wygasło. Połącz się ponownie.' });
    if (c.revoked || c.user.expires <= Date.now()) return res.status(401).json({ error: 'Zaloguj się ponownie.' });
    await c.receive(JSON.stringify(req.body));
    res.sendStatus(204);
  });
  const userFor = async req => {
    const token = cookieToken(req);
    return token ? db.get('SELECT u.id, u.username, s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', hash(token), Date.now()) : undefined;
  };
  app.use('/api', async (req, res, next) => { req.user = await userFor(req); next(); });
  const requireUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Zaloguj się, aby rozpocząć.' });
  app.get('/api/events', requireUser, (req, res) => {
    const clientId = req.query.client;
    if (typeof clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clientId)) return res.status(400).json({ error: 'Nieprawidłowe połączenie.' });
    if (req.headers.origin && req.headers.origin !== expectedOrigin(req)) return res.status(403).json({ error: 'Niedozwolone pochodzenie żądania.' });
    const stream = createHttpChannel(req, res);
    wss.emit('connection', stream, req.user, cookieToken(req), clientId, true);
  });
  const attempts = new Map();
  const authLimit = (req, res, next) => {
    const key = req.socket.remoteAddress;
    let entry = attempts.get(key);
    if (!entry || entry.until < Date.now()) attempts.set(key, entry = { count: 0, until: Date.now() + 60000 });
    if (++entry.count > 20) return res.status(429).json({ error: 'Za dużo prób. Poczekaj minutę.' });
    next();
  };
  async function setSession(req, res, id) {
    const previous = cookieToken(req);
    if (previous) {
      await db.run('DELETE FROM sessions WHERE token=?', hash(previous));
      for (const c of clients.values()) if (c.tokenHash === hash(previous)) { c.revoked = true; await leave(c); c.ws.close(4003, 'Sesja wygasła.'); }
    }
    const token = randomBytes(32).toString('hex');
    await db.run('DELETE FROM sessions WHERE expires<?', Date.now());
    await db.run('INSERT INTO sessions VALUES (?,?,?)', hash(token), id, Date.now() + 7 * 86400000);
    res.cookie('rf_session', token, { httpOnly: true, sameSite: 'strict', secure: cookieSecure, path: '/', maxAge: 7 * 86400000 });
  }
  app.post('/api/register', authLimit, async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Login: 3–20 liter, cyfr lub znaków _.' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Hasło musi mieć od 8 do 128 znaków.' });
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
    let id;
    try { id = (await db.get('INSERT INTO users(username,salt,password,created_at) VALUES (?,?,?,?) RETURNING id', username, salt, passwordHash, Date.now())).id; }
    catch (error) { if ((error.code?.includes('SQLITE') || error.code === '23505') && await db.get('SELECT id FROM users WHERE lower(username)=lower(?)', username)) return res.status(409).json({ error: 'Ten login jest już zajęty.' }); throw error; }
    await setSession(req, res, id);
    res.status(201).json({ user: { id, username } });
  });
  app.post('/api/login', authLimit, async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 20 || password.length > 128) return res.status(400).json({ error: 'Nieprawidłowy login lub hasło.' });
    const user = await db.get('SELECT * FROM users WHERE lower(username)=lower(?)', username);
    const candidate = await scrypt(password, user?.salt || 'invalid-user-salt', 64);
    if (!user || !timingSafeEqual(candidate, Buffer.from(user.password, 'hex'))) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });
    await setSession(req, res, user.id);
    res.json({ user: { id: user.id, username: user.username } });
  });
  app.get('/api/me', (req, res) => res.json({ user: req.user ? { id: req.user.id, username: req.user.username } : null }));
  app.post('/api/logout', requireUser, async (req, res) => {
    await db.run('DELETE FROM sessions WHERE token=?', hash(cookieToken(req)));
    const client = clients.get(req.user.id);
    if (client) { client.revoked = true; await leave(client); client.ws.close(1000, 'Wylogowano'); }
    res.clearCookie('rf_session', { path: '/' }); res.json({ ok: true });
  });
  app.get('/api/stats', requireUser, async (req, res) => {
    const totals = await db.get(`SELECT COUNT(*) games, COALESCE(SUM(CASE WHEN r.outcome='win' THEN 1 ELSE 0 END),0) wins, COALESCE(SUM(CASE WHEN r.outcome='loss' THEN 1 ELSE 0 END),0) losses, COALESCE(SUM(CASE WHEN r.outcome='draw' THEN 1 ELSE 0 END),0) draws FROM results r JOIN matches m ON m.id=r.match_id WHERE user_id=? AND m.mode='duel'`, req.user.id);
    const records = await db.all(`SELECT m.size, MIN(r.score) best, COUNT(*) runs, ROUND(AVG(r.score)) average FROM results r JOIN matches m ON m.id=r.match_id WHERE r.user_id=? AND m.mode='solo' AND r.score IS NOT NULL GROUP BY m.size ORDER BY m.size`, req.user.id);
    const history = await db.all(`SELECT m.id, m.mode, m.size, m.finished_at, m.reason, r.elapsed, r.errors, r.score, r.outcome, (SELECT u.username FROM results rr JOIN users u ON u.id=rr.user_id WHERE rr.match_id=m.id AND rr.user_id<>?) opponent FROM results r JOIN matches m ON m.id=r.match_id WHERE r.user_id=? ORDER BY m.id DESC LIMIT 20`, req.user.id, req.user.id);
    res.json({ totals, records, history });
  });
  app.get('/api/runs', requireUser, async (req, res) => {
    const filters = parseRunFilters(req.query);
    if (!filters) return res.status(400).json({ error: 'Wybierz tryb, planszę 4×4, 5×5, 6×6 lub 7×7 oraz poprawny numer strony.' });
    res.json(await rankedRuns(db, req.user.id, filters));
  });
  app.use(express.static(resolve(root, 'public'), { setHeaders(res, path) {
    if (path.endsWith('/sw.js')) { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Service-Worker-Allowed', '/'); }
    if (path.endsWith('/manifest.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
  } }));
  app.use((err, req, res, next) => { console.error('Błąd żądania:', err.code || err.status || 'internal'); res.status(err.status || 503).json({ error: err.status === 400 ? 'Nieprawidłowe dane.' : 'Nie udało się wykonać operacji. Spróbuj ponownie za chwilę.' }); });
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    try {
      const url = new URL(req.url, 'http://localhost');
      const clientId = url.searchParams.get('client');
      if (url.pathname !== '/ws' || (clientId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clientId)) || req.headers.origin !== expectedOrigin(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      const user = await userFor(req);
      if (!user) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      if (!socket.destroyed) wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, user, cookieToken(req), clientId));
    } catch { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); }
  });
  const send = (client, data) => { if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(data)); };
  const roomPlayersPresent = game => game.players.length === 2 && game.players.every(p => {
    const c = clients.get(p.id);
    return c?.game === game && !c.revoked && c.ws.readyState === WebSocket.OPEN;
  });
  function state(game, id) {
    return { type: 'state', game: { id: game.id, round: game.round, matchId: game.matchId ?? null, mode: game.mode, code: game.mode === 'duel' ? game.id : null, canRematch: game.mode === 'duel' && game.phase === 'complete' && game.saved === true && roomPlayersPresent(game), size: game.size, phase: game.phase, startAt: game.startAt, deadline: game.startAt ? game.startAt + roundMs : null, serverNow: Date.now(), board: ['racing', 'saving', 'complete'].includes(game.phase) ? game.board : [], reason: game.reason, saved: game.saved ?? null,
      players: game.players.map(p => ({ id: p.id, username: p.username, ready: p.ready, next: p.next, errors: p.errors, elapsed: p.elapsed, score: p.score, outcome: p.outcome, me: p.id === id })) } };
  }
  function broadcast(game) { for (const p of game.players) { const c = clients.get(p.id); if (c?.game === game) send(c, state(game, p.id)); } }
  const player = c => ({ id: c.user.id, username: c.user.username, ready: false, next: 1, errors: 0, elapsed: null, score: null, outcome: null });
  function finish(game, reason = 'finished', loser = null) {
    if (game.phase === 'saving') return game.finishPromise;
    if (game.phase === 'complete') return;
    clearTimeout(game.startTimer); clearTimeout(game.endTimer);
    game.phase = 'saving'; game.reason = reason; game.finishedAt = Date.now();
    for (const p of game.players) p.ready = false;
    const [a, b] = game.players;
    if (game.mode === 'solo') a.outcome = 'solo';
    else if (loser) { for (const p of game.players) p.outcome = p.id === loser ? 'loss' : 'win'; }
    else {
      const as = a.score ?? Infinity, bs = b.score ?? Infinity;
      a.outcome = as === bs ? 'draw' : as < bs ? 'win' : 'loss';
      b.outcome = as === bs ? 'draw' : bs < as ? 'win' : 'loss';
    }
    return persistResult(game);
  }
  function persistResult(game) {
    game.phase = 'saving'; broadcast(game);
    game.finishPromise = (async () => {
      try {
        game.matchId = await db.transaction(async tx => {
          const { id } = await tx.get('INSERT INTO matches(mode,size,finished_at,reason,save_key) VALUES (?,?,?,?,?) ON CONFLICT(save_key) DO UPDATE SET save_key=excluded.save_key RETURNING id', game.mode, game.size, game.finishedAt, game.reason, game.saveKey);
          for (const p of game.players) await tx.run('INSERT INTO results VALUES (?,?,?,?,?,?) ON CONFLICT(match_id,user_id) DO NOTHING', id, p.id, p.elapsed, p.errors, p.score, p.outcome);
          return id;
        });
        game.saved = true;
      } catch { game.saved = false; console.error('Nie udało się zapisać wyniku meczu. Można ponowić zapis.'); }
      game.phase = 'complete'; rooms.delete(game.id);
      if (game.mode === 'solo' || !game.players.some(p => clients.get(p.id)?.game === game)) games.delete(game.id);
      broadcast(game);
    })();
    return game.finishPromise;
  }
  function start(game) {
    game.phase = 'countdown'; game.startAt = Date.now() + countdownMs;
    game.board = Array.from({ length: game.size ** 2 }, (_, i) => i + 1);
    for (let i = game.board.length - 1; i > 0; i--) { const j = randomInt(i + 1); [game.board[i], game.board[j]] = [game.board[j], game.board[i]]; }
    game.startTimer = setTimeout(() => { game.phase = 'racing'; broadcast(game); }, countdownMs);
    game.endTimer = setTimeout(() => finish(game, 'timeout'), countdownMs + roundMs);
    broadcast(game);
  }
  async function leave(c) {
    const g = c.game;
    if (!g) return;
    if (g.phase === 'waiting') {
      g.players = g.players.filter(p => p.id !== c.user.id);
      for (const p of g.players) p.ready = false;
      if (!g.players.length) { rooms.delete(g.id); games.delete(g.id); } else broadcast(g);
    } else if (g.phase === 'saving') { await g.finishPromise; }
    else if (g.phase !== 'complete') {
      if (g.mode === 'duel') await finish(g, 'forfeit', c.user.id);
      else { clearTimeout(g.startTimer); clearTimeout(g.endTimer); games.delete(g.id); }
    }
    if (c.game === g) c.game = null;
    if (g.phase === 'complete') {
      // Keep the finished results intact for the remaining player, but cancel
      // readiness as soon as either participant leaves the room.
      for (const p of g.players) p.ready = false;
      if (!g.players.some(p => clients.get(p.id)?.game === g) && games.get(g.id) === g) games.delete(g.id);
      broadcast(g);
    }
  }
  async function command(c, data) {
    if (!data || typeof data !== 'object') throw Error('Nieprawidłowe polecenie.');
    if (data.action === 'ping') { if (Number.isSafeInteger(data.id)) send(c, { type: 'pong', id: data.id }); return; }
    if (data.action === 'transport-pong') { c.alive = true; return; }
    const g = c.game;
    if (['solo', 'create', 'join'].includes(data.action)) {
      if (g && g.phase !== 'complete') throw Error('Najpierw zakończ lub opuść aktualną grę.');
      if (g?.saved === false) throw Error('Najpierw ponów zapis poprzedniego wyniku.');
      if (data.action === 'join') {
        const room = rooms.get(String(data.code || '').trim().toUpperCase());
        if (!room || room.phase !== 'waiting') throw Error('Nie znaleziono dostępnego pokoju.');
        if (room.players.length >= 2) throw Error('Pokój jest pełny.');
        if (g) await leave(c);
        if (c.game || c.revoked || c.ws.readyState !== WebSocket.OPEN) return;
        if (room.phase !== 'waiting' || room.players.length >= 2 || rooms.get(room.id) !== room) throw Error('Pokój nie jest już dostępny.');
        c.game = room; room.players.push(player(c)); broadcast(room); return;
      }
      if (![4, 5, 6, 7].includes(data.size)) throw Error('Wybierz rozmiar 4×4, 5×5, 6×6 lub 7×7.');
      if (g) await leave(c);
      if (c.game || c.revoked || c.ws.readyState !== WebSocket.OPEN) return;
      let id; do { id = randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); } while (games.has(id));
      const game = { id, round: 1, saveKey: randomUUID(), mode: data.action === 'solo' ? 'solo' : 'duel', size: data.size, phase: 'waiting', players: [player(c)], board: [] };
      c.game = game; games.set(id, game);
      if (game.mode === 'solo') start(game); else { rooms.set(id, game); broadcast(game); }
    } else if (data.action === 'leave') { await leave(c); send(c, { type: 'state', game: null }); }
    else if (data.action === 'retry-save') {
      if (g?.phase === 'complete' && g.saved === false) await persistResult(g);
    }
    else if (data.action === 'rematch') {
      if (!g || g.mode !== 'duel' || g.phase !== 'complete') throw Error('Ta runda nie jest już dostępna do rewanżu.');
      if (!g.saved) throw Error('Najpierw ponów zapis wyniku rundy.');
      if (g.matchId !== data.matchId) throw Error('Ta runda nie jest już dostępna do rewanżu.');
      if (!roomPlayersPresent(g)) throw Error('Rywal opuścił pokój. Utwórz nowy pokój, aby zagrać.');
      g.players.find(p => p.id === c.user.id).ready = true;
      if (!g.players.every(p => p.ready)) { broadcast(g); return; }
      // A fresh match object and save key isolate timers, retries and results
      // from previous rounds while both clients keep the same room code.
      const next = { id: g.id, round: g.round + 1, saveKey: randomUUID(), mode: 'duel', size: g.size, phase: 'waiting', players: g.players.map(p => player(clients.get(p.id))), board: [] };
      for (const p of next.players) clients.get(p.id).game = next;
      games.set(next.id, next);
      start(next);
    }
    else if (data.action === 'ready') {
      if (!g || g.phase !== 'waiting' || g.players.length !== 2) throw Error('Poczekaj na drugiego gracza.');
      g.players.find(p => p.id === c.user.id).ready = true;
      if (g.players.every(p => p.ready)) start(g); else broadcast(g);
    } else if (data.action === 'hit') {
      if (!g || g.phase !== 'racing' || Date.now() < g.startAt) return;
      const p = g.players.find(p => p.id === c.user.id);
      if (p.score !== null || !Number.isInteger(data.number) || data.number < 1 || data.number > g.size ** 2) return;
      if (Date.now() >= g.startAt + roundMs) { finish(g, 'timeout'); return; }
      if (data.number !== p.next) p.errors++;
      else p.next++;
      if (p.next > g.size ** 2) { p.elapsed = Date.now() - g.startAt; p.score = Math.round((p.elapsed + p.errors * 1000) / 10); }
      if (g.players.every(p => p.score !== null)) finish(g); else broadcast(g);
    } else throw Error('Nieznane polecenie.');
  }
  wss.on('connection', (ws, user, token, clientId, http = false) => {
    const previous = clients.get(user.id);
    let released = Promise.resolve(), resumed = null;
    if (previous) {
      if (!clientId || previous.clientId !== clientId || previous.tokenHash !== hash(token)) { ws.close(4001, 'Konto jest otwarte w innej karcie.'); return; }
      previous.revoked = true;
      clients.delete(user.id);
      if (previous.game?.phase === 'complete') {
        resumed = previous.game; previous.game = null;
        for (const p of resumed.players) p.ready = false;
      } else released = leave(previous);
      previous.ws.terminate();
    }
    const c = { ws, user, clientId, http, streamId: http ? randomBytes(16).toString('hex') : null, tokenHash: hash(token), revoked: false, game: resumed, alive: true, count: 0, window: Date.now() };
    clients.set(user.id, c);
    if (http) send(c, { type: 'transport-ready', stream: c.streamId });
    send(c, { type: 'connected' });
    if (resumed) broadcast(resumed);
    released.then(() => { if (previous && clients.get(user.id) === c) send(c, { type: 'refresh-stats' }); }).catch(() => console.error('Błąd zamykania poprzedniego połączenia.'));
    ws.on('pong', () => { c.alive = true; });
    c.receive = async raw => {
      try {
        // Authenticate at upgrade, cache expiration, and invalidate local sockets on logout.
        // No database round trip belongs in a timed click or an idle heartbeat.
        if (c.revoked || user.expires <= Date.now()) { ws.close(4003, 'Sesja wygasła.'); return; }
        if (Date.now() - c.window >= 1000) { c.window = Date.now(); c.count = 0; }
        if (++c.count > 60) throw Error('Zbyt wiele kliknięć. Zwolnij na moment.');
        await command(c, JSON.parse(raw));
      } catch (error) { send(c, { type: 'error', message: error instanceof SyntaxError ? 'Nieprawidłowe dane.' : error.message }); }
    };
    ws.on('message', c.receive);
    ws.on('close', () => { if (clients.get(user.id) === c) clients.delete(user.id); leave(c).catch(() => console.error('Błąd zamykania rozgrywki.')); });
    ws.on('error', () => ws.terminate());
  });
  const heartbeat = setInterval(() => {
    for (const c of clients.values()) { if (!c.alive) c.ws.terminate(); else { c.alive = false; c.ws.ping(); } }
    for (const [key, a] of attempts) if (a.until < Date.now()) attempts.delete(key);
  }, 15000);
  heartbeat.unref();
  return { server, db, async close() {
    clearInterval(heartbeat);
    for (const c of clients.values()) await leave(c);
    for (const c of clients.values()) c.ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await db.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let instance;
  try { instance = await createApp(); }
  catch { console.error('Nie udało się uruchomić bazy. Sprawdź DATABASE_URL, dostęp do PostgreSQL i konfigurację TLS. Dane połączenia nie są wypisywane.'); process.exit(1); }
  const port = Number(process.env.PORT || 3000);
  instance.server.listen(port, '0.0.0.0', () => console.log(`Race Focus listening on port ${port}`));
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await instance.close(); process.exit(0); });
}
