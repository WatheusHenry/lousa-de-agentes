import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { GitbeakerClient } from './gitlab/gitbeaker-client.ts';
import { SecretStore } from './secrets.ts';
import { CliRunner } from './agents/cli-runner.ts';
import { buildServer } from './server.ts';
import { CliSummarizer } from './context/summarize.ts';
import { Session } from './session.ts';
import { SettingsService } from './settings.ts';

// .env local opcional na raiz do repositório (ex.: AGENT_CANVAS_GITLAB_TOKEN)
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const { db, close } = openDb(join(config.home, 'agent-canvas.db'));
const session = Session.load(config.home);
const settings = new SettingsService(
  db,
  new SecretStore(config.home),
  (url, token) => new GitbeakerClient(url, token),
);
const app = await buildServer({
  config,
  db,
  session,
  settings,
  runner: new CliRunner(),
  pollMrsEveryMs: 30_000,
  pollIssuesEveryMs: 60_000,
  limits: {
    ...(Number(process.env.AGENT_CANVAS_MAX_AGENTS) > 0
      ? { maxRunning: Number(process.env.AGENT_CANVAS_MAX_AGENTS) }
      : {}),
    ...(Number(process.env.AGENT_CANVAS_MAX_AGENT_MINUTES) > 0
      ? { maxAgentMinutes: Number(process.env.AGENT_CANVAS_MAX_AGENT_MINUTES) }
      : {}),
    ...(Number(process.env.AGENT_CANVAS_TREE_TOKEN_BUDGET) > 0
      ? { treeTokenBudget: Number(process.env.AGENT_CANVAS_TREE_TOKEN_BUDGET) }
      : {}),
  },
  summarizer: new CliSummarizer(process.env.AGENT_CANVAS_SUMMARY_MODEL || 'haiku'),
  ...(Number(process.env.AGENT_CANVAS_CONTEXT_BUDGET) > 0
    ? { contextBudget: Number(process.env.AGENT_CANVAS_CONTEXT_BUDGET) }
    : {}),
  home: config.home,
  autoResume: process.env.AGENT_CANVAS_AUTO_RESUME !== '0',
  autoMode: process.env.AGENT_CANVAS_AUTO_MODE !== '0',
  ...(process.env.AGENT_CANVAS_MODEL ? { model: process.env.AGENT_CANVAS_MODEL } : {}),
  logger: true,
});

await app.listen({ host: config.host, port: config.port });
session.publish(config.home, config.port);

const url = config.webDist
  ? `http://127.0.0.1:${config.port}`
  : `http://127.0.0.1:${process.env.AGENT_CANVAS_WEB_PORT || 5173}`;
console.log(`\n  Agent Canvas bridge em http://${config.host}:${config.port}`);
console.log(`  Dados em ${config.home}`);
console.log(`  Abra ${url}\n`);
if (process.argv.includes('--serve-web') && !config.webDist)
  console.log('  Front-end não encontrado em apps/web/dist: rode `pnpm build` antes de `pnpm start`.\n');

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
