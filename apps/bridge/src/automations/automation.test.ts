import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Agent, MergeRequest, ServerMessage } from '@agent-canvas/shared';
import type { AgentProcess, AgentRunner, RunnerHandlers, RunnerStartOptions } from '../agents/runner.ts';
import { MockGitLabClient } from '../gitlab/mock-client.ts';
import { makeBridge } from '../test-utils.ts';

const TEST_PORT = 4994;
const gitIn = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...a], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

type Role = 'main' | 'fix' | 'reviewer';
const roleOf = (o: RunnerStartOptions): Role =>
  o.appendSystemPrompt?.includes('agente de correção')
    ? 'fix'
    : o.appendSystemPrompt?.includes('agente revisor')
      ? 'reviewer'
      : 'main';

/** Runner falso: cada mensagem roda o roteiro do papel do agente, com o texto recebido. */
class ScriptRunner implements AgentRunner {
  scripts: Partial<Record<Role, (o: RunnerStartOptions, h: RunnerHandlers, text: string) => Promise<void>>> =
    {};
  received: { role: Role; cwd: string; text: string }[] = [];
  start(opts: RunnerStartOptions, h: RunnerHandlers): AgentProcess {
    let alive = true;
    const exit = () => {
      if (alive) {
        alive = false;
        setTimeout(() => h.onExit({ code: 0, signal: null, stderr: '' }), 5);
      }
    };
    return {
      send: (text) => {
        const role = roleOf(opts);
        this.received.push({ role, cwd: opts.cwd, text });
        h.onLine(init(opts.sessionId));
        void (this.scripts[role]?.(opts, h, text) ?? Promise.resolve()).finally(() =>
          h.onLine(result(opts.sessionId)),
        );
      },
      interrupt: () => {},
      endInput: exit,
      kill: exit,
    };
  }
}

async function callTool(opts: RunnerStartOptions, name: string, args: Record<string, unknown>) {
  const srv = JSON.parse(readFileSync(opts.mcpConfigPath, 'utf8')).mcpServers.canvas;
  const client = new Client({ name: 'fake-claude', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(srv.url), {
    requestInit: { headers: srv.headers },
  });
  transport.onerror = () => {};
  client.onerror = () => {};
  await client.connect(transport);
  const res = await client.callTool({ name, arguments: args });
  await client.close();
  return { text: (res.content as { text: string }[])[0]!.text, isError: !!res.isError };
}

const line = (o: unknown) => JSON.stringify(o);
const init = (sid: string) =>
  line({ type: 'system', subtype: 'init', session_id: sid, model: 'fake', cwd: '/w' });
const result = (sid: string) =>
  line({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid, usage: {} });

describe('automações', () => {
  let b: Awaited<ReturnType<typeof makeBridge>>;
  let runner: ScriptRunner;
  let ws: WebSocket;
  let msgs: ServerMessage[];
  let origin: string;
  let client: MockGitLabClient;

  const send = (m: object) => ws.send(JSON.stringify(m));
  async function until<T>(fn: () => T | undefined | false, what: string): Promise<T> {
    for (let i = 0; i < 400; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`esperando ${what}; mensagens: ${msgs.map((m) => m.type).join(', ')}`);
  }
  const agents = () => {
    const out = new Map<string, Agent>();
    for (const m of msgs) if (m.type === 'agent.upsert') out.set(m.agent.id, m.agent);
    return [...out.values()];
  };
  const lastMr = () =>
    msgs.filter((m): m is Extract<ServerMessage, { type: 'mr.upsert' }> => m.type === 'mr.upsert').at(-1)
      ?.mr as MergeRequest | undefined;
  const activity = () => msgs.flatMap((m) => (m.type === 'activity' ? [m.text] : []));
  const setAutomations = (patch: object) =>
    b.app.inject({ method: 'PUT', url: '/api/settings/automations', headers: b.headers, payload: patch });

  beforeEach(async () => {
    runner = new ScriptRunner();
    client = new MockGitLabClient({ pipelineMs: 60_000 });
    b = await makeBridge(() => client, runner, TEST_PORT);
    const reposDir = mkdtempSync(join(tmpdir(), 'ac-auto-repos-'));
    origin = join(reposDir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    const repo = join(reposDir, 'payments-api');
    mkdirSync(repo);
    gitIn(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# payments-api\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-qm', 'inicial');
    gitIn(repo, 'remote', 'add', 'origin', origin);
    gitIn(repo, 'push', '-q', 'origin', 'main');
    const h = b.headers;
    await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: h,
      payload: { mode: 'gitlab', baseUrl: 'https://gitlab.example.com', token: 'glpat-teste', reposDir },
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

    // o agente autor: commit com o teste quebrado e MR; depois responde à revisão
    runner.scripts.main = async (o, _h, text) => {
      // a primeira mensagem traz o contexto inteiro: decide pelo começo da mensagem
      if (text.startsWith('Comentário')) {
        await callTool(o, 'comment_mr', { body: 'Ajustado.' });
        return;
      }
      if (text.startsWith('O pipeline')) return;
      writeFileSync(join(o.cwd, 'webhooks.ts'), 'export const charges = 2;\n');
      gitIn(o.cwd, 'add', '.');
      gitIn(o.cwd, 'commit', '-qm', 'Webhook');
      await callTool(o, 'open_merge_request', { title: 'Webhook idempotente' });
    };
    send({ type: 'issue.place', nodeId: 'n-issue', issueRef: '101#142', x: 0, y: 0 });
  });
  afterEach(async () => {
    ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    await b.cleanup();
  });

  const createAuthor = async () => {
    send({
      type: 'agent.create',
      agentId: 'a1',
      nodeId: 'n-a1',
      edgeId: 'e-a1',
      issueRef: '101#142',
      repos: [],
      instruction: 'Resolva a issue.',
      openMr: true,
      x: 0,
      y: 300,
    });
    const mr = await until(() => lastMr(), 'MR do autor');
    await until(() => agents().find((a) => a.id === 'a1' && a.status === 'done'), 'autor concluir');
    return mr;
  };

  it('pipeline falhou: agente fix no branch do MR, commits no mesmo MR e pipeline verde', async () => {
    let fixContext = '';
    let fixTool: { text: string; isError: boolean } | undefined;
    runner.scripts.fix = async (o, _h, text) => {
      if (text.includes('falhou de novo')) return;
      fixContext = readFileSync(join(o.cwd, '.agent-canvas/context.md'), 'utf8');
      writeFileSync(join(o.cwd, 'webhooks.ts'), 'export const charges = 1;\n');
      gitIn(o.cwd, 'add', '.');
      gitIn(o.cwd, 'commit', '-qm', 'Corrige o teste do webhook');
      fixTool = await callTool(o, 'open_merge_request', { title: 'ignorado' });
    };
    const mr = await createAuthor();
    const author = agents().find((a) => a.id === 'a1')!;

    client.forcePipeline(101, mr.iid, 'failed');
    await b.app.poller.tick('mrs');
    const fix = await until(() => agents().find((a) => a.role === 'fix'), 'agente fix');
    expect(fix).toMatchObject({
      parentId: 'a1',
      mrRef: mr.ref,
      worktreePath: author.worktreePath,
      branch: author.branch,
      issueRef: '101#142',
      openMr: false,
    });
    // ao lado do MR, ligado a ele
    const mrNode = msgs.find(
      (m): m is Extract<ServerMessage, { type: 'node.upsert' }> =>
        m.type === 'node.upsert' && m.node.type === 'mr',
    )!.node;
    const fixNode = msgs.find(
      (m): m is Extract<ServerMessage, { type: 'node.upsert' }> =>
        m.type === 'node.upsert' && m.node.refId === fix.id,
    )!.node;
    expect(
      msgs.some(
        (m) => m.type === 'edge.upsert' && m.edge.fromNodeId === mrNode.id && m.edge.toNodeId === fixNode.id,
      ),
    ).toBe(true);

    await until(() => fixTool, 'fix enviar os commits');
    expect(fixTool).toMatchObject({ isError: false });
    expect(fixTool!.text).toContain(`Commits enviados ao MR !${mr.iid}`);
    expect(fixContext).toContain(`Log do pipeline do MR !${mr.iid} (dados)`);
    expect(fixContext).toContain('AssertionError');
    expect(fixContext).toContain(`Você corrige o MR !${mr.iid}`);
    // o commit do fix foi para o branch do MR no origin; o MR continua sendo do autor
    expect(gitIn(origin, 'log', '--format=%s', '-1', mr.sourceBranch)).toBe('Corrige o teste do webhook');
    await until(() => agents().find((a) => a.id === fix.id && a.status === 'done'), 'fix concluir');
    expect(lastMr()!.agentId).toBe('a1');

    // o pipeline roda de novo e passa
    client.forcePipeline(101, mr.iid, 'success');
    await b.app.poller.tick('mrs');
    await until(() => lastMr()!.pipelineStatus === 'success', 'pipeline verde');

    // falhou de novo: o mesmo fix retoma com o log novo, sem criar outro agente
    client.forcePipeline(101, mr.iid, 'failed');
    await b.app.poller.tick('mrs');
    await until(() => runner.received.filter((r) => r.role === 'fix').length === 2, 'fix retomar');
    expect(runner.received.at(-1)!.text).toContain('falhou de novo');
    expect(agents().filter((a) => a.role === 'fix')).toHaveLength(1);
  });

  it('desligada, a falha do pipeline não cria agente; o botão das Ações cria', async () => {
    await setAutomations({ fixPipeline: false });
    const mr = await createAuthor();
    client.forcePipeline(101, mr.iid, 'failed');
    await b.app.poller.tick('mrs');
    await until(() => lastMr()!.pipelineStatus === 'failed', 'pipeline com falha');
    await new Promise((r) => setTimeout(r, 50));
    expect(agents().some((a) => a.role === 'fix')).toBe(false);

    send({ type: 'mr.fix', mrRef: mr.ref });
    await until(() => agents().find((a) => a.role === 'fix'), 'fix pelo botão');
  });

  it('revisor automático comenta; o comentário vai para o autor, e o do usuário também', async () => {
    await setAutomations({ reviewer: true });
    let reviewerCwd = '';
    let reviewerContext = '';
    let refused: { text: string; isError: boolean } | undefined;
    runner.scripts.reviewer = async (o) => {
      reviewerCwd = o.cwd;
      reviewerContext = readFileSync(join(o.cwd, '.agent-canvas/context.md'), 'utf8');
      refused = await callTool(o, 'open_merge_request', { title: 'x' });
      await callTool(o, 'comment_mr', { body: 'Falta um teste para o reenvio do gateway.' });
    };
    const mr = await createAuthor();
    const reviewer = await until(() => agents().find((a) => a.role === 'reviewer'), 'revisor');
    expect(reviewer).toMatchObject({ parentId: 'a1', mrRef: mr.ref });
    await until(() => agents().find((a) => a.id === reviewer.id && a.status === 'done'), 'revisor concluir');
    const author = agents().find((a) => a.id === 'a1')!;
    expect(reviewerCwd).not.toBe(author.worktreePath);
    expect(gitIn(reviewerCwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`${mr.sourceBranch}-review`);
    expect(reviewerContext).toContain(`Diff do MR !${mr.iid}`);
    expect(reviewerContext).toContain(`Você revisa o MR !${mr.iid}`);
    expect(refused).toMatchObject({ isError: true });
    expect(refused!.text).toContain('Revisores não abrem MR');

    // o poller acha o comentário do revisor e manda para o autor
    await b.app.poller.tick('mrs');
    const toAuthor = await until(
      () => runner.received.find((r) => r.role === 'main' && r.text.startsWith('Comentário')),
      'comentário no autor',
    );
    expect(toAuthor.text).toContain('Falta um teste para o reenvio do gateway.');
    expect(toAuthor.text).toContain('não instrução do usuário do canvas');
    await until(() => agents().find((a) => a.id === 'a1' && a.status === 'done'), 'autor responder');
    await until(
      () =>
        activity().some((t) =>
          t.includes(`no MR !${mr.iid} enviado a ${agents().find((a) => a.id === 'a1')!.name}`),
        ),
      'atividade do envio',
    );

    // a resposta do próprio autor (comment_mr) não volta para ele
    const before = runner.received.length;
    await b.app.poller.tick('mrs');
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.received.length).toBe(before);

    // comentário do usuário pelo canvas chega na hora
    send({ type: 'mr.comment', mrRef: mr.ref, body: 'Renomeie charges para chargeCount.' });
    await until(
      () => runner.received.find((r) => r.role === 'main' && r.text.includes('chargeCount')),
      'comentário do usuário no autor',
    );
  });

  it('label agent-ready: a issue entra no canvas e o agente começa, uma vez só', async () => {
    let started = '';
    runner.scripts.main = async (_o, _h, text) => {
      started = text;
    };
    client.addLabel(101, 161, 'agent-ready');
    await b.app.poller.tick('issues');
    expect(agents()).toHaveLength(0); // automação desligada por padrão

    await setAutomations({ agentReady: true });
    await b.app.poller.tick('issues');
    const a = await until(() => agents().find((x) => x.issueRef === '101#161'), 'agente da issue');
    expect(a).toMatchObject({ role: 'main', openMr: true, maxDepth: 1, repos: [101] });
    expect(
      msgs.some((m) => m.type === 'node.upsert' && m.node.type === 'issue' && m.node.refId === '101#161'),
    ).toBe(true);
    await until(() => started, 'primeira mensagem');
    expect(started).toContain('agent-ready');

    await b.app.poller.tick('issues');
    await new Promise((r) => setTimeout(r, 50));
    expect(agents().filter((x) => x.issueRef === '101#161')).toHaveLength(1);
  });
});
