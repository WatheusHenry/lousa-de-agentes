import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Agent, Approval, ServerMessage, StateSnapshot } from '@agent-canvas/shared';
import { Session } from '../session.ts';
import { makeBridge } from '../test-utils.ts';
import type { AgentProcess, AgentRunner, RunnerHandlers, RunnerStartOptions } from './runner.ts';

/** Cada subida numa porta: o fetch do teste guarda conexões abertas com o bridge anterior. */
let port = 4980;

/** Runner falso: cada mensagem roda o roteiro do teste; kill() faz o processo sair. */
class FakeRunner implements AgentRunner {
  starts: RunnerStartOptions[] = [];
  sent: string[] = [];
  turn: (opts: RunnerStartOptions, h: RunnerHandlers, text: string) => Promise<void> = async () => {};
  start(opts: RunnerStartOptions, h: RunnerHandlers): AgentProcess {
    this.starts.push(opts);
    let alive = true;
    const exit = (code: number | null) => {
      if (alive) {
        alive = false;
        setTimeout(() => h.onExit({ code, signal: null, stderr: '' }), 5);
      }
    };
    return {
      send: (text) => {
        this.sent.push(text);
        void this.turn(opts, h, text).catch(() => {});
      },
      interrupt: () => {},
      endInput: () => exit(0),
      kill: () => exit(null),
    };
  }
}

async function callApprove(opts: RunnerStartOptions, toolName: string, input: Record<string, unknown>) {
  const srv = JSON.parse(readFileSync(opts.mcpConfigPath, 'utf8')).mcpServers.canvas;
  const client = new Client({ name: 'fake-claude', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(srv.url), {
    requestInit: { headers: srv.headers },
  });
  transport.onerror = () => {};
  client.onerror = () => {};
  await client.connect(transport);
  const res = await client.callTool({ name: 'approve', arguments: { tool_name: toolName, input } });
  await client.close().catch(() => {});
  return JSON.parse((res.content as { text: string }[])[0]!.text) as { behavior: string };
}

const line = (o: unknown) => JSON.stringify(o);
const init = (sid: string) =>
  line({ type: 'system', subtype: 'init', session_id: sid, model: 'fake', cwd: '/w' });
const text = (t: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const result = (sid: string) =>
  line({ type: 'result', subtype: 'success', is_error: false, result: 'feito', session_id: sid, usage: {} });

describe('reinício do bridge', { timeout: 20_000 }, () => {
  let home: string;
  let reposDir: string;
  let b: Awaited<ReturnType<typeof makeBridge>> | null = null;
  let ws: WebSocket | null = null;
  let msgs: ServerMessage[] = [];

  async function until<T>(
    fn: () => T | undefined | false | Promise<T | undefined | false>,
    what: string,
  ): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`esperando ${what}; mensagens: ${msgs.map((m) => m.type).join(', ')}`);
  }
  const agentState = (id: string) =>
    msgs
      .filter((m): m is Extract<ServerMessage, { type: 'agent.upsert' }> => m.type === 'agent.upsert')
      .filter((m) => m.agent.id === id)
      .at(-1)?.agent as Agent | undefined;
  const approvals = () =>
    msgs.flatMap((m) => (m.type === 'approval.upsert' ? [m.approval] : [])) as Approval[];
  const send = (m: object) => ws!.send(JSON.stringify(m));
  /** Estado pelo HTTP: a retomada pode acontecer antes de o WebSocket do teste conectar. */
  const live = async () =>
    (await b!.app.inject({ url: '/api/state', headers: b!.headers })).json() as StateSnapshot;
  const liveAgent = async (id: string) => (await live()).agents.find((a) => a.id === id);

  /** Sobe um bridge na mesma pasta de dados, como o `pnpm dev` depois de cair. */
  async function boot(runner: AgentRunner, opts: { autoResume?: boolean; configure?: boolean } = {}) {
    port++;
    b = await makeBridge(undefined, runner, port, {
      home,
      ...(opts.autoResume !== undefined ? { autoResume: opts.autoResume } : {}),
    });
    if (opts.configure) {
      await b.app.inject({
        method: 'POST',
        url: '/api/settings/gitlab',
        headers: b.headers,
        payload: { mode: 'demo', reposDir },
      });
      await b.app.inject({
        method: 'PUT',
        url: '/api/settings/projects',
        headers: b.headers,
        payload: { projectIds: [101] },
      });
      await b.app.inject({ url: '/api/gitlab/issues', headers: b.headers });
    }
    const before = (await b.app.inject({ url: '/api/state', headers: b.headers })).json() as StateSnapshot;
    msgs = [];
    await b.app.listen({ host: '127.0.0.1', port });
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${b.session.token}`, {
      origin: 'http://localhost:5173',
    });
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws!.once('open', r));
    return before;
  }
  async function crash() {
    ws?.terminate();
    await new Promise((r) => setTimeout(r, 50));
    await b!.cleanup();
    b = null;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ac-restart-'));
    reposDir = mkdtempSync(join(tmpdir(), 'ac-restart-repos-'));
    const repo = join(reposDir, 'payments-api');
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# payments-api\n');
    git('add', '.');
    git('-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'inicial');
  });
  afterEach(async () => {
    if (b) await crash();
    rmSync(home, { recursive: true, force: true });
    rmSync(reposDir, { recursive: true, force: true });
  });

  /** Primeira execução: agente pede permissão e o bridge cai antes da resposta. */
  async function firstRun() {
    const r1 = new FakeRunner();
    r1.turn = async (opts, h) => {
      h.onLine(init(opts.sessionId));
      h.onLine(text('Vou rodar os testes.'));
      await callApprove(opts, 'Bash', { command: 'npm test', description: 'testes' });
    };
    await boot(r1, { configure: true });
    send({ type: 'issue.place', nodeId: 'n-issue', issueRef: '101#142', x: 0, y: 0 });
    send({
      type: 'note.create',
      nodeId: 'n-note',
      note: { id: 'note1', title: 'Decisão', body: 'Usar o event_id.' },
      x: 0,
      y: 600,
    });
    send({
      type: 'agent.create',
      agentId: 'a1',
      nodeId: 'n-a1',
      edgeId: 'e-a1',
      issueRef: '101#142',
      repos: [],
      instruction: 'Resolva a issue.',
      x: 0,
      y: 300,
    });
    const pending = await until(() => approvals().find((a) => a.status === 'pending'), 'pedido de permissão');
    await until(() => agentState('a1')?.status === 'waiting', 'agente aguardando');
    const worktree = agentState('a1')!.worktreePath!;
    await crash();
    return { pending, worktree, r1 };
  }

  it('retoma o agente com --resume e reaproveita o pedido de permissão pendente', async () => {
    const { pending } = await firstRun();

    const r2 = new FakeRunner();
    let decision: { behavior: string } | undefined;
    r2.turn = async (opts, h) => {
      h.onLine(text('Retomando.'));
      decision = await callApprove(opts, 'Bash', { description: 'testes', command: 'npm test' });
      h.onLine(text('Testes passaram.'));
      h.onLine(result(opts.sessionId));
    };
    const before = await boot(r2);

    // nada se perdeu: canvas, nota, histórico e o pedido pendente
    expect(before.agents.find((a) => a.id === 'a1')!.status).toBe('waiting');
    expect(before.notes.map((n) => n.body)).toContain('Usar o event_id.');
    expect(before.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['n-issue', 'n-note', 'n-a1']));
    expect(before.approvals.map((a) => a.id)).toEqual([pending.id]);
    expect(
      before.agentEvents.some(
        (e) => e.agentId === 'a1' && e.body.kind === 'text' && e.body.text === 'Vou rodar os testes.',
      ),
    ).toBe(true);

    // o agente volta sozinho, com a mesma sessão
    await until(() => r2.starts.length === 1, 'retomada');
    expect(r2.starts[0]!.resume).toBe(true);
    expect(r2.starts[0]!.sessionId).toBe(before.agents.find((a) => a.id === 'a1')!.sessionId);
    expect(r2.sent[0]).toContain('reiniciou no meio do seu turno');

    // o pedido de novo é o mesmo da caixa de Ações; a decisão do usuário vale para ele
    await until(async () => (await liveAgent('a1'))?.status === 'waiting', 'aguardando de novo');
    send({ type: 'approval.decide', approvalId: pending.id, decision: 'allow' });
    await until(() => decision, 'decisão');
    expect(decision).toMatchObject({ behavior: 'allow' });
    await until(() => agentState('a1')?.status === 'done', 'turno concluído');
    expect(new Set(approvals().map((a) => a.id))).toEqual(new Set([pending.id]));
  });

  it('a decisão dada antes de o agente pedir de novo é entregue na hora', async () => {
    const { pending } = await firstRun();
    const r2 = new FakeRunner();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let decision: { behavior: string } | undefined;
    r2.turn = async (opts, h) => {
      await gate;
      decision = await callApprove(opts, 'Bash', { command: 'npm test', description: 'testes' });
      h.onLine(result(opts.sessionId));
    };
    await boot(r2);
    await until(() => r2.starts.length === 1, 'retomada');
    send({ type: 'approval.decide', approvalId: pending.id, decision: 'deny' });
    await until(() => approvals().find((a) => a.id === pending.id && a.status === 'denied'), 'negado');
    release();
    await until(() => decision, 'decisão');
    expect(decision).toMatchObject({ behavior: 'deny' });
  });

  it('sem retomada automática, o agente fica pausado e o pedido antigo é negado', async () => {
    const { pending } = await firstRun();
    const r2 = new FakeRunner();
    await boot(r2, { autoResume: false });
    await until(async () => (await liveAgent('a1'))?.status === 'paused', 'pausado');
    expect(r2.starts).toHaveLength(0);
    await until(async () => (await live()).approvals.length === 0, 'pedido negado');
    const all = b!.sqlite.prepare('select status from approval where id = ?').get(pending.id) as {
      status: string;
    };
    expect(all.status).toBe('denied');
  });

  it('worktree apagado: o agente vira erro em vez de retomar', async () => {
    const { worktree } = await firstRun();
    rmSync(worktree, { recursive: true, force: true });
    const r2 = new FakeRunner();
    await boot(r2);
    const a = await until(async () => {
      const x = await liveAgent('a1');
      return x?.status === 'error' && x;
    }, 'erro');
    expect(a.error).toContain('não existe mais');
    expect(r2.starts).toHaveLength(0);
  });

  it('o token de sessão sobrevive ao reinício', () => {
    const s1 = new Session();
    s1.publish(home, 1);
    expect(Session.load(home).token).toBe(s1.token);
    writeFileSync(join(home, 'session.json'), '{"token":"curto"}');
    expect(Session.load(home).token).toMatch(/^[0-9a-f]{64}$/);
  });
});
