import { describe, expect, it } from 'vitest';
import type { Approval } from '@agent-canvas/shared';
import { openDb } from '../db/index.ts';
import { Hub } from '../hub.ts';
import { ApprovalService, stableJson, type PermissionRequest } from './approval-service.ts';

const WT = '/home/u/.agent-canvas/worktrees/a1';
const req = (command: string, over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  agentId: 'a1',
  repoId: 101,
  worktree: WT,
  toolName: 'Bash',
  input: { command },
  ...over,
});

function setup() {
  const { db, close } = openDb(':memory:');
  const seen: Approval[] = [];
  const svc = new ApprovalService(db, new Hub());
  svc.onChange = (_id, a) => seen.push(a);
  const pending = () => seen.filter((a) => a.status === 'pending').at(-1)!;
  return { db, svc, seen, pending, close };
}

describe('regras de permissão no serviço de aprovações', () => {
  it('regra padrão vence a regra salva: push forçado e rm fora do worktree são negados mesmo liberados', async () => {
    const { svc, seen, close } = setup();
    svc.addPolicy('Bash(git push:*)', 'global');
    svc.addPolicy('Bash(rm:*)', 'global');
    expect(await svc.request(req('git push origin agent/1'))).toMatchObject({ behavior: 'allow' });
    expect(await svc.request(req('git push --force origin agent/1'))).toMatchObject({ behavior: 'deny' });
    expect(await svc.request(req('rm -rf ../vizinho'))).toMatchObject({ behavior: 'deny' });
    expect(await svc.request(req('rm -rf dist'))).toMatchObject({ behavior: 'allow' });
    // tudo fica registrado, com quem decidiu
    expect(seen.map((a) => [a.status, a.decidedBy])).toEqual([
      ['allowed', 'regra Bash(git push:*)'],
      ['denied', 'regra padrão'],
      ['denied', 'regra padrão'],
      ['allowed', 'regra Bash(rm:*)'],
    ]);
    close();
  });

  it('rede só com regra explícita para o comando', async () => {
    const { svc, pending, close } = setup();
    expect(await svc.request(req('curl https://exemplo.dev'))).toMatchObject({ behavior: 'deny' });
    svc.addPolicy('Bash(curl:*)', 'global');
    expect(await svc.request(req('curl https://exemplo.dev'))).toMatchObject({ behavior: 'allow' });
    // comando composto: rede só passa se todas as partes tiverem regra
    expect(await svc.request(req('npm test && curl https://x.dev'))).toMatchObject({ behavior: 'deny' });
    svc.addPolicy('Bash(npm test:*)', 'global');
    expect(await svc.request(req('npm test && curl https://x.dev'))).toMatchObject({ behavior: 'allow' });
    expect(pending()).toBeUndefined();
    close();
  });

  it('regra por repositório vale só para ele', async () => {
    const { svc, pending, close } = setup();
    svc.addPolicy('Bash(npm test:*)', '101');
    expect(await svc.request(req('npm test'))).toMatchObject({ behavior: 'allow' });
    const other = svc.request(req('npm test', { repoId: 102 }));
    await Promise.resolve();
    expect(pending().status).toBe('pending');
    svc.decide(pending().id, 'allow');
    expect(await other).toMatchObject({ behavior: 'allow' });
    expect(svc.allowedTools(101)).toEqual(['Bash(npm test:*)']);
    expect(svc.allowedTools(102)).toEqual([]);
    close();
  });

  it('"Sempre permitir" grava a regra e libera os pedidos iguais que esperavam, de outros agentes também', async () => {
    const { svc, seen, close } = setup();
    const a = svc.request(req('npm test -- --watch=false'));
    const b = svc.request(req('npm test', { agentId: 'a2' }));
    const c = svc.request(req('npm run build', { agentId: 'a2' }));
    await Promise.resolve();
    const first = seen.find((x) => x.status === 'pending')!;
    expect(first.suggestedRule).toBe('Bash(npm test:*)');
    svc.decide(first.id, 'allow', true);
    expect(await a).toMatchObject({ behavior: 'allow' });
    expect(await b).toMatchObject({ behavior: 'allow' });
    expect(svc.pending().map((x) => x.summary)).toEqual(['npm run build']);
    svc.cancelForAgent('a2', 'parado');
    expect(await c).toMatchObject({ behavior: 'deny', message: 'parado' });
    expect(svc.policies().map((p) => p.pattern)).toEqual(['Bash(npm test:*)']);
    close();
  });

  it('ferramentas de arquivo fora do worktree são negadas', async () => {
    const { svc, close } = setup();
    svc.addPolicy('Write', 'global');
    expect(
      await svc.request(req('', { toolName: 'Write', input: { file_path: `${WT}/a.ts` } })),
    ).toMatchObject({
      behavior: 'allow',
    });
    expect(
      await svc.request(req('', { toolName: 'Write', input: { file_path: '/etc/hosts' } })),
    ).toMatchObject({
      behavior: 'deny',
    });
    close();
  });

  it('stableJson ignora a ordem das chaves', () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      stableJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });
});
