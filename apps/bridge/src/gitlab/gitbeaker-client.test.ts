import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitLabError } from './client.ts';
import { GitbeakerClient } from './gitbeaker-client.ts';

const TOKEN = 'glpat-test-token-123';

/** GitLab falso, só com as rotas que o cliente usa. Nenhum token real envolvido. */
function fakeGitLab(): Promise<{ server: Server; url: string; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['private-token'] !== TOKEN) return json(401, { message: '401 Unauthorized' });
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/api/v4/user')
      return json(200, { id: 7, username: 'matheus', name: 'Matheus', avatar_url: null, web_url: 'x' });
    if (url.pathname === '/api/v4/projects')
      return json(200, [
        {
          id: 3,
          name: 'payments-api',
          path_with_namespace: 'grupo/payments-api',
          description: null,
          default_branch: 'main',
          web_url: 'w',
        },
      ]);
    if (url.pathname === '/api/v4/projects/3/issues')
      return json(200, [
        {
          iid: 142,
          title: 'Webhook duplica cobrança',
          description: null,
          labels: ['bug'],
          author: { username: 'ana' },
          state: 'opened',
          updated_at: '2026-10-01T00:00:00Z',
          user_notes_count: 2,
          web_url: 'w/142',
        },
      ]);
    if (url.pathname === '/api/v4/projects/3/issues/142/notes')
      return json(200, [
        { id: 1, body: 'mudou o título', system: true, author: { username: 'ana' }, created_at: 'a' },
        { id: 2, body: 'Usem o event_id', system: false, author: { username: 'joao' }, created_at: 'b' },
      ]);
    json(404, { message: '404 Not Found' });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, seen });
    }),
  );
}

describe('GitbeakerClient', () => {
  let gl: Awaited<ReturnType<typeof fakeGitLab>>;
  beforeAll(async () => {
    gl = await fakeGitLab();
  });
  afterAll(() => gl.server.close());

  it('valida o token com GET /user', async () => {
    const u = await new GitbeakerClient(gl.url, TOKEN).currentUser();
    expect(u).toMatchObject({ id: 7, username: 'matheus' });
    expect(gl.seen.at(-1)!.url).toBe('/api/v4/user');
  });

  it('token errado vira GitLabError 401 sem vazar o token', async () => {
    const err = await new GitbeakerClient(gl.url, 'glpat-wrong-token').currentUser().catch((e) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain('glpat');
  });

  it('lista projetos, issues e comentários (sem notas de sistema)', async () => {
    const c = new GitbeakerClient(gl.url, TOKEN);
    const [p] = await c.searchProjects('pay');
    expect(p).toMatchObject({ id: 3, pathWithNamespace: 'grupo/payments-api', defaultBranch: 'main' });
    const issues = await c.listOpenIssues(p!);
    expect(issues[0]).toMatchObject({
      ref: '3#142',
      iid: 142,
      description: '',
      author: 'ana',
      commentCount: 2,
    });
    const comments = await c.listIssueComments(3, 142);
    expect(comments).toEqual([
      { id: 2, author: 'joao', body: 'Usem o event_id', createdAt: 'b', isAgent: false },
    ]);
  });

  it('servidor fora do ar vira mensagem de rede', async () => {
    const err = await new GitbeakerClient('http://127.0.0.1:1', TOKEN).currentUser().catch((e) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.message).toMatch(/conectar/);
  });
});
