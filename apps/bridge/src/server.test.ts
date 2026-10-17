import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('clones locais', () => {
  let b: Awaited<ReturnType<typeof makeBridge>>;
  afterEach(() => b.cleanup());

  it('acha o clone pelo remoto, procura de novo e aceita caminho informado', async () => {
    b = await makeBridge(() => new MockGitLabClient());
    const dir = mkdtempSync(join(tmpdir(), 'ac-clones-'));
    const repo = (path: string, remote: string) => {
      mkdirSync(path, { recursive: true });
      execFileSync('git', ['init', '-q', path]);
      execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote]);
    };
    // pasta com outro nome e um nível a mais: só o remoto identifica
    repo(join(dir, 'empresa', 'pagamentos'), 'git@gitlab.example.com:grupo/payments-api.git');
    const h = b.headers;
    await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: h,
      payload: {
        mode: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        token: 'glpat-x-123456',
        reposDir: dir,
      },
    });
    let view = (
      await b.app.inject({
        method: 'PUT',
        url: '/api/settings/projects',
        headers: h,
        payload: { projectIds: [101, 102] },
      })
    ).json();
    expect(view.clones).toEqual([
      { projectId: 101, path: join(dir, 'empresa', 'pagamentos'), manual: false },
      { projectId: 102, path: null, manual: false },
    ]);

    // clonado depois: "Procurar de novo" acha sem escolher os projetos outra vez
    repo(join(dir, 'front'), 'https://gitlab.example.com/grupo/web-app.git');
    view = (await b.app.inject({ method: 'POST', url: '/api/repos/rescan', headers: h })).json();
    expect(view.clones[1]).toMatchObject({ projectId: 102, path: join(dir, 'front') });

    // caminho informado: precisa ser git e do projeto certo
    const other = join(dir, 'outro');
    repo(other, 'git@gitlab.example.com:grupo/outro.git');
    let res = await b.app.inject({
      method: 'PUT',
      url: '/api/repos/102/path',
      headers: h,
      payload: { path: other },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/não aponta para grupo\/web-app/);
    res = await b.app.inject({
      method: 'PUT',
      url: '/api/repos/102/path',
      headers: h,
      payload: { path: dir },
    });
    expect(res.json().error).toMatch(/não é um repositório git/);
    const copy = join(dir, 'copia-web');
    repo(copy, 'git@gitlab.example.com:grupo/web-app.git');
    view = (
      await b.app.inject({ method: 'PUT', url: '/api/repos/102/path', headers: h, payload: { path: copy } })
    ).json();
    expect(view.clones[1]).toEqual({ projectId: 102, path: copy, manual: true });

    // projeto com clone não clona de novo
    res = await b.app.inject({ method: 'POST', url: '/api/repos/101/clone', headers: h });
    expect(res.statusCode).toBe(400);
  });
});

describe('seletor de pastas', () => {
  let b: Awaited<ReturnType<typeof makeBridge>>;
  afterEach(() => b.cleanup());

  it('lista só subpastas, marca os clones e exige o token de sessão', async () => {
    b = await makeBridge();
    const dir = mkdtempSync(join(tmpdir(), 'ac-fs-'));
    mkdirSync(join(dir, 'b-projeto', '.git'), { recursive: true });
    mkdirSync(join(dir, 'a-docs'));
    mkdirSync(join(dir, '.oculta'));
    writeFileSync(join(dir, 'arquivo.txt'), 'x');

    const res = await b.app.inject({
      url: `/api/fs/dirs?path=${encodeURIComponent(dir)}`,
      headers: b.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      path: dir,
      isRepo: false,
      entries: [
        { name: 'a-docs', isRepo: false },
        { name: 'b-projeto', isRepo: true },
      ],
    });
    const hidden = await b.app.inject({
      url: `/api/fs/dirs?path=${encodeURIComponent(dir)}&hidden=1`,
      headers: b.headers,
    });
    expect(hidden.json().entries.map((e: { name: string }) => e.name)).toContain('.oculta');

    const missing = await b.app.inject({ url: '/api/fs/dirs?path=/nao/existe', headers: b.headers });
    expect(missing.statusCode).toBe(400);
    const noToken = await b.app.inject({
      url: `/api/fs/dirs?path=${encodeURIComponent(dir)}`,
      headers: { host: b.headers.host },
    });
    expect(noToken.statusCode).toBe(401);
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
    send({ type: 'node.resize', nodeId: 'n-note', w: 9999, h: 300 });
    send({ type: 'note.update', noteId: 't1', body: 'CSV com ; e datas dd/mm/aaaa' });
    await boxB.waitFor('note.upsert');
    await new Promise((r) => setTimeout(r, 50));

    // o outro cliente recebeu as mudanças; quem enviou, não (já aplicou)
    expect(boxB.msgs.some((m) => m.type === 'edge.upsert')).toBe(true);
    expect(boxA.msgs.some((m) => m.type === 'edge.upsert')).toBe(false);

    let s = await state();
    expect(s.nodes.find((n) => n.id === 'n-issue')).toMatchObject({ x: 80, y: 90, refId: '101#142' });
    expect(s.nodes.find((n) => n.id === 'n-issue')).not.toHaveProperty('w');
    // o tamanho fica preso no máximo do tipo
    expect(s.nodes.find((n) => n.id === 'n-note')).toMatchObject({ w: 560, h: 300 });
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

  it('workspaces isolam canvas, atividade e projetos; trocar manda o estado novo', async () => {
    await b.app.inject({ url: '/api/gitlab/issues', headers: b.headers });
    const box = await connect(b);
    const a = box.ws;
    await box.waitFor('hello');
    const send = (m: object) => a.send(JSON.stringify(m));
    send({ type: 'issue.place', nodeId: 'n-issue', issueRef: '101#142', x: 0, y: 0 });
    send({ type: 'note.create', nodeId: 'n-note', note: { id: 't1', title: 'A', body: '' }, x: 300, y: 0 });
    await new Promise((r) => setTimeout(r, 50));

    const api = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
      b.app.inject({ method, url, headers: b.headers, ...(payload ? { payload } : {}) });

    expect((await api('POST', '/api/workspaces', { name: '  ' })).statusCode).toBe(400);
    const created = await api('POST', '/api/workspaces', { name: 'Cliente B' });
    expect(created.statusCode).toBe(200);
    const wsB = created.json().workspaceId as string;
    expect(wsB).not.toBe('default');
    expect(created.json().projects).toEqual([]);
    const snap = (await box.waitFor('state.snapshot')) as Extract<ServerMessage, { type: 'state.snapshot' }>;
    expect(snap.state.nodes).toEqual([]);
    expect(snap.state.settings.workspaceId).toBe(wsB);

    // projetos próprios: o workspace principal continua com os dele
    const sel = await api('PUT', '/api/settings/projects', { projectIds: [102] });
    expect(sel.json().projects.map((p: { id: number }) => p.id)).toEqual([102]);
    expect(sel.json().workspaces).toEqual([
      expect.objectContaining({ id: 'default', name: 'Principal', projects: 2 }),
      expect.objectContaining({ id: wsB, name: 'Cliente B', projects: 1 }),
    ]);
    const issues = (await b.app.inject({ url: '/api/gitlab/issues', headers: b.headers })).json();
    expect(issues.issues.every((i: { projectId: number }) => i.projectId === 102)).toBe(true);

    // a issue do outro workspace não entra aqui
    await api('PUT', '/api/settings/projects', { projectIds: [101, 102] });
    send({ type: 'issue.place', nodeId: 'n-other', issueRef: '101#142', x: 0, y: 0 });
    expect(await box.waitFor('error')).toMatchObject({ message: expect.stringMatching(/outro workspace/) });
    send({ type: 'note.create', nodeId: 'n-b', note: { id: 't2', title: 'B', body: '' }, x: 0, y: 0 });
    await new Promise((r) => setTimeout(r, 50));
    let s = await state();
    expect(s.nodes.map((n) => n.id)).toEqual(['n-b']);
    expect(s.activity.map((x) => x.text)).toEqual(['Nota "B" criada']);

    // de volta ao principal: o canvas dele, intacto
    await api('PUT', '/api/workspaces/active', { id: 'default' });
    s = await state();
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['n-issue', 'n-note']);
    expect(s.settings.projects.map((p) => p.id).sort()).toEqual([101, 103]);
    expect(s.activity.some((x) => x.text === 'Nota "B" criada')).toBe(false);

    expect(
      (await api('PATCH', `/api/workspaces/${wsB}`, { name: 'Cliente C' })).json().workspaces[1].name,
    ).toBe('Cliente C');
    expect((await api('PUT', '/api/workspaces/active', { id: 'nao-existe' })).statusCode).toBe(404);

    // apagar tira o canvas dele; o último não sai
    await api('PUT', '/api/workspaces/active', { id: wsB });
    const del = await api('DELETE', `/api/workspaces/${wsB}`);
    expect(del.json().workspaceId).toBe('default');
    expect(del.json().workspaces).toHaveLength(1);
    expect((await api('DELETE', '/api/workspaces/default')).statusCode).toBe(400);
    s = await state();
    expect(s.nodes).toHaveLength(2);
    expect(s.settings.projects.map((p) => p.id).sort()).toEqual([101, 103]);
    a.terminate();
  });
});
