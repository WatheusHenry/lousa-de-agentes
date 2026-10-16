import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage, StateSnapshot } from '@agent-canvas/shared';
import { GitLabError } from './gitlab/client.ts';
import { MockGitLabClient } from './gitlab/mock-client.ts';
import { makeBridge, TEST_PORT } from './test-utils.ts';

type Bridge = Awaited<ReturnType<typeof makeBridge>>;

/** Conecta e junta as mensagens que chegam no socket desde a abertura. */
async function connect(b: Bridge, token = b.session.token) {
  const msgs: ServerMessage[] = [];
  if (!b.app.server.listening) await b.app.listen({ host: '127.0.0.1', port: TEST_PORT });
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws?token=${token}`, {
    origin: 'http://localhost:5173',
  });
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    ws,
    msgs,
    async waitFor(type: ServerMessage['type']) {
      for (let i = 0; i < 100; i++) {
        const m = msgs.find((x) => x.type === type);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`não chegou ${type}; chegaram ${msgs.map((m) => m.type).join(', ')}`);
    },
  };
}

describe('segurança do bridge', () => {
  let b: Bridge;
  beforeEach(async () => {
    b = await makeBridge();
  });
  afterEach(() => b.cleanup());

  it('exige o token de sessão na API', async () => {
    const no = await b.app.inject({ url: '/api/state', headers: { host: `127.0.0.1:${TEST_PORT}` } });
    expect(no.statusCode).toBe(401);
    const bad = await b.app.inject({
      url: '/api/state',
      headers: { ...b.headers, 'x-agent-canvas-token': 'x'.repeat(64) },
    });
    expect(bad.statusCode).toBe(401);
    const ok = await b.app.inject({ url: '/api/state', headers: b.headers });
    expect(ok.statusCode).toBe(200);
  });

  it('recusa outro Host (DNS rebinding) e outra origem', async () => {
    const host = await b.app.inject({
      url: '/api/state',
      headers: { ...b.headers, host: 'evil.example:4999' },
    });
    expect(host.statusCode).toBe(403);
    const origin = await b.app.inject({
      url: '/api/state',
      headers: { ...b.headers, origin: 'https://evil.example' },
    });
    expect(origin.statusCode).toBe(403);
  });

  it('o WebSocket recusa conexão sem token', async () => {
    await expect(connect(b, 'errado')).rejects.toThrow();
    const box = await connect(b);
    await box.waitFor('hello');
    box.ws.terminate();
  });
});

describe('configuração do GitLab', () => {
  let b: Bridge;
  afterEach(() => b.cleanup());

  it('valida o token antes de gravar e guarda fora do banco', async () => {
    b = await makeBridge(() => new MockGitLabClient());
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: b.headers,
      payload: {
        mode: 'gitlab',
        baseUrl: 'https://gitlab.example.com/',
        token: 'glpat-secret-value',
        reposDir: b.home,
      },
    });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view).toMatchObject({
      configured: true,
      hasToken: true,
      tokenSource: 'secrets-file',
      baseUrl: 'https://gitlab.example.com',
    });
    expect(JSON.stringify(view)).not.toContain('glpat-secret-value');
    expect(b.secrets.gitlabToken()?.token).toBe('glpat-secret-value');
    expect(readFileSync(join(b.home, 'secrets.json'), 'utf8')).toContain('glpat-secret-value');
    // o banco não tem o token em nenhuma tabela
    const dump = b.sqlite.prepare('select group_concat(value) as v from setting').get() as { v: string };
    expect(dump.v).not.toContain('glpat-secret-value');
  });

  it('token inválido não é gravado', async () => {
    b = await makeBridge(() => new MockGitLabClient({ failAuth: true }));
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: b.headers,
      payload: { mode: 'gitlab', baseUrl: 'https://gitlab.example.com', token: 'glpat-bad-value' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/Token inválido/);
    expect(b.secrets.gitlabToken()).toBeNull();
    expect(b.settings.view().configured).toBe(false);
  });

  it('pasta de repositórios precisa existir', async () => {
    b = await makeBridge();
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: b.headers,
      payload: { mode: 'demo', reposDir: '/nao/existe/mesmo' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('erros do GitLab viram 502 com mensagem legível', async () => {
    b = await makeBridge(() => {
      const c = new MockGitLabClient();
      c.searchProjects = async () => {
        throw new GitLabError('O GitLab respondeu com erro 500.', 500);
      };
      return c;
    });
    await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: b.headers,
      payload: { mode: 'gitlab', baseUrl: 'https://gitlab.example.com', token: 'glpat-12345678' },
    });
    const res = await b.app.inject({ url: '/api/gitlab/projects', headers: b.headers });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/erro 500/);
  });
});

describe('canvas persistido', () => {
  let b: Bridge;
  beforeEach(async () => {
    b = await makeBridge();
    await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: b.headers,
      payload: { mode: 'demo' },
    });
    await b.app.inject({
      method: 'PUT',
      url: '/api/settings/projects',
      headers: b.headers,
      payload: { projectIds: [101, 103] },
    });
  });
  afterEach(() => b.cleanup());

  const state = async () =>
    (await b.app.inject({ url: '/api/state', headers: b.headers })).json() as StateSnapshot;

  it('lista as issues abertas dos projetos escolhidos', async () => {
    const res = await b.app.inject({ url: '/api/gitlab/issues', headers: b.headers });
    const { issues, errors } = res.json();
    expect(errors).toEqual([]);
    expect(issues.map((i: { iid: number }) => i.iid).sort()).toEqual([142, 157, 161, 163]);
    const comments = await b.app.inject({ url: '/api/gitlab/issues/101/142/comments', headers: b.headers });
    expect(comments.json()).toHaveLength(2);
    const other = await b.app.inject({ url: '/api/gitlab/issues/102/170/comments', headers: b.headers });
    expect(other.statusCode).toBe(404);
  });

  it('issue, nota, vínculo, movimento, remoção e desfazer sobrevivem a um novo snapshot', async () => {
    await b.app.inject({ url: '/api/gitlab/issues', headers: b.headers });
    const boxA = await connect(b);
    const boxB = await connect(b);
    const a = boxA.ws;
    const other = boxB.ws;
    await boxA.waitFor('hello');
    await boxB.waitFor('hello');

    const send = (m: object) => a.send(JSON.stringify(m));
    send({ type: 'issue.place', nodeId: 'n-issue', issueRef: '101#142', x: 40, y: 40 });
    send({
      type: 'note.create',
      nodeId: 'n-note',
      note: { id: 't1', title: 'Decisões', body: 'CSV com ;' },
      x: 400,
      y: 40,
    });
    send({ type: 'note.link', edgeId: 'e1', noteId: 't1', targetNodeId: 'n-issue' });
    send({ type: 'node.move', nodeId: 'n-issue', x: 80, y: 90 });
    send({ type: 'note.update', noteId: 't1', body: 'CSV com ; e datas dd/mm/aaaa' });
    await boxB.waitFor('note.upsert');
    await new Promise((r) => setTimeout(r, 50));

    // o outro cliente recebeu as mudanças; quem enviou, não (já aplicou)
    expect(boxB.msgs.some((m) => m.type === 'edge.upsert')).toBe(true);
    expect(boxA.msgs.some((m) => m.type === 'edge.upsert')).toBe(false);

    let s = await state();
    expect(s.nodes.find((n) => n.id === 'n-issue')).toMatchObject({ x: 80, y: 90, refId: '101#142' });
    expect(s.issues.map((i) => i.iid)).toEqual([142]);
    expect(s.notes).toEqual([expect.objectContaining({ id: 't1', body: 'CSV com ; e datas dd/mm/aaaa' })]);
    expect(s.noteLinks).toEqual([{ noteId: 't1', targetNodeId: 'n-issue' }]);
    expect(s.edges).toHaveLength(1);
    expect(s.activity[0]!.text).toMatch(/vinculada a issue #142/);

    // remover a issue esconde a aresta; desfazer traz tudo de volta
    send({ type: 'node.remove', nodeId: 'n-issue' });
    await boxB.waitFor('node.remove');
    s = await state();
    expect(s.nodes.map((n) => n.id)).toEqual(['n-note']);
    expect(s.edges).toHaveLength(0);
    expect(s.noteLinks).toHaveLength(0);

    send({ type: 'node.restore', nodeId: 'n-issue' });
    await boxA.waitFor('state.snapshot');
    s = await state();
    expect(s.nodes).toHaveLength(2);
    expect(s.edges).toHaveLength(1);
    expect(s.noteLinks).toHaveLength(1);

    // trazer a mesma issue de novo não duplica
    send({ type: 'issue.place', nodeId: 'n-dup', issueRef: '101#142', x: 0, y: 0 });
    await new Promise((r) => setTimeout(r, 50));
    s = await state();
    expect(s.nodes.filter((n) => n.type === 'issue')).toHaveLength(1);

    // desvincular
    send({ type: 'note.unlink', noteId: 't1', targetNodeId: 'n-issue' });
    await boxB.waitFor('noteLink.remove');
    s = await state();
    expect(s.edges).toHaveLength(0);

    a.terminate();
    other.terminate();
  });

  it('mensagem inválida devolve erro e o estado real', async () => {
    const box = await connect(b);
    const a = box.ws;
    await box.waitFor('hello');
    a.send(JSON.stringify({ type: 'node.move', nodeId: 'nao-existe', x: 1, y: 2 }));
    expect(await box.waitFor('error')).toMatchObject({ message: 'Item não encontrado no canvas.' });
    await box.waitFor('state.snapshot');
    a.send('isso não é json');
    await new Promise((r) => setTimeout(r, 30));
    expect(box.msgs.filter((m) => m.type === 'error')).toHaveLength(2);
    a.terminate();
  });

  it('issue desconhecida não entra no canvas', async () => {
    const box = await connect(b);
    const a = box.ws;
    await box.waitFor('hello');
    a.send(JSON.stringify({ type: 'issue.place', nodeId: 'n1', issueRef: '101#999', x: 0, y: 0 }));
    expect(await box.waitFor('error')).toMatchObject({
      message: expect.stringMatching(/Issue desconhecida/),
    });
    a.terminate();
  });
});
