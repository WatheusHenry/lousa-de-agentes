import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * GitLab falso para o teste ponta a ponta: a API REST que o bridge usa (via gitbeaker), com
 * um projeto cujo remoto é um repositório bare local. Cada commit novo no branch de um MR roda
 * `npm test` num clone temporário (o "pipeline"); o log fica no job "test".
 */
export interface FakeProject {
  id: number;
  name: string;
  path: string;
  /** Repositório bare que faz o papel do remoto. */
  origin: string;
  issues: { iid: number; title: string; description: string; labels?: string[] }[];
}

interface Mr {
  project: number;
  iid: number;
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  state: 'opened' | 'merged' | 'closed';
  updated_at: string;
  pipeline?: Pipeline;
}
interface Pipeline {
  id: number;
  sha: string;
  status: 'running' | 'success' | 'failed';
  trace: string;
}

export async function startFakeGitLab(opts: { token: string; projects: FakeProject[]; pipelineMs?: number }) {
  const notes = new Map<string, { id: number; body: string; created_at: string }[]>();
  const mrs: Mr[] = [];
  const pipelines: Pipeline[] = [];
  let nextIid = 40;
  let nextNote = 300;
  let nextPipe = 9000;
  let base = '';
  const now = () => new Date().toISOString();
  const project = (id: number) => opts.projects.find((p) => p.id === id);
  const sha = (p: FakeProject, branch: string) => {
    try {
      return execFileSync('git', ['-C', p.origin, 'rev-parse', branch], { stdio: 'pipe' }).toString().trim();
    } catch {
      return null;
    }
  };

  function runPipeline(mr: Mr, head: string) {
    const p: Pipeline = { id: nextPipe++, sha: head, status: 'running', trace: '' };
    pipelines.push(p);
    mr.pipeline = p;
    const dir = mkdtempSync(join(tmpdir(), 'fake-ci-'));
    const started = Date.now();
    const script = `git clone -q "${project(mr.project)!.origin}" w && cd w && git checkout -q ${head} && if [ -f package.json ]; then echo '$ npm test' && npm test 2>&1; else echo 'sem testes'; fi`;
    execFile('sh', ['-c', script], { cwd: dir, timeout: 120_000 }, (err, stdout, stderr) => {
      setTimeout(
        () => {
          p.trace = `Running with gitlab-runner (falso)\n${stdout}${stderr}\n${err ? 'ERROR: Job failed: exit code 1' : 'Job succeeded'}\n`;
          p.status = err ? 'failed' : 'success';
          rmSync(dir, { recursive: true, force: true });
        },
        Math.max(0, (opts.pipelineMs ?? 500) - (Date.now() - started)),
      );
    });
  }
  const view = (m: Mr) => {
    const p = project(m.project)!;
    const head = m.state === 'opened' ? sha(p, m.source_branch) : null;
    if (head && m.pipeline?.sha !== head) runPipeline(m, head);
    return {
      iid: m.iid,
      title: m.title,
      description: m.description,
      source_branch: m.source_branch,
      target_branch: m.target_branch,
      state: m.state,
      head_pipeline: m.pipeline ? { id: m.pipeline.id, status: m.pipeline.status } : null,
      web_url: `${base}/${p.path}/-/merge_requests/${m.iid}`,
      updated_at: m.updated_at,
    };
  };
  const projectJson = (p: FakeProject) => ({
    id: p.id,
    name: p.name,
    path_with_namespace: p.path,
    description: '',
    default_branch: 'main',
    web_url: `${base}/${p.path}`,
  });

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['private-token'] !== opts.token) return json(401, { message: '401 Unauthorized' });
      let body: Record<string, string> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
      const u = new URL(req.url ?? '/', 'http://x');
      const path = u.pathname;
      let m: RegExpMatchArray | null;
      if (path === '/api/v4/user')
        return json(200, { id: 5, username: 'e2e', name: 'E2E', avatar_url: null });
      if (path === '/api/v4/projects') return json(200, opts.projects.map(projectJson));
      if ((m = path.match(/^\/api\/v4\/projects\/(\d+)$/))) {
        const p = project(Number(m[1]));
        return p ? json(200, projectJson(p)) : json(404, { message: '404 Project Not Found' });
      }
      if ((m = path.match(/^\/api\/v4\/projects\/(\d+)\/issues$/))) {
        const p = project(Number(m[1]));
        return json(
          200,
          (p?.issues ?? []).map((i) => ({
            ...i,
            labels: i.labels ?? [],
            author: { username: 'ana' },
            state: 'opened',
            updated_at: '2026-10-15T10:00:00Z',
            user_notes_count: 0,
            web_url: `${base}/${p!.path}/-/issues/${i.iid}`,
          })),
        );
      }
      if ((m = path.match(/^\/api\/v4\/projects\/(\d+)\/pipelines\/(\d+)\/jobs$/))) {
        const p = pipelines.find((x) => x.id === Number(m![2]));
        if (!p) return json(404, { message: 'not found' });
        const failedOnly = u.searchParams.get('scope') === 'failed';
        return json(
          200,
          failedOnly && p.status !== 'failed'
            ? []
            : [{ id: p.id * 10, name: 'test', stage: 'test', status: p.status }],
        );
      }
      if ((m = path.match(/^\/api\/v4\/projects\/(\d+)\/jobs\/(\d+)\/trace$/))) {
        const p = pipelines.find((x) => x.id * 10 === Number(m![2]));
        res.writeHead(p ? 200 : 404, { 'content-type': 'text/plain' });
        return res.end(p?.trace ?? '');
      }
      if ((m = path.match(/^\/api\/v4\/projects\/(\d+)\/(issues|merge_requests)\/(\d+)\/notes$/))) {
        const key = `${m[2]}:${m[1]}:${m[3]}`;
        const list = notes.get(key) ?? [];
        if (req.method === 'POST') {
          list.push({ id: nextNote++, body: body.body ?? '', created_at: now() });
          notes.set(key, list);
          return json(201, list.at(-1));
        }
        return json(
          200,
          list.map((n) => ({ ...n, system: false, author: { username: 'e2e' } })),
        );
      }
      if ((m = path.match(/^\/api\/v4\/projects\/(\d+)\/merge_requests$/))) {
        const pid = Number(m[1]);
        if (req.method === 'GET') {
          const b = u.searchParams.get('source_branch');
          return json(
            200,
            mrs
              .filter((x) => x.project === pid && x.state === 'opened' && (!b || x.source_branch === b))
              .map(view),
          );
        }
        if (
          mrs.some((x) => x.project === pid && x.source_branch === body.source_branch && x.state === 'opened')
        )
          return json(409, { message: ['Another open merge request already exists for this source branch'] });
        const mr: Mr = {
          project: pid,
          iid: nextIid++,
          title: body.title ?? '',
          description: body.description ?? '',
          source_branch: body.source_branch ?? '',
          target_branch: body.target_branch ?? 'main',
          state: 'opened',
          updated_at: now(),
        };
        mrs.push(mr);
        return json(201, view(mr));
      }
      if ((m = path.match(/^\/api\/v4\/projects\/(\d+)\/merge_requests\/(\d+)(\/diffs|\/merge)?$/))) {
        const mr = mrs.find((x) => x.project === Number(m![1]) && x.iid === Number(m![2]));
        if (!mr) return json(404, { message: '404 Not found' });
        if (m[3] === '/diffs') {
          const out = execFileSync('git', [
            '-C',
            project(mr.project)!.origin,
            'diff',
            '--no-color',
            `${mr.target_branch}...${mr.source_branch}`,
          ]).toString();
          return json(
            200,
            out
              .split(/^diff --git /m)
              .slice(1)
              .map((blk) => {
                const l = blk.split('\n');
                const names = /^a\/(.+?) b\/(.+)$/.exec(l[0] ?? '');
                const h = l.findIndex((x) => x.startsWith('@@'));
                return {
                  old_path: names?.[1] ?? '',
                  new_path: names?.[2] ?? '',
                  diff: h >= 0 ? l.slice(h).join('\n') : '',
                  new_file: blk.includes('\nnew file mode'),
                  deleted_file: false,
                  renamed_file: false,
                };
              }),
          );
        }
        if (m[3] === '/merge') {
          if (mr.pipeline?.status !== 'success') return json(405, { message: 'Method Not Allowed' });
          mr.state = 'merged';
          return json(200, view(mr));
        }
        if (req.method === 'PUT' && body.state_event === 'close') mr.state = 'closed';
        return json(200, view(mr));
      }
      json(404, { message: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
