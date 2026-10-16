/**
 * Teste ponta a ponta do bridge com um GitLab de verdade (`pnpm e2e`): cliente gitbeaker,
 * git com push, MR, pipeline, diff, comentário e reinício do bridge sem perder o estado.
 *
 * Sem variáveis, usa o GitLab falso de `fake-gitlab.ts` (pipeline real com `npm test`). Para um
 * projeto de sandbox seu, defina:
 *   AGENT_CANVAS_E2E_GITLAB_URL   ex.: https://gitlab.com
 *   AGENT_CANVAS_E2E_GITLAB_TOKEN token com escopo api (só do sandbox)
 *   AGENT_CANVAS_E2E_PROJECT_ID   id do projeto de sandbox
 *   AGENT_CANVAS_E2E_ISSUE_IID    uma issue aberta do projeto
 *   AGENT_CANVAS_E2E_REPOS_DIR    pasta com um clone do projeto (o push usa as suas credenciais git)
 * O "agente" é um roteiro (sem gastar o Claude): commita um arquivo novo e abre o MR. No fim, o
 * MR é fechado e o branch apagado no sandbox.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type {
  Issue,
  IssueComment,
  MergeRequest,
  ServerMessage,
  SettingsView,
  StateSnapshot,
} from '@agent-canvas/shared';
import type { AgentProcess, AgentRunner, RunnerHandlers, RunnerStartOptions } from '../src/agents/runner.ts';
import { GitbeakerClient } from '../src/gitlab/gitbeaker-client.ts';
import { makeBridge } from '../src/test-utils.ts';
import { startFakeGitLab } from './fake-gitlab.ts';

const env = process.env;
const REAL = !!env.AGENT_CANVAS_E2E_GITLAB_URL;
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=e2e@agent-canvas', '-c', 'user.name=Agent Canvas E2E', ...a], {
    cwd,
    stdio: 'pipe',
  })
    .toString()
    .trim();

/** O "agente": commita um arquivo e abre o MR pela ferramenta do canvas, como o claude faria. */
class ScriptRunner implements AgentRunner {
  tool: { text: string; isError: boolean } | null = null;
  start(opts: RunnerStartOptions, h: RunnerHandlers): AgentProcess {
    let alive = true;
    const exit = () => {
      if (alive) {
        alive = false;
        setTimeout(() => h.onExit({ code: 0, signal: null, stderr: '' }), 5);
      }
    };
    return {
      send: () =>
        void (async () => {
          h.onLine(
            JSON.stringify({
              type: 'system',
              subtype: 'init',
              session_id: opts.sessionId,
              model: 'roteiro',
              cwd: opts.cwd,
            }),
          );
          const file = `agent-canvas-e2e-${Date.now()}.md`;
          writeFileSync(
            join(opts.cwd, file),
            '# Teste ponta a ponta do Agent Canvas\n\nPode fechar este MR.\n',
          );
          git(opts.cwd, 'add', file);
          git(opts.cwd, 'commit', '-qm', 'Teste ponta a ponta do Agent Canvas');
          this.tool = await callTool(opts, 'open_merge_request', {
            title: '[agent-canvas e2e] Teste ponta a ponta',
            description: 'MR aberto pelo teste ponta a ponta do Agent Canvas. Pode fechar.',
          });
          h.onLine(
            JSON.stringify({
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: this.tool.text,
              session_id: opts.sessionId,
              usage: {},
            }),
          );
        })(),
      interrupt: () => {},
      endInput: exit,
      kill: exit,
    };
  }
}

async function callTool(opts: RunnerStartOptions, name: string, args: Record<string, unknown>) {
  const srv = JSON.parse(readFileSync(opts.mcpConfigPath, 'utf8')).mcpServers.canvas;
  const client = new Client({ name: 'e2e', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(srv.url), {
    requestInit: { headers: srv.headers },
  });
  transport.onerror = () => {};
  await client.connect(transport);
  const res = await client.callTool({ name, arguments: args });
  await client.close().catch(() => {});
  return { text: (res.content as { text: string }[])[0]!.text, isError: !!res.isError };
}

describe(`ponta a ponta com ${REAL ? 'o GitLab de sandbox' : 'o GitLab falso'}`, { timeout: 600_000 }, () => {
  let cfg: { url: string; token: string; projectId: number; issueIid: number; reposDir: string };
  let fake: Awaited<ReturnType<typeof startFakeGitLab>> | null = null;
  const tmp: string[] = [];
  const home = mkdtempSync(join(tmpdir(), 'ac-e2e-home-'));
  tmp.push(home);
  let port = 4960;
  let opened: MergeRequest | null = null;

  beforeAll(async () => {
    if (REAL) {
      const need = ['GITLAB_TOKEN', 'PROJECT_ID', 'ISSUE_IID', 'REPOS_DIR'].filter(
        (k) => !env[`AGENT_CANVAS_E2E_${k}`],
      );
      if (need.length)
        throw new Error(`Faltam variáveis: ${need.map((k) => `AGENT_CANVAS_E2E_${k}`).join(', ')}`);
      cfg = {
        url: env.AGENT_CANVAS_E2E_GITLAB_URL!,
        token: env.AGENT_CANVAS_E2E_GITLAB_TOKEN!,
        projectId: Number(env.AGENT_CANVAS_E2E_PROJECT_ID),
        issueIid: Number(env.AGENT_CANVAS_E2E_ISSUE_IID),
        reposDir: env.AGENT_CANVAS_E2E_REPOS_DIR!,
      };
      return;
    }
    // remoto bare em .../acme/billing.git e um clone em reposDir, com um teste que passa
    const root = mkdtempSync(join(tmpdir(), 'ac-e2e-gitlab-'));
    tmp.push(root);
    const origin = join(root, 'remotes', 'acme', 'billing.git');
    const reposDir = join(root, 'repos');
    const clone = join(reposDir, 'billing');
    mkdirSync(join(clone, 'test'), { recursive: true });
    writeFileSync(
      join(clone, 'package.json'),
      '{ "name": "billing", "type": "module", "scripts": { "test": "node --test" } }\n',
    );
    writeFileSync(
      join(clone, 'test', 'ok.test.js'),
      "import { test } from 'node:test';\ntest('ok', () => {});\n",
    );
    git(clone, 'init', '-q', '-b', 'main');
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'inicial');
    mkdirSync(join(root, 'remotes', 'acme'), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', clone, origin]);
    git(clone, 'remote', 'add', 'origin', origin);
    git(clone, 'fetch', '-q', 'origin');
    const token = 'glpat-e2e-falso-0000';
    fake = await startFakeGitLab({
      token,
      projects: [
        {
          id: 21,
          name: 'billing',
          path: 'acme/billing',
          origin,
          issues: [{ iid: 7, title: 'Desconto percentual na cobrança', description: 'Teste ponta a ponta.' }],
        },
      ],
    });
    cfg = { url: fake.url, token, projectId: 21, issueIid: 7, reposDir };
  });

  afterAll(async () => {
    if (REAL && opened) {
      // limpa o sandbox: fecha o MR e apaga o branch
      const api = `${cfg.url.replace(/\/$/, '')}/api/v4/projects/${cfg.projectId}`;
      const headers = { 'private-token': cfg.token, 'content-type': 'application/json' };
      await fetch(`${api}/merge_requests/${opened.iid}`, {
        method: 'PUT',
        headers,
        body: '{"state_event":"close"}',
      });
      await fetch(`${api}/repository/branches/${encodeURIComponent(opened.sourceBranch)}`, {
        method: 'DELETE',
        headers,
      });
    }
    await fake?.close();
    for (const d of tmp) rmSync(d, { recursive: true, force: true });
  });

  async function boot(runner: AgentRunner) {
    port++;
    const b = await makeBridge((url, token) => new GitbeakerClient(url, token), runner, port, { home });
    return b;
  }
  async function connect(b: Awaited<ReturnType<typeof boot>>) {
    await b.app.listen({ host: '127.0.0.1', port });
    const msgs: ServerMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${b.session.token}`, {
      origin: 'http://localhost:5173',
    });
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    return { ws, msgs };
  }
  async function until<T>(
    fn: () => T | undefined | false | Promise<T | undefined | false>,
    what: string,
    ms = 60_000,
  ) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`esperando ${what}`);
  }

  it('configura, abre o MR pelo agente, acompanha o pipeline, comenta e sobrevive ao reinício', async () => {
    const runner = new ScriptRunner();
    const b = await boot(runner);
    const h = b.headers;
    const ref = `${cfg.projectId}#${cfg.issueIid}`;

    // 1. token validado no GitLab (GET /user), projeto escolhido, clone achado pelo remoto
    const saved = await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: h,
      payload: { mode: 'gitlab', baseUrl: cfg.url, token: cfg.token, reposDir: cfg.reposDir },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((saved.json() as SettingsView).user).toBeTruthy();
    const chosen = (
      await b.app.inject({
        method: 'PUT',
        url: '/api/settings/projects',
        headers: h,
        payload: { projectIds: [cfg.projectId] },
      })
    ).json() as SettingsView;
    expect(
      chosen.clones.find((c) => c.projectId === cfg.projectId)?.path,
      'clone local do projeto',
    ).toBeTruthy();

    // 2. a issue vem do GitLab
    const { issues } = (await b.app.inject({ url: '/api/gitlab/issues', headers: h })).json() as {
      issues: Issue[];
    };
    expect(issues.map((i) => i.ref)).toContain(ref);

    // 3. o agente abre o MR: push do branch e MR ligado à issue
    const { ws, msgs } = await connect(b);
    const send = (m: object) => ws.send(JSON.stringify(m));
    send({ type: 'issue.place', nodeId: 'n-issue', issueRef: ref, x: 0, y: 0 });
    send({
      type: 'agent.create',
      agentId: 'a-e2e',
      nodeId: 'n-agent',
      edgeId: 'e-agent',
      issueRef: ref,
      repos: [],
      instruction: 'Teste ponta a ponta.',
      openMr: true,
      x: 0,
      y: 320,
    });
    const lastMr = () =>
      msgs.flatMap((m) => (m.type === 'mr.upsert' ? [m.mr] : [])).at(-1) as MergeRequest | undefined;
    opened = await until(() => lastMr(), 'MR aberto');
    expect(runner.tool, runner.tool?.text).toMatchObject({ isError: false });
    expect(opened.description).toContain(`#${cfg.issueIid}`);
    const clone = chosen.clones.find((c) => c.projectId === cfg.projectId)!.path!;
    expect(git(clone, 'ls-remote', 'origin', opened.sourceBranch)).toContain(opened.sourceBranch);

    // 4. o pipeline sai de "rodando" (o sandbox pode não ter CI: "none")
    const settled = await until(
      async () => {
        send({ type: 'mr.refresh', mrRef: opened!.ref });
        await new Promise((r) => setTimeout(r, 1500));
        const m = lastMr();
        return m && !['running', 'pending', 'created'].includes(m.pipelineStatus) && m;
      },
      'pipeline terminar',
      300_000,
    );
    expect(['success', 'failed', 'canceled', 'skipped', 'none', 'manual']).toContain(settled.pipelineStatus);
    if (!REAL) expect(settled.pipelineStatus).toBe('success');

    // 5. diff e discussão pelo GitLab
    const diff = (
      await b.app.inject({ url: `/api/mrs/${encodeURIComponent(opened.ref)}/diff`, headers: h })
    ).json() as {
      newPath: string;
    }[];
    expect(diff.some((f) => f.newPath.startsWith('agent-canvas-e2e-'))).toBe(true);
    send({ type: 'mr.comment', mrRef: opened.ref, body: 'Comentário do teste ponta a ponta.' });
    await until(async () => {
      const list = (
        await b.app.inject({ url: `/api/mrs/${encodeURIComponent(opened!.ref)}/comments`, headers: h })
      ).json() as IssueComment[];
      return list.some((c) => c.body.includes('Comentário do teste ponta a ponta.'));
    }, 'comentário no MR');
    await until(
      () =>
        msgs.some((m) => m.type === 'agent.upsert' && m.agent.id === 'a-e2e' && m.agent.status === 'done'),
      'agente concluir',
    );

    // 6. o bridge cai e sobe de novo: canvas, MR, agente e histórico continuam
    ws.terminate();
    await b.cleanup();
    const b2 = await boot(new ScriptRunner());
    const state = (await b2.app.inject({ url: '/api/state', headers: b2.headers })).json() as StateSnapshot;
    expect(state.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['n-issue', 'n-agent']));
    expect(state.nodes.some((n) => n.type === 'mr' && n.refId === opened!.ref)).toBe(true);
    expect(state.mergeRequests.map((m) => m.ref)).toContain(opened.ref);
    expect(state.agents.find((a) => a.id === 'a-e2e')).toMatchObject({
      status: 'done',
      branch: opened.sourceBranch,
    });
    expect(state.agentEvents.some((e) => e.agentId === 'a-e2e' && e.body.kind === 'result')).toBe(true);
    await b2.cleanup();
  });
});
