import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Agent, AgentEvent, ServerMessage } from '@agent-canvas/shared';
import { makeBridge } from '../test-utils.ts';
import type { SupervisorLimits } from './supervisor.ts';
import type { AgentProcess, AgentRunner, RunnerHandlers, RunnerStartOptions } from './runner.ts';

const TEST_PORT = 4978;
const line = (o: unknown) => JSON.stringify(o);
const result = (sid: string, tokens: number, subtype = 'success') =>
  line({
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    result: 'ok',
    session_id: sid,
    usage: { input_tokens: tokens, output_tokens: 0 },
  });

/** Runner falso: `finish` decide se o turno termina sozinho; interromper encerra o turno. */
class Runner implements AgentRunner {
  starts = 0;
  constructor(private readonly finish: (n: number) => number | null) {}
  start(opts: RunnerStartOptions, h: RunnerHandlers): AgentProcess {
    const n = ++this.starts;
    let alive = true;
    const exit = () => {
      if (alive) {
        alive = false;
        setTimeout(() => h.onExit({ code: 0, signal: null, stderr: '' }), 5);
      }
    };
    return {
      send: () => {
        h.onLine(
          line({ type: 'system', subtype: 'init', session_id: opts.sessionId, model: 'f', cwd: '/w' }),
        );
        const tokens = this.finish(n);
        if (tokens !== null) h.onLine(result(opts.sessionId, tokens));
      },
      interrupt: () => h.onLine(result(opts.sessionId, 1, 'error_during_execution')),
      endInput: exit,
      kill: exit,
    };
  }
}

describe('limites do supervisor', () => {
  let b: Awaited<ReturnType<typeof makeBridge>> | null = null;
  let ws: WebSocket;
  let msgs: ServerMessage[] = [];
  afterEach(async () => {
    ws?.terminate();
    await new Promise((r) => setTimeout(r, 50));
    await b?.cleanup();
    b = null;
  });
  const send = (m: object) => ws.send(JSON.stringify(m));
  async function until<T>(fn: () => T | undefined | false, what: string): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`esperando ${what}`);
  }
  const agent = (id: string) =>
    msgs.flatMap((m) => (m.type === 'agent.upsert' && m.agent.id === id ? [m.agent] : [])).at(-1) as
      Agent | undefined;
  const events = (id: string) =>
    msgs.flatMap((m) =>
      m.type === 'agent.event' && m.event.agentId === id ? [m.event] : [],
    ) as AgentEvent[];

  async function boot(runner: AgentRunner, limits: Partial<SupervisorLimits>) {
    b = await makeBridge(undefined, runner, TEST_PORT, { limits });
    const reposDir = mkdtempSync(join(tmpdir(), 'ac-limits-'));
    const repo = join(reposDir, 'payments-api');
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# payments-api\n');
    git('add', '.');
    git('-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'inicial');
    const h = b.headers;
    await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: h,
      payload: { mode: 'demo', reposDir },
    });
    await b.app.inject({
      method: 'PUT',
      url: '/api/settings/projects',
      headers: h,
      payload: { projectIds: [101] },
    });
    await b.app.listen({ host: '127.0.0.1', port: TEST_PORT });
    msgs = [];
    ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws?token=${b.session.token}`, {
      origin: 'http://localhost:5173',
    });
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
  }
  const create = (id: string) =>
    send({
      type: 'agent.create',
      agentId: id,
      nodeId: `n-${id}`,
      repos: [101],
      instruction: 'Faça.',
      x: 0,
      y: 0,
    });

  it('tempo máximo: o agente que passa do limite é pausado com o motivo', async () => {
    await boot(new Runner(() => null), { maxAgentMinutes: 0.003 });
    create('a1');
    await until(() => agent('a1')?.status === 'paused', 'pausa pelo tempo');
    expect(events('a1').some((e) => e.body.kind === 'error' && e.body.message.includes('tempo máximo'))).toBe(
      true,
    );
  });

  it('orçamento da árvore: depois de passar dos tokens, o agente não começa outro turno', async () => {
    const runner = new Runner(() => 500);
    await boot(runner, { treeTokenBudget: 300 });
    create('a1');
    await until(() => agent('a1')?.status === 'done', 'primeiro turno');
    expect(agent('a1')!.inputTokens).toBe(500);
    send({ type: 'agent.message', agentId: 'a1', text: 'Continue.' });
    await until(() => agent('a1')?.status === 'error', 'recusa pelo orçamento');
    expect(agent('a1')!.error).toContain('orçamento');
    expect(runner.starts).toBe(1);
  });

  it('fila: além do máximo, os agentes esperam e começam quando outro termina', async () => {
    const runner = new Runner((n) => (n === 1 ? null : 10));
    await boot(runner, { maxRunning: 1 });
    create('a1');
    await until(() => agent('a1')?.status === 'running', 'primeiro rodando');
    create('a2');
    await until(() => agent('a2')?.status === 'queued', 'segundo na fila');
    await until(() => runner.starts === 1, 'primeiro processo');
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.starts).toBe(1);
    send({ type: 'agent.stop', agentId: 'a1' });
    await until(() => agent('a2')?.status === 'done', 'segundo terminou depois da vaga');
    expect(runner.starts).toBe(2);
  });

  it('limites e modelo ajustados na tela valem na hora, e null volta ao padrão', async () => {
    const runner = new Runner((n) => (n === 1 ? null : 10));
    await boot(runner, { maxRunning: 4 });
    const put = async (payload: object) =>
      (
        await b!.app.inject({ method: 'PUT', url: '/api/settings/agents', headers: b!.headers, payload })
      ).json() as {
        agents: { maxRunning: number; model: string | null };
        agentDefaults: { maxRunning: number };
      };
    const view = await put({ maxRunning: 1, model: 'haiku' });
    expect(view.agents).toMatchObject({ maxRunning: 1, model: 'haiku' });
    expect(view.agentDefaults.maxRunning).toBe(4);
    expect(
      (
        await b!.app.inject({
          method: 'PUT',
          url: '/api/settings/agents',
          headers: b!.headers,
          payload: { maxRunning: 0 },
        })
      ).statusCode,
    ).toBe(400);

    create('a1');
    await until(() => agent('a1')?.status === 'running', 'primeiro rodando');
    create('a2');
    await until(() => agent('a2')?.status === 'queued', 'segundo na fila pelo limite da tela');
    expect((await put({ maxRunning: null })).agents.maxRunning).toBe(4);
  });
});
