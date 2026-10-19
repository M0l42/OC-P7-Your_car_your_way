// Chaos client (T10, F11): proves "kill an instance, zero messages lost" against the compose stack,
// with the same TS reliability core as chat-web (D21/O2).
//
// Contract with the infra side (Makefile, chaos.yml):
//   env BASE_URL             nginx entrypoint (default http://localhost:8080)
//   env COMPOSE_FILE         compose file used for kill/start (default infra/docker-compose.yml)
//   env COMPOSE_PROJECT_NAME compose project of the stack under test (read by docker compose)
//   env CHAOS_VARIANT        "default" | "region" (O10: chat-2 DB through toxiproxy +80 ms)
//   flag --gate-latency      also gate steady-phase p95 < 300 ms (O5)
//   env GITHUB_STEP_SUMMARY  when set, append the markdown report to it
// Tuning (local runs only; below the spec minimums the run fails its size checks):
//   CHAOS_STEADY_SECONDS (60), CHAOS_MESSAGES (1000), CHAOS_KILLS (4), CHAOS_CONVERSATIONS (5)
//
// Phases:
//   1. setup     one agent (first connection /ws-b → chat-2), N customers (/ws-a → chat-1), each
//                opens a conversation the agent claims; two more stay unclaimed (queue check)
//   2. steady    60 s, no kills, customer → agent every 100 ms; latency = agent receive − customer
//                send on performance.now() of this one process (T3); gated only with --gate-latency
//   3. kills     default variant: ≥1,000 messages both ways while chat-1/chat-2 are killed/started
//                alternately ≥3 times; each kill waits until the other instance is healthy, and the
//                restarted one must answer /actuator/info through nginx again (O3)
//   4. settle    wait until every message is acked and every client caught up with the DB
//   5. checks    received == sent, ≥1 ack per clientMessageId with one seq, strictly increasing
//                gap-free seq, no duplicates, no send errors, DB counts, agent queue == DB (O5)

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { newUuid, type Conversation } from '../../chat-web/src/app/core/reliability/index.ts';
import { checkAcks, checkConversation, checkQueue, latencyStats, type CheckResult, type ConversationRecord } from './checks.ts';
import { kill, psql, repoRoot, sleep, start, waitHealthy } from './compose.ts';
import { Participant } from './participant.ts';

const baseUrl = (process.env['BASE_URL'] ?? 'http://localhost:8080').replace(/\/$/, '');
const variant = process.env['CHAOS_VARIANT'] === 'region' ? 'region' : 'default';
const gateLatency = process.argv.includes('--gate-latency') && variant === 'default';
const steadyMs = Number(process.env['CHAOS_STEADY_SECONDS'] ?? 60) * 1000;
const minMessages = Number(process.env['CHAOS_MESSAGES'] ?? 1000);
const killCount = Number(process.env['CHAOS_KILLS'] ?? 4);
const nConversations = Number(process.env['CHAOS_CONVERSATIONS'] ?? 5);
const SPEC = { messages: 1000, kills: 3, steadyMs: 60_000, steadySamples: 300, p95: 300 };

const t0 = performance.now();
const at = () => ((performance.now() - t0) / 1000).toFixed(1);
const log = (msg: string) => console.log(`[${at()}s] ${msg}`);

interface Sent {
  conversationId: number;
  by: Participant;
  at: number;
  phase: 'steady' | 'kills';
}

interface KillRecord {
  service: string;
  killedAt: string;
  healthyAfterMs: number;
  routedAfterMs: number;
}

async function main(): Promise<number> {
  log(`chaos run: variant=${variant} base=${baseUrl} gateLatency=${gateLatency}`);
  await waitReady();

  // ---- 1. setup ------------------------------------------------------------------------------
  const agent = new Participant('agent', 'agent', baseUrl, '/ws-b');
  agent.client.watchQueue();
  agent.client.start();
  const customers: { p: Participant; conv: Conversation }[] = [];
  for (let i = 0; i < nConversations; i++) {
    const p = new Participant(`customer-${i + 1}`, 'customer', baseUrl, '/ws-a');
    const conv = await p.api.openConversation(newUuid(), `CHAOS-${i + 1}`);
    p.client.watchConversation(conv.id);
    p.client.start();
    await agent.api.claim(conv.id);
    agent.client.watchConversation(conv.id);
    customers.push({ p, conv });
  }
  const queueCustomer = new Participant('queue-customer', 'customer', baseUrl, '/ws');
  const unclaimed: Conversation[] = [];
  for (let i = 0; i < 2; i++) unclaimed.push(await queueCustomer.api.openConversation(newUuid(), null));
  const all = [agent, ...customers.map((c) => c.p)];
  await waitUntil('all clients ready', () => all.every((p) => p.client.state === 'ready'), 30_000);
  log(`setup: ${customers.length} claimed conversations, agent on ${agent.client.instanceId}, customers on ${[...new Set(customers.map((c) => c.p.client.instanceId))].join(',')}`);

  const sent = new Map<string, Sent>();
  const send = (by: Participant, conversationId: number, phase: Sent['phase'], n: number) => {
    const id = by.send(conversationId, `chaos ${phase} #${n} from ${by.name}`);
    sent.set(id, { conversationId, by, at: performance.now(), phase });
  };

  // ---- 2. steady phase (T3) ------------------------------------------------------------------
  log(`steady phase: ${steadyMs / 1000} s, customer → agent every 100 ms, no kills`);
  const steadyStart = performance.now();
  let n = 0;
  while (performance.now() - steadyStart < steadyMs) {
    const c = customers[n % customers.length];
    send(c.p, c.conv.id, 'steady', ++n);
    await sleep(100);
  }
  const steadySent = n;
  const steadyCross = customers.every((c) => c.p.client.instanceId !== agent.client.instanceId);
  log(`steady phase done: ${steadySent} messages`);

  // ---- 3. kill phase -------------------------------------------------------------------------
  const kills: KillRecord[] = [];
  let killSent = 0;
  let killPhaseMs = 0;
  if (variant === 'default') {
    log(`kill phase: ≥${minMessages} messages, ${killCount} alternating kills`);
    let killing = true;
    const killStart = performance.now();
    const killer = (async () => {
      try {
        for (let i = 0; i < killCount; i++) {
          const target = i % 2 === 0 ? 'chat-1' : 'chat-2';
          const other = target === 'chat-1' ? 'chat-2' : 'chat-1';
          await waitHealthy(other); // never kill both: the other one must be ready first
          await sleep(3000);
          const killedAt = at();
          log(`docker compose kill ${target}`);
          await kill(target);
          if (i === 0) {
            // queue churn while clients reconnect: one more waiting conversation, one closed by its customer
            unclaimed.push(await queueCustomer.api.openConversation(newUuid(), null));
            await queueCustomer.api.close(unclaimed[0].id);
          }
          await sleep(3000);
          const s0 = performance.now();
          await start(target);
          await waitHealthy(target);
          const healthyAfterMs = performance.now() - s0;
          await waitRoutedTo(target);
          const routedAfterMs = performance.now() - s0;
          log(`${target} healthy ${Math.round(healthyAfterMs)} ms after start, served through nginx after ${Math.round(routedAfterMs)} ms`);
          kills.push({ service: target, killedAt, healthyAfterMs, routedAfterMs });
        }
      } finally {
        killing = false;
      }
    })();
    let i = 0;
    while (killing || killSent < minMessages) {
      const c = customers[i % customers.length];
      if (i % 2 === 0) send(c.p, c.conv.id, 'kills', ++i);
      else send(agent, c.conv.id, 'kills', ++i);
      killSent++;
      await sleep(40);
    }
    await killer;
    killPhaseMs = performance.now() - killStart;
    log(`kill phase done: ${killSent} messages, ${kills.length} kills`);
  }

  // ---- 4. settle -----------------------------------------------------------------------------
  const ids = customers.map((c) => c.conv.id);
  const dbLast = async () =>
    new Map((await psql(`SELECT id, last_seq FROM conversation WHERE id IN (${ids.join(',')})`)).map(([id, s]) => [Number(id), Number(s)]));
  let settled = false;
  const settleStart = performance.now();
  while (performance.now() - settleStart < 120_000) {
    const last = await dbLast();
    const caughtUp = customers.every((c) => c.p.lastSeq(c.conv.id) === last.get(c.conv.id) && agent.lastSeq(c.conv.id) === last.get(c.conv.id));
    const acked = [...sent.keys()].every((id) => sent.get(id)!.by.acks.has(id));
    if (caughtUp && acked && all.every((p) => p.client.state === 'ready')) {
      settled = true;
      break;
    }
    await sleep(500);
  }
  await sleep(3000); // > 2 s safety net, lets the last queue refetch land
  log(`settle: ${settled ? 'caught up' : 'TIMEOUT'} after ${Math.round(performance.now() - settleStart)} ms`);

  // ---- 5. checks -----------------------------------------------------------------------------
  const checks: CheckResult[] = [];
  checks.push({ name: 'settled (all acked, all clients caught up with the DB)', ok: settled, detail: settled ? 'ok' : 'timeout after 120 s' });

  const streamSeq = new Map<string, number>();
  for (const c of customers) {
    const record: ConversationRecord = {
      conversationId: c.conv.id,
      sent: new Set([...sent].filter(([, s]) => s.conversationId === c.conv.id).map(([id]) => id)),
      received: new Map([
        [c.p.name, c.p.received.get(c.conv.id) ?? []],
        ['agent', agent.received.get(c.conv.id) ?? []],
      ]),
    };
    for (const it of record.received.get('agent')!) streamSeq.set(it.clientMessageId, it.seq);
    checks.push(...checkConversation(record));
  }
  const allAcks = new Map<string, number[]>();
  for (const [id, s] of sent) allAcks.set(id, s.by.acks.get(id) ?? []);
  checks.push(checkAcks(sent.keys(), allAcks, streamSeq));

  const failures = [...all, queueCustomer].flatMap((p) => p.failures.map((f) => `${p.name}: ${f}`));
  checks.push({ name: 'no send error / server error / refused subscription', ok: failures.length === 0, detail: failures.length ? failures.slice(0, 5).join('; ') : 'none' });

  const dbCounts = new Map(
    (await psql(`SELECT conversation_id, count(*) FILTER (WHERE type = 'texte'), max(seq) FROM message WHERE conversation_id IN (${ids.join(',')}) GROUP BY 1`)).map(
      ([id, texts, max]) => [Number(id), { texts: Number(texts), max: Number(max) }],
    ),
  );
  const dbMismatch = customers.filter((c) => {
    const db = dbCounts.get(c.conv.id);
    const expected = [...sent.values()].filter((s) => s.conversationId === c.conv.id).length;
    return !db || db.texts !== expected || db.max !== agent.lastSeq(c.conv.id);
  });
  checks.push({
    name: 'DB: one row per sent message, last seq == clients',
    ok: dbMismatch.length === 0,
    detail: dbMismatch.length ? `mismatch in ${dbMismatch.map((c) => c.conv.id).join(',')}` : `${sent.size} rows in ${ids.length} conversations`,
  });

  const dbQueue = await psql(`SELECT id FROM conversation WHERE status = 'en_attente' ORDER BY created_at, id LIMIT 50`);
  const dbTotal = Number((await psql(`SELECT count(*) FROM conversation WHERE status = 'en_attente'`))[0][0]);
  const snap = agent.client.queueSnapshot();
  checks.push(checkQueue({ ids: snap.items.map((c) => c.id), total: snap.total }, { ids: dbQueue.map(([id]) => Number(id)), total: dbTotal }));

  if (variant === 'default') {
    checks.push({ name: `kill phase: ≥${SPEC.messages} messages`, ok: killSent >= SPEC.messages, detail: `${killSent}` });
    checks.push({ name: `kill phase: ≥${SPEC.kills} kill/start`, ok: kills.length >= SPEC.kills, detail: kills.map((k) => k.service).join(' → ') });
  }
  checks.push({ name: 'steady phase: cross-instance (customers ≠ agent instance)', ok: steadyCross || variant === 'region', detail: steadyCross ? 'yes' : 'no' });

  const lat = (phase: Sent['phase']) =>
    latencyStats(
      [...sent]
        .filter(([, s]) => s.phase === phase && s.by !== agent)
        .map(([id, s]) => (agent.receivedAt.get(id) ?? NaN) - s.at)
        .filter((x) => Number.isFinite(x)),
    );
  const steady = lat('steady');
  const killLat = lat('kills');
  checks.push({ name: `steady phase: ≥${SPEC.steadySamples} cross-instance samples`, ok: steady.n >= SPEC.steadySamples, detail: `${steady.n}` });
  if (gateLatency) checks.push({ name: `steady p95 < ${SPEC.p95} ms (--gate-latency)`, ok: steady.p95 < SPEC.p95, detail: `${steady.p95.toFixed(1)} ms` });

  // ---- report --------------------------------------------------------------------------------
  const ok = checks.every((c) => c.ok);
  const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
  const reconnects = all.map((p) => `${p.name}: ${p.instances.join(' → ')}`).join('<br>');
  const md = [
    `## Chaos run — ${variant}${variant === 'region' ? ' (chat-2 DB +latency via toxiproxy, O10)' : ''}: ${ok ? '✅ PASS' : '❌ FAIL'}`,
    '',
    `| Messages | Steady | Kill phase | Total | Kills | Conversations |`,
    `|---|---|---|---|---|---|`,
    `| sent | ${steadySent} | ${killSent} | ${sent.size} | ${kills.length} | ${ids.length} claimed + ${unclaimed.length} queue |`,
    '',
    `| Cross-instance latency (ms, one process clock) | n | p50 | p95 | max | gated |`,
    `|---|---|---|---|---|---|`,
    `| steady phase (60 s, no kills) | ${steady.n} | ${fmt(steady.p50)} | ${fmt(steady.p95)} | ${fmt(steady.max)} | ${gateLatency ? `p95 < ${SPEC.p95}` : 'reported only'} |`,
    ...(variant === 'default' ? [`| kill phase | ${killLat.n} | ${fmt(killLat.p50)} | ${fmt(killLat.p95)} | ${fmt(killLat.max)} | reported only |`] : []),
    '',
    ...(killPhaseMs ? [`Throughput kill phase: ${(killSent / (killPhaseMs / 1000)).toFixed(1)} msg/s.`, ''] : []),
    ...(kills.length
      ? ['| Kill | at (s) | healthy after start (ms) | served by nginx after start (ms) |', '|---|---|---|---|', ...kills.map((k) => `| ${k.service} | ${k.killedAt} | ${Math.round(k.healthyAfterMs)} | ${Math.round(k.routedAfterMs)} |`), '']
      : []),
    '| Check | Result | Detail |',
    '|---|---|---|',
    ...checks.map((c) => `| ${c.name} | ${c.ok ? '✅' : '❌'} | ${c.detail} |`),
    '',
    `<details><summary>Instance per connection</summary>${reconnects}</details>`,
    '',
  ].join('\n');
  console.log(`\n${md}`);
  if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], md);
  const outDir = resolve(repoRoot, 'chaos/results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, `chaos-${variant}.md`), md);
  writeFileSync(
    resolve(outDir, `chaos-${variant}.json`),
    JSON.stringify({ variant, ok, steadySent, killSent, total: sent.size, kills, latency: { steady, kills: killLat }, checks }, null, 2),
  );

  for (const p of [...all, queueCustomer]) p.client.stop();
  return ok ? 0 : 1;
}

async function waitReady(): Promise<void> {
  await waitUntil(
    'stack readiness through nginx',
    async () => {
      try {
        return (await fetch(`${baseUrl}/actuator/health/readiness`)).ok;
      } catch {
        return false;
      }
    },
    120_000,
  );
}

/** O3: after a restart, nginx must route to the new container again (re-resolved IP). */
async function waitRoutedTo(service: string, timeoutMs = 30_000): Promise<number> {
  const s0 = performance.now();
  while (performance.now() - s0 < timeoutMs) {
    try {
      const info = (await (await fetch(`${baseUrl}/actuator/info`)).json()) as Record<string, unknown>;
      if (info['instance-id'] === service) return performance.now() - s0;
    } catch {
      // instance not reachable yet
    }
    await sleep(200);
  }
  throw new Error(`${service} never served /actuator/info through nginx within ${timeoutMs} ms (O3)`);
}

async function waitUntil(what: string, cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const s0 = performance.now();
  while (!(await cond())) {
    if (performance.now() - s0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(200);
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    const msg = `Chaos run aborted: ${e instanceof Error ? e.stack ?? e.message : String(e)}`;
    console.error(msg);
    if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], `## Chaos run — ${variant}: ❌ ABORTED\n\n\`\`\`\n${msg}\n\`\`\`\n`);
    process.exit(2);
  },
);
