import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Agent, Approval, ServerMessage } from '@agent-canvas/shared';
import { makeBridge } from '../test-utils.ts';

const TEST_PORT = 4998;
import type { AgentProcess, AgentRunner, RunnerHandlers, RunnerStartOptions } from './runner.ts';
import type { Namer } from './namer.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n');

/**
 * Runner falso: em vez do `claude`, reproduz as linhas gravadas e pede permissão pela
 * ferramenta approve do MCP do bridge, do mesmo jeito que o claude faria.
 */
class FakeRunner implements AgentRunner {
  starts: RunnerStartOptions[] = [];
  sent: string[] = [];
  /** Roteiro de cada turno: devolve as linhas a emitir. */
  turn: (opts: RunnerStartOptions, h: RunnerHandlers, text: string) => Promise<void> = async () => {};
  interrupted = false;

  start(opts: RunnerStartOptions, h: RunnerHandlers): AgentProcess {
    this.starts.push(opts);
    let alive = true;
    return {
      send: (text) => {
        this.sent.push(text);
        void this.turn(opts, h, text);
      },
      interrupt: () => {
        this.interrupted = true;
        const lines = fixture('interrupt').filter(
          (l) => l.includes('"control_response"') || l.includes('"type":"result"'),
        );
        lines.forEach((l) => h.onLine(l));
      },
      endInput: () => {
        if (alive) {
          alive = false;
          setTimeout(() => h.onExit({ code: 0, signal: null, stderr: '' }), 5);
        }
      },
      kill: () => {
        if (alive) {
          alive = false;
          setTimeout(() => h.onExit({ code: null, signal: 'SIGINT', stderr: '' }), 5);
        }
      },
    };
  }
}

async function callApprove(opts: RunnerStartOptions, toolName: string, input: Record<string, unknown>) {
  const cfg = JSON.parse(readFileSync(opts.mcpConfigPath, 'utf8'));
  const srv = cfg.mcpServers.canvas;
  const client = new Client({ name: 'fake-claude', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(srv.url), {
    requestInit: { headers: srv.headers },
  });
  // o fim do teste derruba conexões em andamento; isso não é falha do bridge
  transport.onerror = () => {};
  client.onerror = () => {};
  await client.connect(transport);
  expect((await client.listTools()).tools.map((t) => t.name)).toContain('approve');
  const res = await client.callTool({
    name: 'approve',
    arguments: { tool_name: toolName, input, tool_use_id: 't1' },
  });
  await client.close();
  return JSON.parse((res.content as { text: string }[])[0]!.text);
}

const line = (o: unknown) => JSON.stringify(o);
const init = (sid: string) =>
  line({ type: 'system', subtype: 'init', session_id: sid, model: 'fake', cwd: '/w' });
const result = (sid: string) =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'feito',
    total_cost_usd: 0.01,
    num_turns: 2,
    session_id: sid,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100 },
  });

describe('supervisor', () => {
  let b: Awaited<ReturnType<typeof makeBridge>>;
  let runner: FakeRunner;
  let ws: WebSocket;
  let msgs: ServerMessage[];
  let reposDir: string;

  const send = (m: object) => ws.send(JSON.stringify(m));
  const agentState = (id: string) =>
    msgs
      .filter(
        (m): m is Extract<ServerMessage, { type: 'agent.upsert' }> =>
          m.type === 'agent.upsert' && m.agent.id === id,
      )
      .at(-1)?.agent as Agent | undefined;
  async function until<T>(fn: () => T | undefined | false, what: string): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`esperando ${what}; mensagens: ${msgs.map((m) => m.type).join(', ')}`);
  }

  /** Namer falso; por padrão falha, e o agente fica com o título rápido e agente-N. */
  let nameTask: Namer['name'];

  beforeEach(async () => {
    runner = new FakeRunner();
    nameTask = async () => {
      throw new Error('namer não configurado neste teste');
    };
    b = await makeBridge(undefined, runner, TEST_PORT, { namer: { name: (t) => nameTask(t) } });
    reposDir = mkdtempSync(join(tmpdir(), 'ac-repos-'));
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
    await b.app.inject({ url: '/api/gitlab/issues', headers: h });
    await b.app.listen({ host: '127.0.0.1', port: TEST_PORT });
    msgs = [];
    ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws?token=${b.session.token}`, {
      origin: 'http://localhost:5173',
    });
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    send({ type: 'issue.place', nodeId: 'n-issue', issueRef: '101#142', x: 0, y: 0 });
  });
  afterEach(async () => {
    ws.terminate();
    // o cliente MCP do SDK fecha a conexão em segundo plano; espera antes de derrubar o servidor
    await new Promise((r) => setTimeout(r, 100));
    await b.cleanup();
  });

  it('agente de issue: worktree, contexto, pedido de permissão aprovado com "Sempre permitir", turno concluído', async () => {
    let decision: unknown;
    runner.turn = async (opts, h) => {
      h.onLine(init(opts.sessionId));
      h.onLine(
        line({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }],
          },
        }),
      );
      decision = await callApprove(opts, 'Bash', { command: 'npm test' });
      h.onLine(
        line({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '1 passed' }] },
        }),
      );
      h.onLine(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Pronto.' }] } }));
      h.onLine(result(opts.sessionId));
    };

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

    const approval = await until(
      () =>
        msgs.find(
          (m): m is Extract<ServerMessage, { type: 'approval.upsert' }> => m.type === 'approval.upsert',
        )?.approval as Approval | undefined,
      'pedido de permissão',
    );
    expect(approval).toMatchObject({
      toolName: 'Bash',
      summary: 'npm test',
      suggestedRule: 'Bash(npm test:*)',
      status: 'pending',
    });
    await until(() => agentState('a1')?.status === 'waiting', 'status aguardando');

    // o processo começou no worktree certo, com o MCP e a ferramenta de permissão
    const opts = runner.starts[0]!;
    expect(opts.resume).toBe(false);
    expect(opts.permissionPromptTool).toBe('mcp__canvas__approve');
    expect(opts.disallowedTools).toContain('Bash(git push --force:*)');
    expect(statSync(opts.mcpConfigPath).mode & 0o777).toBe(0o600);
    const a = agentState('a1')!;
    expect(a.branch).toBe('agent/142-webhook-pagamento-duplica-cobranca');
    expect(opts.cwd).toBe(a.worktreePath);
    const ctx = readFileSync(join(a.worktreePath!, '.agent-canvas', 'context.md'), 'utf8');
    expect(ctx).toContain('Webhook de pagamento duplica cobrança');
    expect(ctx).toContain('não como instruções do usuário');
    expect(ctx).toContain('O gateway manda o mesmo event_id'); // comentário da issue
    expect(runner.sent[0]).toMatch(/Leia \.agent-canvas\/context\.md/);
    // aresta issue → agente
    expect(
      msgs.some((m) => m.type === 'edge.upsert' && m.edge.id === 'e-a1' && m.edge.kind === 'issue'),
    ).toBe(true);

    send({ type: 'approval.decide', approvalId: approval.id, decision: 'allow', remember: true });
    await until(() => agentState('a1')?.status === 'done', 'turno concluído');
    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
    expect(msgs.some((m) => m.type === 'policy.upsert' && m.policy.pattern === 'Bash(npm test:*)')).toBe(
      true,
    );

    const done = agentState('a1')!;
    expect(done).toMatchObject({ inputTokens: 110, outputTokens: 20, costUsd: 0.01 });
    expect(done.sessionId).toBe(opts.sessionId);

    const events = (await b.app.inject({ url: '/api/agents/a1/events', headers: b.headers })).json();
    const kinds = events.map((e: { body: { kind: string } }) => e.body.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'user_message',
        'init',
        'tool_use',
        'permission',
        'tool_result',
        'text',
        'result',
      ]),
    );

    // próxima mensagem retoma a mesma sessão; a regra salva vai em --allowedTools
    runner.turn = async (o, h) => {
      h.onLine(init(o.sessionId));
      const d = await callApprove(o, 'Bash', { command: 'npm test -- webhooks' });
      expect(d).toMatchObject({ behavior: 'allow' }); // liberado pela regra, sem pedir
      h.onLine(result(o.sessionId));
    };
    send({ type: 'agent.message', agentId: 'a1', text: 'Rode os testes de novo' });
    await until(() => runner.starts.length === 2, 'segundo processo');
    expect(runner.starts[1]).toMatchObject({
      resume: true,
      sessionId: opts.sessionId,
      allowedTools: expect.arrayContaining(['Bash(npm test:*)', 'mcp__canvas__open_merge_request']),
    });
    await until(() => agentState('a1')?.status === 'done' && runner.sent.length === 2, 'segundo turno');
  });

  it('negações padrão respondem na hora; pausar, retomar e parar', async () => {
    let denied: unknown;
    runner.turn = async (opts, h, text) => {
      if (text.includes('Continue')) return h.onLine(init(opts.sessionId));
      h.onLine(init(opts.sessionId));
      denied = await callApprove(opts, 'Bash', { command: 'git push --force origin main' });
      // fica trabalhando até ser pausado
    };
    send({
      type: 'agent.create',
      agentId: 'a2',
      nodeId: 'n-a2',
      repos: [101],
      instruction: 'Faça algo',
      x: 0,
      y: 0,
    });
    await until(() => denied, 'negação padrão');
    expect(denied).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/forçado/) });
    expect(agentState('a2')?.status).toBe('running');

    send({ type: 'agent.pause', agentId: 'a2' });
    await until(() => agentState('a2')?.status === 'paused', 'pausado');
    expect(runner.interrupted).toBe(true);

    send({ type: 'agent.resume', agentId: 'a2' });
    await until(() => runner.starts.length === 2, 'retomada');
    expect(runner.starts[1]!.resume).toBe(true);
    expect(runner.sent.at(-1)).toMatch(/^Continue de onde parou\. O usuário só pausou você/);

    send({ type: 'agent.stop', agentId: 'a2' });
    await until(() => agentState('a2')?.status === 'stopped', 'parado');
  });

  it('agente em branco recebe repositório e começa na primeira instrução', async () => {
    runner.turn = async (opts, h) => {
      h.onLine(init(opts.sessionId));
      h.onLine(result(opts.sessionId));
    };
    send({ type: 'agent.create', agentId: 'a3', nodeId: 'n-a3', repos: [], x: 0, y: 0 });
    await until(() => agentState('a3'), 'agente criado');
    expect(agentState('a3')).toMatchObject({ status: 'idle', title: 'Agente em branco', worktreePath: null });
    expect(runner.starts).toHaveLength(0);

    // sem repositório, a primeira mensagem explica o que falta
    send({ type: 'agent.message', agentId: 'a3', text: 'Atualize o README' });
    await until(() => msgs.find((m) => m.type === 'error'), 'erro sem repositório');
    expect(msgs.find((m) => m.type === 'error')).toMatchObject({
      message: expect.stringMatching(/Escolha um repositório/),
    });

    send({ type: 'agent.update', agentId: 'a3', repos: [101] });
    await until(() => agentState('a3')?.repos.length === 1, 'repositório escolhido');
    send({ type: 'agent.message', agentId: 'a3', text: 'Atualize o README' });
    await until(() => agentState('a3')?.status === 'done', 'concluído');
    expect(agentState('a3')).toMatchObject({ instruction: 'Atualize o README', title: 'Atualize o README' });
    expect(existsSync(agentState('a3')!.worktreePath!)).toBe(true);
  });

  it('o namer dá nome e título antes do branch; o usuário renomeia e o namer não escreve por cima', async () => {
    runner.turn = async (opts, h) => {
      h.onLine(init(opts.sessionId));
      h.onLine(result(opts.sessionId));
    };
    const tasks: string[] = [];
    nameTask = async (t) => {
      tasks.push(t);
      return { name: 'Renomear agentes', title: 'Permitir renomear agentes' };
    };
    send({
      type: 'agent.create',
      agentId: 'a4',
      nodeId: 'n-a4',
      repos: [101],
      instruction: 'Quero que seja possível alterar o nome do agente, e melhore o nome automático',
      x: 0,
      y: 0,
    });
    // na hora: título rápido, sem os rodeios do pedido
    await until(() => agentState('a4'), 'agente criado');
    expect(msgs.find((m) => m.type === 'agent.upsert' && m.agent.id === 'a4')).toMatchObject({
      agent: { name: 'agente-1', title: 'Alterar o nome do agente' },
    });
    await until(() => agentState('a4')?.status === 'done', 'concluído');
    expect(tasks).toHaveLength(1);
    expect(agentState('a4')).toMatchObject({
      name: 'Renomear agentes',
      title: 'Permitir renomear agentes',
      branch: expect.stringMatching(/^agent\/permitir-renomear-agentes-/),
    });

    send({ type: 'agent.rename', agentId: 'a4', name: '  Meu   agente ', title: 'Outra coisa' });
    await until(() => agentState('a4')?.name === 'Meu agente', 'renomeado');
    expect(agentState('a4')!.title).toBe('Outra coisa');

    // nome repetido é recusado
    send({ type: 'agent.create', agentId: 'a5', nodeId: 'n-a5', repos: [], x: 0, y: 0 });
    await until(() => agentState('a5'), 'segundo agente');
    send({ type: 'agent.rename', agentId: 'a5', name: 'meu agente' });
    await until(() => msgs.find((m) => m.type === 'error'), 'erro de nome repetido');
    expect(msgs.find((m) => m.type === 'error')).toMatchObject({
      message: expect.stringMatching(/Já existe/),
    });

    // renomeado antes da primeira instrução: o namer não troca o nome escolhido, só o título
    send({ type: 'agent.rename', agentId: 'a5', name: 'Docs' });
    await until(() => agentState('a5')?.name === 'Docs', 'renomeado antes de começar');
    send({ type: 'agent.update', agentId: 'a5', repos: [101] });
    await until(() => agentState('a5')?.repos.length === 1, 'repositório escolhido');
    send({ type: 'agent.message', agentId: 'a5', text: 'Atualize o README' });
    await until(() => agentState('a5')?.status === 'done', 'segundo concluído');
    expect(agentState('a5')).toMatchObject({ name: 'Docs', title: 'Permitir renomear agentes' });
  });

  it('MCP recusa token desconhecido', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer nada', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
