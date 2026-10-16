import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { MergeRequest, ServerMessage, StateSnapshot } from '@agent-canvas/shared';
import type { AgentProcess, AgentRunner, RunnerHandlers, RunnerStartOptions } from '../agents/runner.ts';
import { MockGitLabClient } from '../gitlab/mock-client.ts';
import { makeBridge } from '../test-utils.ts';

const TEST_PORT = 4997;
const gitIn = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...a], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

/** Runner falso: cada turno roda o roteiro do teste no worktree do agente. */
class ScriptRunner implements AgentRunner {
  turn: (opts: RunnerStartOptions, h: RunnerHandlers) => Promise<void> = async () => {};
  start(opts: RunnerStartOptions, h: RunnerHandlers): AgentProcess {
    let alive = true;
    const exit = () => {
      if (alive) {
        alive = false;
        setTimeout(() => h.onExit({ code: 0, signal: null, stderr: '' }), 5);
      }
    };
    return {
      send: () => void this.turn(opts, h),
      interrupt: () => {},
      endInput: exit,
      kill: exit,
    };
  }
}

/** Chama uma ferramenta do MCP do canvas como o `claude` do agente faria. */
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

describe('merge requests', () => {
  let b: Awaited<ReturnType<typeof makeBridge>>;
  let runner: ScriptRunner;
  let ws: WebSocket;
  let msgs: ServerMessage[];
  let origin: string;

  const send = (m: object) => ws.send(JSON.stringify(m));
  async function until<T>(fn: () => T | undefined | false, what: string): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`esperando ${what}; mensagens: ${msgs.map((m) => m.type).join(', ')}`);
  }
  const lastMr = () =>
    msgs.filter((m): m is Extract<ServerMessage, { type: 'mr.upsert' }> => m.type === 'mr.upsert').at(-1)
      ?.mr as MergeRequest | undefined;

  beforeEach(async () => {
    runner = new ScriptRunner();
    // o GitLab é o mock (com pipeline rápido), mas o modo é "gitlab": o branch vai mesmo para o origin
    const client = new MockGitLabClient({ pipelineMs: 1000 });
    b = await makeBridge(() => client, runner, TEST_PORT);
    const reposDir = mkdtempSync(join(tmpdir(), 'ac-mr-repos-'));
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
    send({ type: 'issue.place', nodeId: 'n-issue', issueRef: '101#142', x: 0, y: 0 });
  });
  afterEach(async () => {
    ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    await b.cleanup();
  });

  const createAgent = () =>
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

  it('o agente abre o MR: push, nó ligado, pipeline atualiza, merge só pelo usuário', async () => {
    const tool: { open?: { text: string; isError: boolean }; empty?: { text: string; isError: boolean } } =
      {};
    let context = '';
    runner.turn = async (opts, h) => {
      h.onLine(init(opts.sessionId));
      context = readFileSync(join(opts.cwd, '.agent-canvas/context.md'), 'utf8');
      tool.empty = await callTool(opts, 'open_merge_request', { title: 'Cedo demais' });
      writeFileSync(join(opts.cwd, 'webhooks.ts'), 'export const idempotent = true;\n');
      gitIn(opts.cwd, 'add', '.');
      gitIn(opts.cwd, 'commit', '-qm', 'Webhook idempotente');
      tool.open = await callTool(opts, 'open_merge_request', {
        title: 'Corrige cobrança duplicada no webhook',
        description: 'Usa a chave de idempotência.\n\nCloses #142',
      });
      h.onLine(result(opts.sessionId));
    };
    createAgent();

    const mr = await until(() => lastMr(), 'mr.upsert');
    expect(context).toContain('abra o MR com a ferramenta `open_merge_request`');
    expect(tool.empty).toMatchObject({ isError: true });
    expect(tool.empty!.text).toContain('Não há commits novos');
    await until(() => tool.open, 'resposta da ferramenta');
    expect(tool.open).toMatchObject({ isError: false });
    expect(tool.open!.text).toContain(`MR !${mr.iid} aberto`);

    expect(mr).toMatchObject({
      ref: `101!${mr.iid}`,
      state: 'opened',
      pipelineStatus: 'running',
      agentId: 'a1',
      issueRef: '101#142',
      targetBranch: 'main',
      additions: 1,
      deletions: 0,
    });
    expect(mr.description.match(/Closes #142/g)).toHaveLength(1);
    // o branch foi enviado ao origin
    expect(gitIn(origin, 'branch', '--list', mr.sourceBranch)).toContain(mr.sourceBranch);
    // nó do MR ligado ao agente
    const mrNode = msgs.find(
      (m): m is Extract<ServerMessage, { type: 'node.upsert' }> =>
        m.type === 'node.upsert' && m.node.type === 'mr',
    )!.node;
    expect(mrNode.refId).toBe(mr.ref);
    expect(
      msgs.some((m) => m.type === 'edge.upsert' && m.edge.kind === 'mr' && m.edge.toNodeId === mrNode.id),
    ).toBe(true);

    // merge com o pipeline rodando é recusado
    send({ type: 'mr.merge', mrRef: mr.ref });
    await until(() => msgs.find((m) => m.type === 'error'), 'erro do merge');

    // o pipeline passa; o refresh (o mesmo do polling) avisa o canvas
    for (let i = 0; i < 40 && lastMr()?.pipelineStatus !== 'success'; i++) {
      send({ type: 'mr.refresh', mrRef: mr.ref });
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(lastMr()?.pipelineStatus).toBe('success');

    const state = (await b.app.inject({ url: '/api/state', headers: b.headers })).json() as StateSnapshot;
    expect(state.mergeRequests.map((m) => m.ref)).toEqual([mr.ref]);

    const diff = (
      await b.app.inject({ url: `/api/mrs/${encodeURIComponent(mr.ref)}/diff`, headers: b.headers })
    ).json();
    expect(diff).toMatchObject([{ newPath: 'webhooks.ts', newFile: true }]);

    send({ type: 'mr.merge', mrRef: mr.ref });
    await until(() => lastMr()?.state === 'merged', 'merge');
    expect(
      msgs.some((m) => m.type === 'activity' && m.text.includes(`MR !${mr.iid} aprovado e mergeado`)),
    ).toBe(true);
  });

  it('comentários do agente e do usuário no MR e na issue', async () => {
    const res: Record<string, { text: string; isError: boolean }> = {};
    runner.turn = async (opts, h) => {
      h.onLine(init(opts.sessionId));
      res.mrBefore = await callTool(opts, 'comment_mr', { body: 'oi' });
      writeFileSync(join(opts.cwd, 'a.txt'), 'a\n');
      gitIn(opts.cwd, 'add', '.');
      gitIn(opts.cwd, 'commit', '-qm', 'a');
      await callTool(opts, 'open_merge_request', { title: 'MR' });
      res.mr = await callTool(opts, 'comment_mr', { body: 'Pipeline verde.' });
      res.issue = await callTool(opts, 'comment_issue', { body: 'Abri o MR.' });
      h.onLine(result(opts.sessionId));
    };
    createAgent();
    await until(() => res.issue, 'comentários do agente');
    expect(res.mrBefore).toMatchObject({ isError: true });
    expect(res).toMatchObject({ mr: { isError: false }, issue: { isError: false } });

    const mr = lastMr()!;
    const mrComments = (
      await b.app.inject({ url: `/api/mrs/${encodeURIComponent(mr.ref)}/comments`, headers: b.headers })
    ).json();
    expect(mrComments.at(-1)).toMatchObject({ body: 'Pipeline verde.', isAgent: true, author: 'agente-1' });

    send({ type: 'issue.comment', issueRef: '101#142', body: 'Obrigado!' });
    await until(
      () => msgs.filter((m) => m.type === 'thread.changed' && m.target === 'issue').length === 2,
      'thread.changed da issue',
    );
    const issueComments = (
      await b.app.inject({ url: '/api/gitlab/issues/101/142/comments', headers: b.headers })
    ).json();
    expect(issueComments.slice(-2)).toMatchObject([
      { body: 'Abri o MR.', isAgent: true },
      { body: 'Obrigado!', isAgent: false },
    ]);
  });
});
