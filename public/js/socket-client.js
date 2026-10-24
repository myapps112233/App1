/**
 * Thin Socket.IO wrapper. All requests resolve with a structured result:
 *   { ok: true, ... } or { ok: false, code, message }
 * so the UI never has to deal with thrown transport errors.
 */

export function createSocketClient(handlers = {}) {
  const ioGlobal = globalThis.io;
  if (typeof ioGlobal !== 'function') {
    throw new Error('Socket.IO client failed to load');
  }

  const socket = ioGlobal({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 600,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });

  socket.on('connect', () => handlers.onConnectionChange?.('connected'));
  socket.on('disconnect', (reason) => handlers.onConnectionChange?.('offline', reason));
  socket.io.on('reconnect_attempt', () => handlers.onConnectionChange?.('reconnecting'));
  socket.io.on('reconnect_failed', () => handlers.onConnectionChange?.('offline'));

  socket.on('room:state', (payload) => handlers.onState?.(payload));
  socket.on('scores', (payload) => handlers.onScores?.(payload));
  socket.on('sticker:event', (payload) => handlers.onSticker?.(payload));
  socket.on('match:started', (payload) => handlers.onMatchStarted?.(payload));
  socket.on('match:ended', (payload) => handlers.onMatchEnded?.(payload));
  socket.on('notice', (payload) => handlers.onNotice?.(payload));
  socket.on('room:closed', (payload) => handlers.onRoomClosed?.(payload));
  socket.on('session:replaced', () => handlers.onSessionReplaced?.());

  function request(event, payload = {}, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({
          ok: false,
          code: 'OFFLINE',
          message: 'You are offline. Check your connection and try again.',
        });
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
          if (error) {
            finish({
              ok: false,
              code: 'TIMEOUT',
              message: 'The server did not answer. Check your connection.',
            });
            return;
          }
          if (!response || typeof response !== 'object') {
            finish({ ok: false, code: 'NO_RESPONSE', message: 'Unexpected server response.' });
            return;
          }
          finish(response);
        });
      } catch {
        finish({ ok: false, code: 'OFFLINE', message: 'The connection is not ready yet.' });
      }
    });
  }

  async function timeSync() {
    const sentAt = Date.now();
    const response = await request('time:sync');
    const receivedAt = Date.now();
    if (!response.ok || !Number.isFinite(response.serverNow)) return null;
    return { serverNow: response.serverNow, sentAt, receivedAt };
  }

  return {
    socket,
    request,
    timeSync,
    get connected() {
      return socket.connected;
    },
    get id() {
      return socket.id;
    },
    connect() {
      if (socket.disconnected) socket.connect();
    },
    disconnect() {
      socket.disconnect();
    },
  };
}
