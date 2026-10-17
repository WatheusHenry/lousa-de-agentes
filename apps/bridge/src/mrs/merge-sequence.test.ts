import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockGitLabClient } from '../gitlab/mock-client.ts';
import { mergeRequestCache } from '../db/schema.ts';
import { makeBridge } from '../test-utils.ts';

describe('merge em sequência', () => {
  let b: Awaited<ReturnType<typeof makeBridge>>;
  let client: MockGitLabClient;
  const refs: string[] = [];

  beforeEach(async () => {
    client = new MockGitLabClient({ pipelineMs: 60_000 });
    b = await makeBridge(() => client, undefined, 4977);
    const h = b.headers;
    await b.app.inject({
      method: 'POST',
      url: '/api/settings/gitlab',
      headers: h,
      payload: { mode: 'gitlab', baseUrl: 'https://gitlab.example.com', token: 'glpat-teste' },
    });
    await b.app.inject({
      method: 'PUT',
      url: '/api/settings/projects',
      headers: h,
      payload: { projectIds: [101, 102] },
    });
    refs.length = 0;
    const ts = new Date().toISOString();
    for (const pid of [102, 101]) {
      const m = await client.createMergeRequest(pid, {
        sourceBranch: 'agent/142',
        targetBranch: 'main',
        title: `MR em ${pid}`,
        description: '',
      });
      b.db
        .insert(mergeRequestCache)
        .values({
          projectId: pid,
          iid: m.iid,
          projectPath: `grupo/p${pid}`,
          title: m.title,
          description: '',
          sourceBranch: m.sourceBranch,
          targetBranch: 'main',
          state: 'opened',
          pipelineStatus: 'running',
          webUrl: m.webUrl,
          agentId: null,
          issueRef: '101#142',
          updatedAt: ts,
          fetchedAt: ts,
        })
        .run();
      refs.push(`${pid}!${m.iid}`);
    }
    b.app.mrs.mergePollMs = 15;
  });
  afterEach(async () => {
    await b.cleanup();
  });

  const state = (ref: string) => {
    const [p, i] = ref.split('!').map(Number);
    return client.getMergeRequest(p!, i!).then((m) => m.state);
  };
  const progress = () => b.app.mrs.merges().find((m) => m.issueRef === '101#142')!;
  const until = async (fn: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 300; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`esperando ${what}: ${JSON.stringify(progress())}`);
  };
  const force = (ref: string, s: 'success' | 'failed' | 'running') => {
    const [p, i] = ref.split('!').map(Number);
    client.forcePipeline(p!, i!, s);
  };

  it('espera o pipeline de cada MR e mergeia na ordem dada', async () => {
    const [first, second] = refs as [string, string];
    force(first, 'running');
    force(second, 'success');
    const run = b.app.mrs.mergeInOrder('101#142', [first, second]);
    await until(() => progress().state === 'waiting' && progress().index === 0, 'esperando o primeiro');
    // o segundo já passou, mas não é mergeado antes do primeiro
    expect(await state(second)).toBe('opened');
    force(first, 'success');
    await run;
    expect(progress()).toMatchObject({ state: 'done', merged: [first, second] });
    expect(await state(first)).toBe('merged');
    expect(await state(second)).toBe('merged');
  });

  it('para na primeira falha sem tocar nos seguintes', async () => {
    const [first, second] = refs as [string, string];
    force(first, 'failed');
    force(second, 'success');
    await b.app.mrs.mergeInOrder('101#142', [first, second]);
    expect(progress().state).toBe('failed');
    expect(progress().message).toContain('falhou');
    expect(await state(second)).toBe('opened');
  });

  it('cancelar interrompe a espera, e não deixa começar duas sequências na mesma issue', async () => {
    force(refs[0]!, 'running');
    const run = b.app.mrs.mergeInOrder('101#142', refs);
    await until(() => progress().state === 'waiting', 'esperando');
    await expect(b.app.mrs.mergeInOrder('101#142', refs)).rejects.toThrow('Já há um merge');
    b.app.mrs.cancelMerge('101#142');
    await run;
    expect(progress().state).toBe('cancelled');
    expect(await state(refs[0]!)).toBe('opened');
  });
});
