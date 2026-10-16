import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Agent, ServerMessage, WorktreeLeftover } from '@agent-canvas/shared';
import { makeBridge } from '../test-utils.ts';
import type { AgentProcess, AgentRunner, RunnerHandlers, RunnerStartOptions } from './runner.ts';

const TEST_PORT = 4979;
const line = (o: unknown) => JSON.stringify(o);

/** Runner falso: o turno commita um arquivo, deixa outro sem commit e termina. */
class WorkRunner implements AgentRunner {
  start(opts: RunnerStartOptions, h: RunnerHandlers): AgentProcess {
    let alive = true;
    const exit = () => {
      if (alive) {
        alive = false;
        setTimeout(() => h.onExit({ code: 0, signal: null, stderr: '' }), 5);
      }
    };
    return {
      send: () => {
        h.onLine(
          line({ type: 'system', subtype: 'init', session_id: opts.sessionId, model: 'f', cwd: '/w' }),
        );
        const g = (...a: string[]) =>
          execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...a], { cwd: opts.cwd });
        writeFileSync(join(opts.cwd, 'feito.txt'), 'ok\n');
        g('add', 'feito.txt');
        g('commit', '-qm', 'feito');
        writeFileSync(join(opts.cwd, 'rascunho.txt'), 'sem commit\n');
        h.onLine(
          line({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'ok',
            session_id: opts.sessionId,
            usage: {},
          }),
        );
      },
      interrupt: () => {},
      endInput: exit,
      kill: exit,
    };
  }
}

describe('limpeza de worktrees', () => {
  let b: Awaited<ReturnType<typeof makeBridge>>;
  let ws: WebSocket;
  let msgs: ServerMessage[];
  let repo: string;
  const send = (m: object) => ws.send(JSON.stringify(m));
  async function until<T>(fn: () => T | undefined | false, what: string): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`esperando ${what}`);
  }
  const agent = (id: string) =>
    msgs.flatMap((m) => (m.type === 'agent.upsert' && m.agent.id === id ? [m.agent] : [])).at(-1) as
      Agent | undefined;
  const leftovers = async () =>
    (
      await b.app.inject({ url: '/api/worktrees/leftovers', headers: b.headers })
    ).json() as WorktreeLeftover[];

  beforeEach(async () => {
    b = await makeBridge(undefined, new WorkRunner(), TEST_PORT);
    const reposDir = mkdtempSync(join(tmpdir(), 'ac-clean-'));
    repo = join(reposDir, 'payments-api');
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# payments-api\n');
    git('add', '.');
    git('-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'inicial');
    const h = b.headers;
    await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: h,
      payload: { mode: 'demo', reposDir },
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
  });
  afterEach(async () => {
    ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    await b.cleanup();
  });

  it('lista só agentes removidos, mostra o que se perderia e apaga a pasta mantendo o branch', async () => {
    send({
      type: 'agent.create',
      agentId: 'a1',
      nodeId: 'n-a1',
      repos: [101],
      instruction: 'Faça.',
      x: 0,
      y: 0,
    });
    const done = await until(() => agent('a1')?.status === 'done' && agent('a1'), 'agente concluir');
    const path = done.worktreePath!;
    // no canvas: não entra na lista
    expect(await leftovers()).toEqual([]);

    send({ type: 'node.remove', nodeId: 'n-a1' });
    const [item] = await (async () => {
      for (let i = 0; i < 100; i++) {
        const l = await leftovers();
        if (l.length) return l;
        await new Promise((r) => setTimeout(r, 10));
      }
      return [];
    })();
    expect(item).toMatchObject({
      agentId: 'a1',
      path,
      branch: done.branch,
      kind: 'worktree',
      uncommitted: 1,
      unpushed: 1,
    });
    expect(item!.removedAt).toBeTruthy();

    const res = (
      await b.app.inject({
        method: 'POST',
        url: '/api/worktrees/cleanup',
        headers: b.headers,
        payload: { agentIds: ['a1', 'a-outro'] },
      })
    ).json() as { removed: string[]; errors: { agentId: string }[] };
    expect(res.removed).toEqual(['a1']);
    expect(res.errors.map((e) => e.agentId)).toEqual(['a-outro']);
    expect(existsSync(path)).toBe(false);
    expect(execFileSync('git', ['worktree', 'list'], { cwd: repo }).toString()).not.toContain(path);
    // o branch com o commit do agente continua no clone
    expect(
      execFileSync('git', ['log', '--format=%s', '-1', done.branch!], { cwd: repo }).toString().trim(),
    ).toBe('feito');
    await until(() => agent('a1')?.worktreePath === null, 'agente sem pasta');
    expect(await leftovers()).toEqual([]);
  });
});
