import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { MergeRequest, ServerMessage, SettingsView } from '@agent-canvas/shared';
import type { AgentProcess, AgentRunner, RunnerHandlers, RunnerStartOptions } from '../agents/runner.ts';
import { makeBridge } from '../test-utils.ts';

const TEST_PORT = 4993;
const gitIn = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...a], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

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
    return { send: () => void this.turn(opts, h), interrupt: () => {}, endInput: exit, kill: exit };
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

describe('modo local (sem GitLab)', () => {
  let b: Awaited<ReturnType<typeof makeBridge>>;
  let runner: ScriptRunner;
  let ws: WebSocket;
  let msgs: ServerMessage[];
  let repo: string;
  let bare: string;
  let gitlabCalls = 0;

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
    gitlabCalls = 0;
    // qualquer uso do GitLab neste modo é um erro: a fábrica conta e falha
    b = await makeBridge(
      () => {
        gitlabCalls++;
        throw new Error('GitLab não deveria ser usado no modo local');
      },
      runner,
      TEST_PORT,
    );
    const dir = mkdtempSync(join(tmpdir(), 'ac-local-mode-'));
    repo = join(dir, 'meu-app');
    mkdirSync(repo);
    gitIn(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# meu app\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-qm', 'inicial');
    bare = join(dir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    gitIn(repo, 'remote', 'add', 'origin', 'git@github.com:eu/meu-app.git');
    gitIn(repo, 'config', `url.${bare}.insteadOf`, 'git@github.com:eu/meu-app.git');
    for (const [k, v] of [
      ['GIT_AUTHOR_NAME', 'T'],
      ['GIT_AUTHOR_EMAIL', 't@e.com'],
      ['GIT_COMMITTER_NAME', 'T'],
      ['GIT_COMMITTER_EMAIL', 't@e.com'],
    ] as const)
      process.env[k] = v;

    await b.app.listen({ host: '127.0.0.1', port: TEST_PORT });
    msgs = [];
    ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws?token=${b.session.token}`, {
      origin: 'http://localhost:5173',
    });
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
  });
  afterEach(async () => {
    ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    await b.cleanup();
  });

  it('repositório pela pasta, agente sem issue, revisão no canvas, envio ao GitHub e merge no clone', async () => {
    const h = b.headers;
    let res = await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: h,
      payload: { mode: 'local' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsView>()).toMatchObject({ mode: 'local', configured: true, user: null });
    // sem GitLab: a lista de issues vem vazia, sem erro
    res = await b.app.inject({ url: '/api/gitlab/issues', headers: h });
    expect(res.json()).toEqual({ issues: [], errors: [] });

    res = await b.app.inject({
      method: 'POST',
      url: '/api/repos/local',
      headers: h,
      payload: { path: repo },
    });
    expect(res.statusCode).toBe(200);
    const project = res.json<SettingsView>().projects[0]!;
    expect(project).toMatchObject({
      id: -1,
      name: 'meu-app',
      local: true,
      remote: 'github',
      defaultBranch: 'main',
      webUrl: 'https://github.com/eu/meu-app',
    });
    res = await b.app.inject({
      method: 'POST',
      url: '/api/repos/local',
      headers: h,
      payload: { path: repo },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('já está no canvas');

    const tool: { open?: { text: string; isError: boolean }; comment?: { text: string; isError: boolean } } =
      {};
    runner.turn = async (opts, hd) => {
      hd.onLine(init(opts.sessionId));
      writeFileSync(join(opts.cwd, 'soma.js'), 'export const soma = (a, b) => a + b;\n');
      gitIn(opts.cwd, 'add', '.');
      gitIn(opts.cwd, 'commit', '-qm', 'Adiciona soma');
      tool.open = await callTool(opts, 'open_merge_request', {
        title: 'Adiciona soma',
        description: 'Função de soma.',
      });
      tool.comment = await callTool(opts, 'comment_mr', { body: 'oi' });
      hd.onLine(result(opts.sessionId));
    };
    send({
      type: 'agent.create',
      agentId: 'a1',
      nodeId: 'n-a1',
      repos: [-1],
      instruction: 'Crie uma função de soma.',
      openMr: true,
      x: 0,
      y: 0,
    });

    const mr = await until(() => lastMr(), 'revisão local');
    await until(() => tool.comment, 'ferramentas do agente');
    expect(tool.open).toMatchObject({ isError: false });
    expect(tool.open!.text).toContain('Repositório local');
    expect(tool.comment).toMatchObject({ isError: true });
    expect(mr).toMatchObject({
      ref: '-1!1',
      projectId: -1,
      state: 'opened',
      pipelineStatus: 'none',
      targetBranch: 'main',
      additions: 1,
      agentId: 'a1',
      issueRef: null,
    });
    // nada foi enviado ao remoto pelo agente
    expect(gitIn(bare, 'branch', '--list')).toBe('');
    expect(
      msgs.some((m) => m.type === 'node.upsert' && m.node.type === 'mr' && m.node.refId === mr.ref),
    ).toBe(true);

    res = await b.app.inject({ url: `/api/mrs/${encodeURIComponent(mr.ref)}/diff`, headers: h });
    expect(res.json()).toMatchObject([{ newPath: 'soma.js', newFile: true }]);
    res = await b.app.inject({ url: `/api/mrs/${encodeURIComponent(mr.ref)}/comments`, headers: h });
    expect(res.json()).toEqual([]);

    // "Enviar ao GitHub": push com as credenciais do usuário e a página do PR
    res = await b.app.inject({
      method: 'POST',
      url: `/api/mrs/${encodeURIComponent(mr.ref)}/publish`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<MergeRequest>()).toMatchObject({ publishedTo: 'github' });
    expect(res.json<MergeRequest>().remoteUrl).toMatch(
      /^https:\/\/github\.com\/eu\/meu-app\/compare\/main\.\.\.agent%2F/,
    );
    expect(gitIn(bare, 'branch', '--list', mr.sourceBranch)).toContain(mr.sourceBranch);

    // merge com mudanças não salvas na main: recusa, e o arquivo do usuário fica como estava
    writeFileSync(join(repo, 'README.md'), '# meu app (editando)\n');
    send({ type: 'mr.merge', mrRef: mr.ref });
    const err = await until(
      () => msgs.find((m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error'),
      'erro do merge',
    );
    expect(err.message).toContain('mudanças não salvas');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# meu app (editando)\n');

    gitIn(repo, 'checkout', '-q', '--', 'README.md');
    send({ type: 'mr.merge', mrRef: mr.ref });
    await until(() => lastMr()?.state === 'merged', 'merge local');
    expect(readFileSync(join(repo, 'soma.js'), 'utf8')).toContain('soma');
    expect(gitIn(repo, 'log', '-1', '--format=%s')).toContain(`Merge do branch '${mr.sourceBranch}'`);
    expect(gitlabCalls).toBe(0);

    // tirar o repositório do canvas não apaga nada do disco
    res = await b.app.inject({ method: 'DELETE', url: '/api/repos/local/-1', headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsView>().projects).toEqual([]);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# meu app\n');
  });

  it('conflito com a base: open_merge_request recusa e o poller avisa o agente para resolver', async () => {
    const h = b.headers;
    await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: h,
      payload: { mode: 'local' },
    });
    await b.app.inject({ method: 'POST', url: '/api/repos/local', headers: h, payload: { path: repo } });

    const opened: { text: string; isError: boolean }[] = [];
    const prompts: string[] = [];
    let turns = 0;
    runner.turn = async (opts, hd) => {
      turns++;
      hd.onLine(init(opts.sessionId));
      if (turns === 1) {
        writeFileSync(join(opts.cwd, 'README.md'), '# meu app\n\nDo agente.\n');
        gitIn(opts.cwd, 'commit', '-qam', 'README do agente');
        // a base mudou a mesma linha antes do envio
        writeFileSync(join(repo, 'README.md'), '# meu app\n\nDa base.\n');
        gitIn(repo, 'commit', '-qam', 'README da base');
        opened.push(await callTool(opts, 'open_merge_request', { title: 'README' }));
        // resolve como pedido: traz a base, junta as duas versões e envia de novo
        try {
          gitIn(opts.cwd, 'merge', '-q', 'main');
        } catch {
          /* conflito esperado */
        }
        writeFileSync(join(opts.cwd, 'README.md'), '# meu app\n\nDa base.\nDo agente.\n');
        gitIn(opts.cwd, 'commit', '-qam', 'Merge da main');
        opened.push(await callTool(opts, 'open_merge_request', { title: 'README' }));
      }
      hd.onLine(result(opts.sessionId));
    };
    const origStart = runner.start.bind(runner);
    runner.start = (opts, hd) => {
      const p = origStart(opts, hd);
      return {
        ...p,
        send: (text: string) => {
          prompts.push(text);
          p.send(text);
        },
      };
    };
    send({
      type: 'agent.create',
      agentId: 'a1',
      nodeId: 'n-a1',
      repos: [-1],
      instruction: 'Atualize o README.',
      openMr: true,
      x: 0,
      y: 0,
    });
    await until(() => opened.length === 2, 'as duas chamadas de open_merge_request');
    expect(opened[0]).toMatchObject({ isError: true });
    expect(opened[0]!.text).toMatch(/conflito de merge com `main`[\s\S]*README\.md[\s\S]*git merge main/);
    expect(opened[1]).toMatchObject({ isError: false });
    const mr = await until(() => lastMr(), 'revisão local');

    // a base anda de novo no mesmo arquivo: o poller encontra o conflito e acorda o agente
    writeFileSync(join(repo, 'README.md'), '# meu app\n\nOutra da base.\n');
    gitIn(repo, 'commit', '-qam', 'README de novo');
    await b.app.poller.tick('mrs');
    await until(() => turns >= 2, 'agente acordado pelo conflito');
    expect(prompts.at(-1)).toMatch(/deixou de entrar limpo na base[\s\S]*README\.md/);
    await until(
      () => msgs.some((m) => m.type === 'activity' && /tem conflito com main/.test(m.text)),
      'atividade do conflito',
    );
    // a rodada seguinte não avisa de novo
    await b.app.poller.tick('mrs');
    expect(turns).toBe(2);
    expect(mr.state).toBe('opened');
  });
});
