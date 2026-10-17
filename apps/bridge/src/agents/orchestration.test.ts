import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Agent, Question, ServerMessage } from '@agent-canvas/shared';
import { MockGitLabClient } from '../gitlab/mock-client.ts';
import { makeBridge } from '../test-utils.ts';
import type { AgentProcess, AgentRunner, RunnerHandlers, RunnerStartOptions } from './runner.ts';

const TEST_PORT = 4995;
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...a], { cwd, stdio: 'pipe' })
    .toString()
    .trim();
const line = (o: unknown) => JSON.stringify(o);
const init = (sid: string) =>
  line({ type: 'system', subtype: 'init', session_id: sid, model: 'f', cwd: '/w' });
const result = (sid: string, text: string) =>
  line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, usage: {} });

async function callTool(opts: RunnerStartOptions, name: string, args: Record<string, unknown>) {
  const srv = JSON.parse(readFileSync(opts.mcpConfigPath, 'utf8')).mcpServers.canvas;
  const client = new Client({ name: 'fake-claude', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(srv.url), {
    requestInit: { headers: srv.headers },
  });
  transport.onerror = () => {};
  client.onerror = () => {};
  await client.connect(transport);
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  await client.close();
  return { text: (res.content as { text: string }[])[0]!.text, isError: !!res.isError };
}

/** Runner roteirizado por papel: o orquestrador divide, os filhos implementam e abrem MR. */
class ScriptRunner implements AgentRunner {
  starts: RunnerStartOptions[] = [];
  log: string[] = [];
  turn: (opts: RunnerStartOptions, h: RunnerHandlers, text: string) => Promise<void> = async () => {};
  start(opts: RunnerStartOptions, h: RunnerHandlers): AgentProcess {
    this.starts.push(opts);
    let alive = true;
    let busy = false;
    const exit = () => {
      if (alive) {
        alive = false;
        setTimeout(() => h.onExit({ code: 0, signal: null, stderr: '' }), 5);
      }
    };
    return {
      // como o claude, mensagens que chegam durante o turno entram nele; com o processo ocioso,
      // a mensagem seguinte abre outro turno
      send: (text: string) => {
        if (busy) return;
        busy = true;
        void this.turn(opts, h, text)
          .catch((e) => this.log.push(String(e)))
          .finally(() => (busy = false));
      },
      interrupt: () => {},
      endInput: exit,
      kill: exit,
    };
  }
}

describe('orquestração', () => {
  let b: Awaited<ReturnType<typeof makeBridge>>;
  let runner: ScriptRunner;
  let ws: WebSocket;
  let msgs: ServerMessage[];
  let reposDir: string;
  const send = (m: object) => ws.send(JSON.stringify(m));
  async function until<T>(fn: () => T | undefined | false | null, what: string, tries = 600): Promise<T> {
    for (let i = 0; i < tries; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `esperando ${what}; log: ${runner.log.join(' | ')}; msgs: ${msgs
        .map((m) => m.type)
        .slice(-30)
        .join(', ')}`,
    );
  }
  const agents = () => {
    const out = new Map<string, Agent>();
    for (const m of msgs) if (m.type === 'agent.upsert') out.set(m.agent.id, m.agent);
    return [...out.values()];
  };
  const byName = (n: string) => agents().find((a) => a.name === n);

  beforeEach(async () => {
    runner = new ScriptRunner();
    const client = new MockGitLabClient({ pipelineMs: 50 });
    // um agente rodando por vez: o orquestrador coordenando não conta, os filhos vão pela fila
    b = await makeBridge(() => client, runner, TEST_PORT, { limits: { maxRunning: 1 } });
    reposDir = mkdtempSync(join(tmpdir(), 'ac-orq-'));
    for (const name of ['payments-api', 'web-app']) {
      const repo = join(reposDir, name);
      mkdirSync(repo);
      writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'inicial');
      const origin = join(reposDir, `${name}.git`);
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      git(repo, 'remote', 'add', 'origin', origin);
      git(repo, 'push', '-q', 'origin', 'main');
    }
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
      payload: { projectIds: [101, 102] },
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
    send({
      type: 'note.create',
      nodeId: 'n-note',
      note: { id: 't1', title: 'Contrato', body: 'Campo idempotencyKey.' },
      x: 400,
      y: 0,
    });
  });
  afterEach(async () => {
    ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    await b.cleanup();
  });

  it('issue com dois repositórios: orquestrador, plano, dois agentes na fila, dois MRs e o resumo na issue', async () => {
    const res: Record<string, { text: string; isError: boolean }> = {};
    let question: Promise<{ text: string; isError: boolean }> | null = null;
    runner.turn = async (opts, h) => {
      h.onLine(init(opts.sessionId));
      if (opts.appendSystemPrompt.includes('Você é o orquestrador')) {
        res.plan = await callTool(opts, 'report_plan', {
          items: [
            { text: 'payments-api: chave de idempotência' },
            { text: 'web-app: mandar a chave' },
            { text: 'Comentar o resumo na issue' },
          ],
        });
        // a nota ligada ao orquestrador é herdada pelos filhos
        send({ type: 'note.link', edgeId: 'e-n', noteId: 't1', targetNodeId: agentNode('agente-1') });
        await new Promise((r) => setTimeout(r, 30));
        res.spawn1 = await callTool(opts, 'spawn_agent', {
          repo: 'payments-api',
          task: 'Implementar a chave de idempotência no webhook.',
        });
        res.spawn2 = await callTool(opts, 'spawn_agent', {
          repo: 'grupo/web-app',
          task: 'Mandar a chave no checkout.',
        });
        res.badRepo = await callTool(opts, 'spawn_agent', { repo: 'shared-contracts', task: 'x' });
        res.wait = await callTool(opts, 'wait_for_agents', {});
        // no fim o orquestrador reescreve o plano com textos novos
        res.plan2 = await callTool(opts, 'report_plan', {
          items: [
            { text: 'payments-api: chave pronta (MR aberto)', done: true },
            { text: 'web-app: chave enviada (MR aberto)', done: true },
            { text: 'Comentar o resumo na issue', done: true },
          ],
        });
        res.comment = await callTool(opts, 'comment_issue', {
          body: 'Resumo: dois MRs. Ordem: payments-api, depois web-app.',
        });
        h.onLine(result(opts.sessionId, 'Feito.'));
        return;
      }
      // filho: commit, MR e (no web-app) uma pergunta e uma tentativa de neto
      const name = opts.cwd.includes(agentId('agente-2')) ? 'agente-2' : 'agente-3';
      writeFileSync(join(opts.cwd, `${name}.txt`), 'x\n');
      git(opts.cwd, 'add', '.');
      git(opts.cwd, 'commit', '-qm', name);
      if (name === 'agente-3') {
        res.grandchild = await callTool(opts, 'spawn_agent', { repo: 'web-app', task: 'testes' });
        question = callTool(opts, 'ask_human', { question: 'Botão ou link?', options: ['Botão', 'Link'] });
        res.answer = await question;
      }
      // o agente do web-app escreve "Closes #142" por conta própria (fecharia a issue errada)
      res[`mr-${name}`] = await callTool(opts, 'open_merge_request', {
        title: `MR ${name}`,
        ...(name === 'agente-3' ? { description: 'Moeda no checkout.\n\nCloses #142' } : {}),
      });
      h.onLine(result(opts.sessionId, `${name} terminou.`));
    };
    const agentNode = (n: string) =>
      msgs.find(
        (m): m is Extract<ServerMessage, { type: 'node.upsert' }> =>
          m.type === 'node.upsert' && m.node.refId === byName(n)?.id,
      )!.node.id;
    const agentId = (n: string) => byName(n)?.id ?? '???';

    send({
      type: 'agent.create',
      agentId: 'a1',
      nodeId: 'n-a1',
      edgeId: 'e-a1',
      issueRef: '101#142',
      repos: [101, 102],
      instruction: 'Resolva.',
      maxDepth: 1,
      openMr: true,
      x: 0,
      y: 300,
    });

    // orquestrador: pasta própria (não é git) e leitura dos dois clones
    await until(() => runner.starts.length >= 1, 'orquestrador');
    const o = runner.starts[0]!;
    expect(byName('agente-1')).toMatchObject({ role: 'orchestrator', depth: 0, maxDepth: 1 });
    expect(existsSync(join(o.cwd, '.git'))).toBe(false);
    expect(o.addDirs).toEqual([join(reposDir, 'payments-api'), join(reposDir, 'web-app')]);
    const octx = readFileSync(join(o.cwd, '.agent-canvas', 'context.md'), 'utf8');
    expect(octx).toContain('## Repositório grupo/payments-api (índice)');
    expect(octx).toContain('## Repositório grupo/web-app (índice)');
    expect(octx).toContain('Você pode criar sub-agentes');

    // o segundo filho espera na fila até o primeiro terminar
    await until(() => byName('agente-3')?.status === 'queued' || res.wait, 'fila', 1000);

    // a pergunta do agente-3 vai para a caixa de Ações
    const q = await until(
      () =>
        msgs.find(
          (m): m is Extract<ServerMessage, { type: 'question.upsert' }> =>
            m.type === 'question.upsert' && m.question.status === 'pending',
        )?.question as Question | undefined,
      'pergunta',
      1500,
    );
    expect(q).toMatchObject({ text: 'Botão ou link?', options: ['Botão', 'Link'] });
    await until(() => byName('agente-3')?.status === 'waiting', 'aguardando resposta');
    send({ type: 'question.answer', questionId: q.id, answer: 'Botão' });

    await until(() => res.comment, 'comentário do orquestrador', 1500);
    expect(res.plan!.isError).toBe(false);
    expect(res.spawn1!.text).toContain('agente-2 criado para payments-api');
    expect(res.badRepo).toMatchObject({ isError: true });
    expect(res.badRepo!.text).toContain('não está entre os escolhidos. Opções: payments-api, web-app');
    expect(res.grandchild).toMatchObject({ isError: true });
    expect(res.grandchild!.text).toContain('Profundidade máxima (1)');
    expect(res.answer!.text).toBe('Botão');
    // resumo da espera: os dois filhos, com branch e MR
    expect(res.wait!.text).toMatch(/## agente-2 \(payments-api\): done[\s\S]*MR !\d+/);
    expect(res.wait!.text).toMatch(/## agente-3 \(web-app\): done[\s\S]*MR !\d+[\s\S]*agente-3 terminou/);
    // o resumo traz o diff de cada filho, para o orquestrador conferir
    expect(res.wait!.text).toContain('Diff (agente-2.txt)');
    expect(res.wait!.text).toContain('+x');
    expect(res.comment!.text).toBe('Comentário publicado na issue.');

    // árvore: filhos com o pai, arestas de spawn, worktrees nos repositórios certos
    const [c1, c2] = [byName('agente-2')!, byName('agente-3')!];
    expect(c1).toMatchObject({ parentId: 'a1', role: 'main', depth: 1, repos: [101] });
    expect(c2).toMatchObject({ parentId: 'a1', role: 'main', depth: 1, repos: [102] });
    expect(msgs.filter((m) => m.type === 'edge.upsert' && m.edge.kind === 'spawn')).toHaveLength(2);
    expect(git(join(reposDir, 'web-app'), 'branch', '--list', c2.branch!)).toContain(c2.branch!);
    // contexto do filho: o plano do pai e a nota herdada
    const cctx = readFileSync(join(c2.worktreePath!, '.agent-canvas', 'context.md'), 'utf8');
    expect(cctx).toContain('## Plano de agente-1, que criou você');
    expect(cctx).toContain('Campo idempotencyKey.');
    expect(cctx).toContain('Você não pode criar sub-agentes');
    expect(cctx).not.toContain('chame `write_note`'); // passagem só na raiz
    // plano: passos ligados aos filhos e marcados quando terminaram
    // depois de reescrito, o plano continua ligado aos filhos pelo repositório citado
    const plan = byName('agente-1')!.plan!;
    expect(plan.slice(0, 2)).toEqual([
      { text: 'payments-api: chave pronta (MR aberto)', done: true, agentId: c1.id },
      { text: 'web-app: chave enviada (MR aberto)', done: true, agentId: c2.id },
    ]);
    // MR do web-app fecha a issue de outro projeto com a referência completa
    const mrs = msgs
      .filter((m): m is Extract<ServerMessage, { type: 'mr.upsert' }> => m.type === 'mr.upsert')
      .map((m) => m.mr);
    const webMr = mrs.find((m) => m.projectId === 102)!;
    expect(webMr.description).toContain('Closes grupo/payments-api#142');
    expect(webMr.description).not.toMatch(/Closes #142/);
    expect(mrs.find((m) => m.projectId === 101)!.description).toContain('Closes #142');
    await until(() => byName('agente-1')?.status === 'done', 'orquestrador concluído');
  }, 30_000);

  it('sub-agente no mesmo repositório: branch a partir do branch do pai, sem MR próprio', async () => {
    let spawned = '';
    let waited = '';
    runner.turn = async (opts, h) => {
      h.onLine(init(opts.sessionId));
      if (opts.cwd.endsWith('a1')) {
        writeFileSync(join(opts.cwd, 'pai.txt'), 'pai\n');
        git(opts.cwd, 'add', '.');
        git(opts.cwd, 'commit', '-qm', 'pai');
        spawned = (await callTool(opts, 'spawn_agent', { repo: 'payments-api', task: 'Escrever os testes.' }))
          .text;
        waited = (await callTool(opts, 'wait_for_agents', {})).text;
        h.onLine(result(opts.sessionId, 'ok'));
        return;
      }
      // o filho vê o commit do pai
      expect(readFileSync(join(opts.cwd, 'pai.txt'), 'utf8').trim()).toBe('pai');
      writeFileSync(join(opts.cwd, 'testes.txt'), 't\n');
      git(opts.cwd, 'add', '.');
      git(opts.cwd, 'commit', '-qm', 'testes');
      h.onLine(result(opts.sessionId, 'testes prontos'));
    };
    send({
      type: 'agent.create',
      agentId: 'a1',
      nodeId: 'n-a1',
      issueRef: '101#142',
      repos: [],
      instruction: 'Resolva.',
      maxDepth: 1,
      openMr: true,
      x: 0,
      y: 300,
    });
    await until(() => waited, 'espera do pai', 1500);
    const parent = byName('agente-1')!;
    const sub = byName('agente-2')!;
    expect(parent.role).toBe('main');
    expect(sub).toMatchObject({ role: 'sub', parentId: 'a1', openMr: false, depth: 1 });
    expect(sub.branch!.startsWith(`${parent.branch}-`)).toBe(true);
    expect(spawned).toContain('agente-2 criado para payments-api');
    expect(waited).toContain(`Branch: ${sub.branch}`);
    expect(waited).toContain('testes prontos');
    // o pai consegue juntar o branch do filho (mesmo repositório)
    git(parent.worktreePath!, 'merge', '-q', '--no-edit', sub.branch!);
    expect(existsSync(join(parent.worktreePath!, 'testes.txt'))).toBe(true);
  }, 30_000);

  it('explorador só lê, list_agents, wait_for_agents "any" e message_agent no mesmo filho', async () => {
    const res: Record<string, { text: string; isError: boolean }> = {};
    const explorerTexts: string[] = [];
    runner.turn = async (opts, h, text) => {
      h.onLine(init(opts.sessionId));
      if (opts.cwd.endsWith('a1')) {
        res.explore = await callTool(opts, 'spawn_agent', {
          kind: 'explore',
          model: 'haiku',
          task: 'Onde fica o README?',
        });
        res.code = await callTool(opts, 'spawn_agent', { task: 'Escrever os testes.' });
        res.list = await callTool(opts, 'list_agents', {});
        res.any = await callTool(opts, 'wait_for_agents', { mode: 'any' });
        res.message = await callTool(opts, 'message_agent', { agent: 'agente-2', text: 'E a licença?' });
        res.notMine = await callTool(opts, 'message_agent', { agent: 'agente-9', text: 'oi' });
        res.all = await callTool(opts, 'wait_for_agents', {});
        res.none = await callTool(opts, 'wait_for_agents', { mode: 'any' });
        h.onLine(result(opts.sessionId, 'ok'));
        return;
      }
      if (opts.disallowedTools.includes('Edit')) {
        explorerTexts.push(text);
        h.onLine(result(opts.sessionId, explorerTexts.length === 1 ? 'README.md:1' : 'Sem licença.'));
        return;
      }
      writeFileSync(join(opts.cwd, 'testes.txt'), 't\n');
      git(opts.cwd, 'add', '.');
      git(opts.cwd, 'commit', '-qm', 'testes');
      h.onLine(result(opts.sessionId, 'testes prontos'));
    };
    send({
      type: 'agent.create',
      agentId: 'a1',
      nodeId: 'n-a1',
      issueRef: '101#142',
      repos: [],
      instruction: 'Resolva.',
      maxDepth: 1,
      openMr: true,
      x: 0,
      y: 300,
    });
    await until(() => res.none, 'fim do pai', 2000);
    const parent = byName('agente-1')!;
    const explorer = byName('agente-2')!;
    // explorador: pasta própria, lê o worktree do pai, sem editar, sem branch nem MR, modelo escolhido
    expect(explorer).toMatchObject({
      role: 'explorer',
      branch: null,
      openMr: false,
      model: 'haiku',
      maxDepth: 1,
    });
    const eStart = runner.starts.find((s) => s.cwd === explorer.worktreePath)!;
    expect(existsSync(join(eStart.cwd, '.git'))).toBe(false);
    expect(eStart.addDirs).toEqual([parent.worktreePath]);
    expect(eStart.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write']));
    expect(eStart.model).toBe('haiku');
    expect(res.explore!.text).toContain('agente-2 criado para investigar');
    // sem repo: o mesmo do pai, como sub-agente
    expect(byName('agente-3')).toMatchObject({ role: 'sub', repos: [101] });
    expect(res.list!.text).toMatch(/agente-2 \[explore, payments-api, haiku\]/);
    expect(res.list!.text).toMatch(/agente-3 \[code, payments-api\]/);
    // "any": volta com o primeiro e diz quem ainda trabalha
    expect(res.any!.text).toContain('## agente-2 (explore, payments-api): done');
    expect(res.any!.text).toContain('README.md:1');
    expect(res.any!.text).toContain('Ainda trabalhando: agente-3');
    // a mensagem continua a sessão do explorador
    expect(res.message!.isError).toBe(false);
    expect(explorerTexts[1]).toContain('Mensagem de agente-1');
    expect(explorerTexts[1]).toContain('E a licença?');
    expect(res.notMine).toMatchObject({ isError: true });
    expect(res.all!.text).toContain('Sem licença.');
    expect(res.all!.text).toContain('testes prontos');
    expect(res.none!.text).toContain('já recebeu o de todos');
    // a mensagem do pai aparece no terminal do filho com o remetente
    expect(
      msgs.some(
        (m) =>
          m.type === 'agent.event' &&
          m.event.agentId === explorer.id &&
          m.event.body.kind === 'user_message' &&
          m.event.body.from === 'agente-1',
      ),
    ).toBe(true);
  }, 30_000);

  it('limite de filhos, resumo automático ao pai que não esperou e stop_agent', async () => {
    await b.app.inject({
      method: 'PUT',
      url: '/api/settings/agents',
      headers: b.headers,
      payload: { maxChildren: 1 },
    });
    const res: Record<string, { text: string; isError: boolean }> = {};
    const parentTexts: string[] = [];
    runner.turn = async (opts, h, text) => {
      h.onLine(init(opts.sessionId));
      if (opts.cwd.endsWith('a1')) {
        parentTexts.push(text);
        if (parentTexts.length === 1) {
          res.first = await callTool(opts, 'spawn_agent', { task: 'Parte A.' });
          res.over = await callTool(opts, 'spawn_agent', { task: 'Parte B.' });
          // termina o turno sem esperar: o resumo chega sozinho
          h.onLine(result(opts.sessionId, 'esperando os filhos'));
          return;
        }
        res.extra = await callTool(opts, 'spawn_agent', { task: 'Parte inútil.' });
        res.stop = await callTool(opts, 'stop_agent', { agent: 'agente-3', reason: 'não precisa mais' });
        h.onLine(result(opts.sessionId, 'fim'));
        return;
      }
      h.onLine(result(opts.sessionId, 'parte A pronta'));
    };
    send({
      type: 'agent.create',
      agentId: 'a1',
      nodeId: 'n-a1',
      issueRef: '101#142',
      repos: [],
      instruction: 'Resolva.',
      maxDepth: 1,
      openMr: true,
      x: 0,
      y: 300,
    });
    await until(() => res.stop, 'stop_agent', 2000);
    expect(res.first!.isError).toBe(false);
    expect(res.over).toMatchObject({ isError: true });
    expect(res.over!.text).toContain('o máximo ao mesmo tempo');
    // o pai foi acordado com o resumo do filho
    expect(parentTexts[1]).toContain('Os agentes filhos que você criou terminaram (agente-2)');
    expect(parentTexts[1]).toContain('parte A pronta');
    expect(res.stop!.text).toContain('agente-3 parado');
    await until(() => byName('agente-1')?.status === 'done', 'pai concluído');
    expect(byName('agente-3')!.status).toBe('stopped');
    // nada mais a relatar: o pai não é acordado de novo
    await new Promise((r) => setTimeout(r, 150));
    expect(parentTexts).toHaveLength(2);
  }, 30_000);

  it('parar o pai para os filhos que ainda trabalham', async () => {
    let spawned = false;
    runner.turn = async (opts, h) => {
      h.onLine(init(opts.sessionId));
      if (opts.cwd.endsWith('a1')) {
        await callTool(opts, 'spawn_agent', { task: 'Parte longa.' });
        spawned = true;
        await callTool(opts, 'wait_for_agents', {});
        return;
      }
      // o filho nunca termina sozinho
    };
    send({
      type: 'agent.create',
      agentId: 'a1',
      nodeId: 'n-a1',
      issueRef: '101#142',
      repos: [],
      instruction: 'Resolva.',
      maxDepth: 1,
      openMr: true,
      x: 0,
      y: 300,
    });
    await until(() => spawned && byName('agente-2')?.status === 'running', 'filho rodando', 2000);
    send({ type: 'agent.stop', agentId: 'a1' });
    await until(() => byName('agente-2')?.status === 'stopped', 'filho parado');
    expect(byName('agente-1')!.status).toBe('stopped');
    // a chamada wait_for_agents do pai volta cancelada; deixa os processos falsos saírem
    await new Promise((r) => setTimeout(r, 300));
  }, 30_000);
});
