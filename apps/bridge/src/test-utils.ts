import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/index.ts';
import type { GitLabClient } from './gitlab/client.ts';
import { MockGitLabClient } from './gitlab/mock-client.ts';
import { SecretStore } from './secrets.ts';
import { CliRunner } from './agents/cli-runner.ts';
import type { AgentRunner } from './agents/runner.ts';
import { buildServer } from './server.ts';
import type { Summarizer } from './context/summarize.ts';
import { Session } from './session.ts';
import { SettingsService } from './settings.ts';

export const TEST_PORT = 4999;

/** Monta um bridge completo em memória, com o GitLab trocado pelo mock. */
export async function makeBridge(
  makeClient: (url: string, token: string) => GitLabClient = () => new MockGitLabClient(),
  runner: AgentRunner = new CliRunner(),
  port = TEST_PORT,
  opts: { summarizer?: Summarizer; contextDebounceMs?: number } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'agent-canvas-test-'));
  const { db, sqlite, close } = openDb(':memory:');
  const session = new Session();
  const secrets = new SecretStore(home, {});
  const settings = new SettingsService(db, secrets, makeClient);
  const app = await buildServer({
    config: { port, allowedOrigins: ['http://localhost:5173'], webDist: null },
    db,
    session,
    settings,
    runner,
    home,
    contextDebounceMs: opts.contextDebounceMs ?? 0,
    summarizer: opts.summarizer ?? {
      summarize: async () => {
        throw new Error('resumo não configurado neste teste');
      },
    },
  });
  const headers = { host: `127.0.0.1:${port}`, 'x-agent-canvas-token': session.token };
  return {
    app,
    db,
    sqlite,
    home,
    session,
    secrets,
    settings,
    headers,
    async cleanup() {
      await app.close();
      close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
