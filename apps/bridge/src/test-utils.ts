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
import type { Namer } from './agents/namer.ts';
import type { SupervisorLimits } from './agents/supervisor.ts';
import { Session } from './session.ts';
import { SettingsService } from './settings.ts';

export const TEST_PORT = 4999;

/** Monta um bridge completo em memória, com o GitLab trocado pelo mock. */
export async function makeBridge(
  makeClient: (url: string, token: string) => GitLabClient = () => new MockGitLabClient(),
  runner: AgentRunner = new CliRunner(),
  port = TEST_PORT,
  opts: {
    summarizer?: Summarizer;
    namer?: Namer;
    contextDebounceMs?: number;
    limits?: Partial<SupervisorLimits>;
    /** Pasta de dados e banco em arquivo, para simular um reinício do bridge (a pasta fica). */
    home?: string;
    autoResume?: boolean;
    autoMode?: boolean;
  } = {},
) {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'agent-canvas-test-'));
  const { db, sqlite, close } = openDb(opts.home ? join(home, 'agent-canvas.db') : ':memory:');
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
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.autoResume !== undefined ? { autoResume: opts.autoResume } : {}),
    ...(opts.namer ? { namer: opts.namer } : {}),
    // os testes de permissão esperam pedidos pendentes: agentes novos começam pedindo
    autoMode: opts.autoMode ?? false,
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
      if (!opts.home) rmSync(home, { recursive: true, force: true });
    },
  };
}
