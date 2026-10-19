// docker compose driver for the stack under test (env contract: COMPOSE_FILE, COMPOSE_PROJECT_NAME).

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const repoRoot = resolve(import.meta.dirname, '../..');
const composeFile = process.env['COMPOSE_FILE'] ?? resolve(repoRoot, 'infra/docker-compose.yml');

async function compose(...args: string[]): Promise<string> {
  const { stdout } = await run('docker', ['compose', '-f', composeFile, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** SIGKILL, like a crashed task. */
export async function kill(service: string): Promise<void> {
  await compose('kill', service);
}

/** `start` (not `up`): the container keeps its config, e.g. chat-2 routed through toxiproxy. */
export async function start(service: string): Promise<void> {
  await compose('start', service);
}

export async function health(service: string): Promise<string> {
  const out = await compose('ps', '--all', '--format', 'json', service);
  for (const line of out.split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as { Service?: string; Health?: string; State?: string };
    if (row.Service === service) return row.Health || row.State || 'unknown';
  }
  return 'missing';
}

export async function waitHealthy(service: string, timeoutMs = 120_000): Promise<number> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if ((await health(service)) === 'healthy') return performance.now() - t0;
    await sleep(500);
  }
  throw new Error(`${service} not healthy after ${timeoutMs} ms`);
}

export async function psql(sql: string): Promise<string[][]> {
  const out = await compose('exec', '-T', 'postgres', 'psql', '-U', 'chat', '-d', 'chat', '-At', '-F', '\t', '-c', sql);
  return out
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t'));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
