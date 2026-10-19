import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { expect, test } from '@playwright/test';

// Infra regression checks on nginx (C5, O3, A7):
// - WebSocket handshakes on /ws, /ws-a, /ws-b reach Spring with a valid Host (400 = Host/header
//   loss in nginx, e.g. a location-level proxy_set_header dropping the server-level ones).
// - /ws-a and /ws-b are pinned to chat-1 and chat-2.
// Needs the compose stack (make up) and the docker CLI; COMPOSE_FILE / COMPOSE_PROJECT_NAME come
// from the Makefile.

const baseURL = new URL(process.env.BASE_URL ?? 'http://localhost:8080');

function handshake(path: string): Promise<{ status: number; upstream?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: baseURL.hostname,
      port: baseURL.port || 80,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        Origin: baseURL.origin,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, upstream: res.headers['x-upstream-addr'] as string });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, upstream: res.headers['x-upstream-addr'] as string });
    });
    req.on('error', reject);
    req.end();
  });
}

function containerIp(service: string): string {
  const args = ['compose'];
  if (process.env.COMPOSE_FILE) args.push('-f', process.env.COMPOSE_FILE);
  args.push('exec', '-T', service, 'hostname', '-i');
  return execFileSync('docker', args, { encoding: 'utf8' }).trim().split(/\s+/)[0];
}

for (const path of ['/ws', '/ws-a', '/ws-b']) {
  test(`${path} upgrade reaches a chat instance with valid headers`, async () => {
    const { status } = await handshake(path);
    expect(status, `unexpected status ${status} on ${path}`).not.toBe(400);
    expect(status).toBeLessThan(500);
  });
}

test('/ws-a is pinned to chat-1 and /ws-b to chat-2', async () => {
  const [a, b] = [await handshake('/ws-a'), await handshake('/ws-b')];
  expect(a.upstream).toBe(`${containerIp('chat-1')}:8080`);
  expect(b.upstream).toBe(`${containerIp('chat-2')}:8080`);
});
