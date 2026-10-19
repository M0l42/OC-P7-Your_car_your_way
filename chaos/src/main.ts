// Placeholder entrypoint so `npm --prefix chaos run chaos` (chaos.yml, Makefile) is wired end to end.
// Frontend replaces this with the real chaos client (T3/O5/O10/F11).
// Contract with the infra side:
//   env BASE_URL            nginx entrypoint (default http://localhost:8080)
//   env COMPOSE_FILE        compose file used for kill/start (default infra/docker-compose.yml)
//   env COMPOSE_PROJECT_NAME compose project of the stack under test
//   env CHAOS_VARIANT       "default" | "region" (O10: chat-2 DB through toxiproxy +80 ms)
//   flag --gate-latency     also gate steady-phase p95 < 300 ms (O5)
//   env GITHUB_STEP_SUMMARY when set, append the markdown report to it
import { appendFileSync } from 'node:fs';

const message = 'Chaos client not implemented yet (scaffold placeholder).';
console.warn(message);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Chaos run\n\n> ${message}\n`);
}
