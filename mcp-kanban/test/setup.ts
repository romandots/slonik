// Vitest global setup (runs in each test worker before the test files).
//
// light-my-request's `MockSocket` (the socket behind Fastify `app.inject`)
// extends EventEmitter and does NOT implement `destroySoon()`. The MCP SDK's
// `StreamableHTTPServerTransport` routes requests through
// `@hono/node-server`'s request listener, which — 500ms after `handleRequest`
// — runs a body-drain `forceClose` that calls `socket.destroySoon()`. Under
// `app.inject` that socket is a MockSocket, so the timer throws
// `TypeError: socket.destroySoon is not a function` ~500ms later. It surfaces
// as an *uncaught exception* that vitest reports as an unhandled error and
// fails the whole run — even when every assertion passed (it is timing-
// dependent, so it shows up flakily in CI but not always locally). Real Node
// sockets already implement `destroySoon`, so this gap is purely a
// test-harness artifact with no production impact.
//
// Fix: grab the MockSocket prototype from a throwaway injected request and add
// a no-op `destroySoon` (mirroring a real socket: mark destroyed + emit close)
// so the drain timer completes harmlessly. The class is internal to
// light-my-request (not exported, and not hoisted under pnpm), so reaching it
// via a live request is the most robust route.
import Fastify from 'fastify';

interface MockSocketLike {
  destroyed?: boolean;
  emit?: (event: string) => void;
}

const probe = Fastify();
probe.get('/__mock_socket_probe', async () => 'ok');
const res = await probe.inject({ method: 'GET', url: '/__mock_socket_probe' });
const socket = (res.raw.req as { socket?: MockSocketLike }).socket;
if (socket !== undefined) {
  const proto = Object.getPrototypeOf(socket) as Record<string, unknown>;
  if (typeof proto['destroySoon'] !== 'function') {
    proto['destroySoon'] = function destroySoon(this: MockSocketLike): void {
      this.destroyed = true;
      this.emit?.('close');
    };
  }
}
await probe.close();
