import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { HEAVY_ITEM_TOKENS, type AgentContext, type ServerMessage } from '@agent-canvas/shared';
import type { AgentProcess, AgentRunner, RunnerHandlers, RunnerStartOptions } from '../agents/runner.ts';
import { MockGitLabClient } from '../gitlab/mock-client.ts';
import { makeBridge } from '../test-utils.ts';
import { excerptLog } from './job-log.ts';
import { citedPaths } from './context-service.ts';

const TEST_PORT = 4996;
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...a], { cwd, stdio: 'pipe' });

/** Runner falso: guarda as mensagens recebidas; o turno termina quando o teste manda. */
class HoldRunner implements AgentRunner {
  starts: RunnerStartOptions[] = [];
  sent: string[] = [];
  h: RunnerHandlers | null = null;
  start(opts: RunnerStartOptions, h: RunnerHandlers): AgentProcess {
    this.starts.push(opts);
    this.h = h;
    let alive = true;
    const exit = () => {
      if (alive) {
        alive = false;
        setTimeout(() => h.onExit({ code: 0, signal: null, stderr: '' }), 5);
      }
    };
    h.onLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: opts.sessionId,
        model: 'f',
        cwd: opts.cwd,
      }),
    );
    return { send: (t) => this.sent.push(t), interrupt: () => {}, endInput: exit, kill: exit };
  }
}

describe('contexto dos agentes', () => {
  let b: Awaited<ReturnType<typeof makeBridge>>;
  let runner: HoldRunner;
  let ws: WebSocket;
  let msgs: ServerMessage[];
  let summaries: string[];
  const send = (m: object) => ws.send(JSON.stringify(m));
  async function until<T>(fn: () => T | undefined | false | null, what: string): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`esperando ${what}; mensagens: ${msgs.map((m) => m.type).join(', ')}`);
  }
  const ctx = async (id = 'a1') =>
    (await b.app.inject({ url: `/api/agents/${id}/context`, headers: b.headers })).json() as AgentContext;
  const lastCtx = () =>
    msgs
      .filter((m): m is Extract<ServerMessage, { type: 'context.updated' }> => m.type === 'context.updated')
      .at(-1)?.context;

  beforeEach(async () => {
    runner = new HoldRunner();
    summaries = [];
    const client = new MockGitLabClient({ pipelineMs: 0, pipelineFails: true });
    b = await makeBridge(() => client, runner, TEST_PORT, {
      summarizer: {
        summarize: async ({ label, text }) => {
          summaries.push(label);
          return `Resumo de ${label}: 1 teste falhou em test/webhooks.spec.ts (${text.length} caracteres antes).`;
        },
      },
    });
    const reposDir = mkdtempSync(join(tmpdir(), 'ac-ctx-'));
    const repo = join(reposDir, 'payments-api');
    mkdirSync(join(repo, 'src', 'webhooks'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# payments-api\n\nAPI de pagamentos.\n');
    writeFileSync(join(repo, 'CLAUDE.md'), 'Rode npm test antes de commitar.\n');
    writeFileSync(join(repo, 'src', 'webhooks', 'handler.ts'), 'export function handle() {}\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'inicial');
    const origin = join(reposDir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    const h = b.headers;
    await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: h,
      payload: { mode: 'gitlab', baseUrl: 'https://gitlab.example.com', token: 'glpat-teste-1', reposDir },
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
    // nota ligada à issue: entra no contexto de todo agente da issue
    send({
      type: 'note.create',
      nodeId: 'n-note',
      note: { id: 't1', title: 'Regra', body: 'Use event_id.' },
      x: 300,
      y: 0,
    });
    send({ type: 'note.link', edgeId: 'e-note', noteId: 't1', targetNodeId: 'n-issue' });
    // agente da issue, ainda sem instrução: o medidor já estima
    send({
      type: 'agent.create',
      agentId: 'a1',
      nodeId: 'n-a1',
      edgeId: 'e-a1',
      issueRef: '101#142',
      repos: [],
      x: 0,
      y: 300,
    });
    await until(() => msgs.some((m) => m.type === 'agent.upsert'), 'agente');
  });
  afterEach(async () => {
    ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    await b.cleanup();
  });

  it('itens dos vínculos, estimativa antes de rodar e sugestões', async () => {
    const c = await ctx();
    expect(c.items.map((i) => [i.kind, i.source, i.removable])).toEqual([
      ['issue', 'link', false],
      ['repo', 'link', false],
      ['note', 'link', true],
    ]);
    expect(c.items.every((i) => i.tokens > 0 && !i.error)).toBe(true);
    expect(c.totalTokens).toBeGreaterThan(c.items.reduce((s, i) => s + i.tokens, 0) - 1);
    expect(c.budget).toBe(60_000);
    // o arquivo citado na descrição da issue existe no repositório
    expect(c.suggestions).toContainEqual(
      expect.objectContaining({ kind: 'file', ref: 'src/webhooks/handler.ts', why: 'citado na issue' }),
    );
  });

  it('adicionar arquivo, tirar nota da issue só deste agente e o context.md ao começar', async () => {
    send({ type: 'context.add', agentId: 'a1', kind: 'file', ref: 'src/webhooks/handler.ts' });
    await until(() => lastCtx()?.items.some((i) => i.kind === 'file'), 'arquivo no contexto');
    send({ type: 'context.remove', agentId: 'a1', itemId: 'note:t1' });
    await until(() => lastCtx() && !lastCtx()!.items.some((i) => i.kind === 'note'), 'nota fora');
    // a nota foi para as sugestões ("ligada à issue")
    expect(lastCtx()!.suggestions).toContainEqual(expect.objectContaining({ kind: 'note', ref: 't1' }));
    // não dá para tirar a issue do agente
    send({ type: 'context.remove', agentId: 'a1', itemId: 'issue:101#142' });
    await until(
      () => msgs.some((m) => m.type === 'error' && /não saem do contexto/.test(m.message)),
      'recusa',
    );
    // arquivo de fora do repositório é recusado
    send({ type: 'context.add', agentId: 'a1', kind: 'file', ref: '../../etc/passwd' });
    await until(
      () => msgs.some((m) => m.type === 'error' && /Caminho inválido/.test(m.message)),
      'recusa do caminho',
    );

    send({ type: 'agent.message', agentId: 'a1', text: 'Resolva.' });
    await until(() => runner.starts.length === 1, 'início');
    const md = readFileSync(join(runner.starts[0]!.cwd, '.agent-canvas', 'context.md'), 'utf8');
    expect(md).toContain('## Issue #142');
    expect(md).toContain('## Repositório grupo/payments-api (índice) (dados)');
    expect(md).toContain('Rode npm test antes de commitar.'); // CLAUDE.md no índice
    expect(md).toContain('## Arquivo src/webhooks/handler.ts (dados)');
    expect(md).not.toContain('Use event_id.');
    expect(md).toContain('chame `write_note`');
  });

  it('log do pipeline: trecho do erro, Resumir reduz os tokens e desfazer volta ao completo', async () => {
    // MR do agente com o pipeline falhando
    send({ type: 'agent.message', agentId: 'a1', text: 'Resolva.' });
    await until(() => runner.starts.length === 1, 'início');
    const wt = runner.starts[0]!.cwd;
    writeFileSync(join(wt, 'x.ts'), 'x\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'x');
    // abre o MR pelo mesmo caminho da ferramenta do agente
    const srv = JSON.parse(readFileSync(runner.starts[0]!.mcpConfigPath, 'utf8')).mcpServers.canvas;
    const client = new Client({ name: 'fake-claude', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(srv.url), {
      requestInit: { headers: srv.headers },
    });
    transport.onerror = () => {};
    await client.connect(transport);
    const res = await client.callTool({ name: 'open_merge_request', arguments: { title: 'Fix' } });
    await client.close();
    expect(JSON.stringify(res.content)).toContain('aberto');
    const mr = await until(
      () => msgs.find((m): m is Extract<ServerMessage, { type: 'mr.upsert' }> => m.type === 'mr.upsert')?.mr,
      'MR',
    );
    send({ type: 'mr.refresh', mrRef: mr.ref });
    await until(
      () => msgs.some((m) => m.type === 'mr.upsert' && m.mr.pipelineStatus === 'failed'),
      'pipeline falhou',
    );
    let c = await ctx();
    expect(c.suggestions).toContainEqual(expect.objectContaining({ kind: 'pipeline_log', ref: mr.ref }));

    send({ type: 'context.add', agentId: 'a1', kind: 'pipeline_log', ref: mr.ref });
    const log = await until(() => lastCtx()?.items.find((i) => i.kind === 'pipeline_log'), 'log no contexto');
    expect(log.tokens).toBeGreaterThanOrEqual(HEAVY_ITEM_TOKENS);
    const before = lastCtx()!.totalTokens;

    send({ type: 'context.summarize', agentId: 'a1', itemId: log.id });
    const after = await until(
      () => lastCtx()?.items.find((i) => i.kind === 'pipeline_log' && i.summarized),
      'resumo',
    );
    expect(summaries).toEqual([`log do pipeline !${mr.iid}`]);
    expect(after.tokens).toBeLessThan(log.tokens / 10);
    expect(after.fullTokens).toBe(log.tokens);
    expect(lastCtx()!.totalTokens).toBeLessThan(before - log.tokens / 2);
    // o agente rodando é avisado e o context.md já tem o resumo
    await until(
      () => runner.sent.some((t) => t.includes('O contexto foi atualizado') && t.includes('resumo de log')),
      'aviso',
    );
    expect(readFileSync(join(wt, '.agent-canvas', 'context.md'), 'utf8')).toContain(
      '## Log do pipeline do MR',
    );

    send({ type: 'context.unsummarize', agentId: 'a1', itemId: log.id });
    c = await until(
      () => lastCtx()?.items.some((i) => i.kind === 'pipeline_log' && !i.summarized) && lastCtx(),
      'desfazer',
    );
    expect(c.items.find((i) => i.kind === 'pipeline_log')!.tokens).toBe(log.tokens);
  });

  it('editar a nota ligada com o agente rodando: context.md novo e pedido de releitura', async () => {
    send({ type: 'agent.message', agentId: 'a1', text: 'Resolva.' });
    await until(() => runner.starts.length === 1, 'início');
    const wt = runner.starts[0]!.cwd;
    expect(readFileSync(join(wt, '.agent-canvas', 'context.md'), 'utf8')).toContain('Use event_id.');
    send({
      type: 'note.update',
      noteId: 't1',
      body: 'Use event_id como chave de idempotência, com TTL de 24h.',
    });
    await until(() => runner.sent.some((t) => t.includes('nota "Regra" editada')), 'aviso ao agente');
    expect(runner.sent.at(-1)).toContain('Releia .agent-canvas/context.md');
    expect(readFileSync(join(wt, '.agent-canvas', 'context.md'), 'utf8')).toContain('TTL de 24h');
    await until(
      () =>
        msgs.some(
          (m) => m.type === 'agent.event' && m.event.body.kind === 'context' && m.event.body.notified,
        ),
      'linha de contexto no terminal',
    );
  });
});

describe('peças do contexto', () => {
  it('caminhos citados num texto', () => {
    expect(
      citedPaths(
        'O erro está em `src/webhooks/handler.ts` e no package.json. Versão 1.2.3, veja https://x.com/a.html',
      ),
    ).toEqual(['src/webhooks/handler.ts', 'package.json']);
  });

  it('log: tira cores e guarda o trecho do erro e o fim', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `linha ${i}`);
    lines[300] = `${String.fromCharCode(27)}[31m✕${String.fromCharCode(27)}[0m falhou: expected 2 to equal 1`;
    const out = excerptLog(lines.join('\n'));
    expect(out).toContain('✕ falhou: expected 2 to equal 1');
    expect(out).not.toContain(String.fromCharCode(27));
    expect(out).toContain('linha 999');
    expect(out).not.toContain('linha 500\n');
    expect(out).toMatch(/linhas omitidas/);
  });
});
