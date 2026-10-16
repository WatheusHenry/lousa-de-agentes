import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import type { WorktreeLeftover } from '@agent-canvas/shared';
import type { CanvasStore } from '../canvas/canvas-store.ts';
import type { Db } from '../db/index.ts';
import { agent as agentT, node, repo as repoT } from '../db/schema.ts';
import type { Hub } from '../hub.ts';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout.trim();

/**
 * Limpeza das pastas de trabalho de agentes removidos do canvas (seção 11, Fase 7). Só entra
 * na lista o que fica dentro da pasta de dados do app, de agente sem processo e sem nó vivo,
 * e que nenhum agente do canvas usa (o fix trabalha no worktree do autor). O branch fica: só a
 * pasta sai. A tela mostra o que ainda não foi commitado ou enviado antes de o usuário confirmar.
 */
export class WorktreeCleanup {
  constructor(
    private readonly d: {
      db: Db;
      hub: Hub;
      store: CanvasStore;
      home: string;
      busy: (agentId: string) => boolean;
      /** O agente perdeu a pasta: o supervisor grava e avisa o canvas. */
      forget: (agentId: string, note: string) => void;
    },
  ) {}

  async list(): Promise<WorktreeLeftover[]> {
    const agents = this.d.db.select().from(agentT).all();
    const nodes = this.d.db.select().from(node).where(eq(node.type, 'agent')).all();
    const nodeOf = new Map(nodes.map((n) => [n.refId, n]));
    const liveNode = (id: string) => !!nodeOf.get(id) && !nodeOf.get(id)!.removedAt;
    const inUse = new Set(agents.filter((a) => liveNode(a.id) && a.worktreePath).map((a) => a.worktreePath!));
    const roots = [join(this.d.home, 'worktrees'), join(this.d.home, 'workspaces')].map((r) => resolve(r));
    const seen = new Set<string>();
    const out: WorktreeLeftover[] = [];
    for (const a of agents) {
      const path = a.worktreePath;
      if (!path || seen.has(path) || liveNode(a.id) || inUse.has(path) || this.d.busy(a.id)) continue;
      if (!roots.some((r) => resolve(path).startsWith(`${r}/`)) || !existsSync(path)) continue;
      // outro agente fora do canvas no mesmo worktree, ainda trabalhando
      if (agents.some((x) => x.id !== a.id && x.worktreePath === path && this.d.busy(x.id))) continue;
      seen.add(path);
      const kind = a.role === 'orchestrator' ? 'workspace' : 'worktree';
      out.push({
        agentId: a.id,
        name: a.name,
        path,
        branch: a.branch,
        kind,
        removedAt: nodeOf.get(a.id)?.removedAt ?? null,
        ...(kind === 'worktree'
          ? await this.pending(path, a.branch, this.defaultBranch(a.repos[0]))
          : { uncommitted: 0, unpushed: 0 }),
      });
    }
    return out;
  }

  private defaultBranch(projectId: number | undefined): string {
    if (projectId === undefined) return 'main';
    return (
      this.d.db.select().from(repoT).where(eq(repoT.gitlabProjectId, projectId)).get()?.defaultBranch ??
      'main'
    );
  }

  /** Arquivos sem commit (fora de .agent-canvas/) e commits que o remoto não tem. */
  private async pending(path: string, branch: string | null, base: string) {
    const status = await git(path, 'status', '--porcelain').catch(() => '');
    const uncommitted = status
      .split('\n')
      .filter((l) => l && !l.slice(3).startsWith('.agent-canvas/')).length;
    let unpushed = 0;
    if (branch) {
      const remote = await git(path, 'rev-parse', '--verify', '--quiet', `origin/${branch}`).catch(() => '');
      // sem branch no remoto: os commits do agente são os que a base (local ou remota) não tem
      const args = remote
        ? [`origin/${branch}..HEAD`]
        : [
            'HEAD',
            '--not',
            '--remotes',
            ...((await git(path, 'rev-parse', '--verify', '--quiet', base).catch(() => '')) ? [base] : []),
          ];
      unpushed = Number(await git(path, 'rev-list', '--count', ...args).catch(() => '0')) || 0;
    }
    return { uncommitted, unpushed };
  }

  /** Apaga as pastas escolhidas (só as que ainda estão na lista). */
  async remove(
    agentIds: string[],
  ): Promise<{ removed: string[]; errors: { agentId: string; error: string }[] }> {
    const list = await this.list();
    const removed: string[] = [];
    const errors: { agentId: string; error: string }[] = [];
    for (const id of agentIds) {
      const item = list.find((x) => x.agentId === id);
      if (!item) {
        errors.push({
          agentId: id,
          error: 'Não está mais na lista (o agente voltou ao canvas ou está trabalhando).',
        });
        continue;
      }
      try {
        if (item.kind === 'workspace') rmSync(item.path, { recursive: true, force: true });
        else await this.removeWorktree(item);
        for (const a of this.d.db.select().from(agentT).where(eq(agentT.worktreePath, item.path)).all())
          this.d.forget(a.id, 'Pasta de trabalho apagada na limpeza; o branch continua no clone.');
        removed.push(id);
      } catch (err) {
        errors.push({ agentId: id, error: (err as Error).message.split('\n').slice(-2).join(' ') });
      }
    }
    if (removed.length)
      this.d.hub.broadcast(
        this.d.store.logActivity(
          `Limpeza: ${removed.length} pasta${removed.length > 1 ? 's' : ''} de agentes removidos apagada${removed.length > 1 ? 's' : ''}`,
        ),
      );
    return { removed, errors };
  }

  private async removeWorktree(item: WorktreeLeftover): Promise<void> {
    // o clone principal: o worktree aponta para ele em .git/commondir
    const common = await git(item.path, 'rev-parse', '--path-format=absolute', '--git-common-dir').catch(
      () => '',
    );
    const repo = common ? resolve(common, '..') : null;
    if (repo && existsSync(repo)) {
      await git(repo, 'worktree', 'remove', '--force', item.path);
      await git(repo, 'worktree', 'prune').catch(() => {});
    } else rmSync(item.path, { recursive: true, force: true });
  }
}
