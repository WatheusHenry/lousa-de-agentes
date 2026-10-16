import {
  issueRef,
  parseAgentNote,
  type MrDiffFile,
  type GitLabProject,
  type GitLabUser,
  type Issue,
  type IssueComment,
} from '@agent-canvas/shared';
import { GitLabError, type GitLabClient, type GitLabMr, type JobLog } from './client.ts';

/** Dados de exemplo, os mesmos do protótipo (docs/prototype/agent-canvas.html). */
export const DEMO_USER: GitLabUser = {
  id: 1,
  username: 'demo',
  name: 'Usuário de demonstração',
  avatarUrl: null,
};

export const DEMO_PROJECTS: GitLabProject[] = [
  { id: 101, name: 'payments-api', description: 'API Node/TypeScript' },
  { id: 102, name: 'web-app', description: 'Front React + Vite' },
  { id: 103, name: 'shared-contracts', description: 'OpenAPI e tipos compartilhados' },
].map((p) => ({
  ...p,
  pathWithNamespace: `grupo/${p.name}`,
  defaultBranch: 'main',
  webUrl: `https://gitlab.example.com/grupo/${p.name}`,
}));

interface DemoIssue {
  project: string;
  iid: number;
  title: string;
  labels: string[];
  author: string;
  description: string;
  comments: { who: string; text: string }[];
}

const DEMO_ISSUES: DemoIssue[] = [
  {
    project: 'payments-api',
    iid: 142,
    title: 'Webhook de pagamento duplica cobrança quando o gateway reenvia',
    labels: ['bug', 'P1'],
    author: 'ana.ribeiro',
    description:
      'Quando o gateway reenvia o webhook (timeout > 10s), o handler cria uma segunda cobrança. ' +
      'O handler fica em `src/webhooks/handler.ts`.\n\n' +
      '## Critérios de aceite\n- [ ] O mesmo evento processado duas vezes gera uma só cobrança\n' +
      '- [ ] O reenvio responde 200 com a cobrança existente\n- [ ] Teste cobrindo o retry do gateway',
    comments: [
      {
        who: 'ana.ribeiro',
        text: 'Suporte reportou 4 clientes cobrados duas vezes ontem. Todos com timeout do gateway acima de 10s.',
      },
      {
        who: 'joao.p',
        text: 'O gateway manda o mesmo event_id no reenvio. Dá para usar como chave de idempotência.',
      },
    ],
  },
  {
    project: 'shared-contracts',
    iid: 157,
    title: 'Exportar extrato do cliente em CSV e PDF',
    labels: ['feature'],
    author: 'lucas.m',
    description:
      'O cliente precisa baixar o extrato filtrado por período. CSV para planilha, PDF com cabeçalho da empresa. ' +
      'Limite de 12 meses por exportação.\n\nToca grupo/shared-contracts, grupo/payments-api e grupo/web-app.\n\n' +
      '## Critérios de aceite\n- [ ] Exportar o extrato filtrado por período em CSV e PDF\n' +
      '- [ ] Limite de 12 meses validado na API e na tela\n- [ ] PDF com cabeçalho e logo da empresa\n' +
      '- [ ] Testes na API e no web-app',
    comments: [
      { who: 'lucas.m', text: 'Produto confirmou: CSV e PDF na primeira versão, Excel fica para depois.' },
      {
        who: 'ana.ribeiro',
        text: 'O contrato precisa sair antes, o web-app consome o tipo gerado do OpenAPI.',
      },
      { who: 'lucas.m', text: 'Deixei as decisões de produto numa nota no canvas.' },
    ],
  },
  {
    project: 'payments-api',
    iid: 161,
    title: 'Migrar fila de e-mails transacionais para BullMQ',
    labels: ['tech-debt'],
    author: 'ana.ribeiro',
    description:
      'A fila caseira em setInterval perde jobs durante o deploy. Migrar para BullMQ com retries exponenciais.',
    comments: [{ who: 'ana.ribeiro', text: 'Detalhes na descrição. Qualquer dúvida, comentem aqui.' }],
  },
  {
    project: 'payments-api',
    iid: 163,
    title: 'Rate limit por tenant na API pública',
    labels: ['feature'],
    author: 'joao.p',
    description:
      'Limitar 600 req/min por tenant com cabeçalhos X-RateLimit-*. Documentar no contrato público.',
    comments: [{ who: 'joao.p', text: 'Detalhes na descrição. Qualquer dúvida, comentem aqui.' }],
  },
  {
    project: 'web-app',
    iid: 170,
    title: 'Teste instável em checkout.spec.ts no CI',
    labels: ['bug', 'ci'],
    author: 'lucas.m',
    description:
      'Falha cerca de 1 a cada 8 execuções com "timeout waiting for payment intent". Só acontece no runner compartilhado.',
    comments: [{ who: 'lucas.m', text: 'Detalhes na descrição. Qualquer dúvida, comentem aqui.' }],
  },
  {
    project: 'web-app',
    iid: 171,
    title: 'Atualizar Node 20 para 22 em todos os repositórios',
    labels: ['infra', 'ci'],
    author: 'joao.p',
    description:
      'Node 20 entra em fim de suporte. Atualizar imagem do CI, .nvmrc e engines do package.json nos três repositórios.',
    comments: [],
  },
];

const DAY = 86_400_000;
const BASE_TIME = Date.parse('2026-10-01T12:00:00Z');

/** Implementação com dados de exemplo. Usada nos testes e no modo demonstração. */
export class MockGitLabClient implements GitLabClient {
  private extraComments = new Map<string, IssueComment[]>();
  private mrs = new Map<string, GitLabMr & { createdAt: number; mergeable: boolean }>();
  private nextMrIid = 88;
  private nextNoteId = 9000;

  constructor(
    private readonly opts: {
      failAuth?: boolean;
      /** Quanto tempo o pipeline simulado fica rodando antes de passar. */
      pipelineMs?: number;
      /** Pipeline simulado falha em vez de passar. */
      pipelineFails?: boolean;
    } = {},
  ) {}

  async currentUser(): Promise<GitLabUser> {
    if (this.opts.failAuth) throw new GitLabError('Token inválido, expirado ou revogado.', 401);
    return DEMO_USER;
  }

  async searchProjects(search?: string): Promise<GitLabProject[]> {
    const q = search?.toLowerCase() ?? '';
    return DEMO_PROJECTS.filter((p) => p.pathWithNamespace.includes(q));
  }

  async getProject(projectId: number): Promise<GitLabProject> {
    const p = DEMO_PROJECTS.find((x) => x.id === projectId);
    if (!p) throw new GitLabError('Não encontrado no GitLab. Confira a URL da instância.', 404);
    return p;
  }

  async listOpenIssues(project: GitLabProject): Promise<Issue[]> {
    return DEMO_ISSUES.filter((i) => i.project === project.name).map((i, n) => ({
      ref: issueRef(project.id, i.iid),
      projectId: project.id,
      projectPath: project.pathWithNamespace,
      iid: i.iid,
      title: i.title,
      description: i.description,
      labels: i.labels,
      author: i.author,
      state: 'opened' as const,
      updatedAt: new Date(BASE_TIME - n * DAY).toISOString(),
      commentCount: i.comments.length,
      webUrl: `${project.webUrl}/-/issues/${i.iid}`,
    }));
  }

  async listIssueComments(projectId: number, iid: number): Promise<IssueComment[]> {
    const project = DEMO_PROJECTS.find((p) => p.id === projectId);
    const issue = DEMO_ISSUES.find((i) => i.iid === iid && i.project === project?.name);
    if (!issue) throw new GitLabError('Não encontrado no GitLab. Confira a URL da instância.', 404);
    const base = issue.comments.map((c, n) => ({
      id: iid * 100 + n,
      author: c.who,
      body: c.text,
      createdAt: new Date(BASE_TIME - (issue.comments.length - n) * DAY).toISOString(),
      isAgent: false,
    }));
    return [...base, ...(this.extraComments.get(`i${projectId}#${iid}`) ?? [])];
  }

  async commentOnIssue(projectId: number, iid: number, body: string): Promise<void> {
    await this.listIssueComments(projectId, iid);
    this.addComment(`i${projectId}#${iid}`, body);
  }

  async createMergeRequest(
    projectId: number,
    o: { sourceBranch: string; targetBranch: string; title: string; description: string },
  ): Promise<GitLabMr> {
    const project = await this.getProject(projectId);
    if ([...this.mrs.values()].some((m) => m.sourceBranch === o.sourceBranch && m.state === 'opened'))
      throw new GitLabError('Já existe um MR aberto para este branch.', 409);
    const iid = this.nextMrIid++;
    const mr = {
      iid,
      ...o,
      state: 'opened' as const,
      pipelineStatus: 'running' as const,
      webUrl: `${project.webUrl}/-/merge_requests/${iid}`,
      updatedAt: new Date().toISOString(),
      createdAt: Date.now(),
      mergeable: true,
    };
    this.mrs.set(`${projectId}!${iid}`, mr);
    return this.view(mr);
  }

  async getMergeRequest(projectId: number, iid: number): Promise<GitLabMr> {
    return this.view(this.mr(projectId, iid));
  }

  async findOpenMergeRequest(projectId: number, sourceBranch: string): Promise<GitLabMr | null> {
    await this.getProject(projectId);
    const m = [...this.mrs.values()].find((x) => x.sourceBranch === sourceBranch && x.state === 'opened');
    return m ? this.view(m) : null;
  }

  /** Log simulado de um job de testes que falhou, comprido como os de verdade. */
  async failedJobLogs(projectId: number, iid: number): Promise<JobLog[]> {
    const m = this.mr(projectId, iid);
    if (this.view(m).pipelineStatus !== 'failed') return [];
    const noise = Array.from(
      { length: 1500 },
      (_, n) =>
        `\u001b[32m✓\u001b[0m test/unit/caso-${n}.spec.ts > comportamento ${n} (${(n % 9) + 1} ms) ` +
        `[info] POST /webhooks/charges 200 {"id":"evt_${String(n).padStart(5, '0')}","amount":4990,"currency":"BRL","attempt":1}`,
    );
    const trace = [
      '\u001b[0KRunning with gitlab-runner 17.0.0',
      'section_start:1700000000:step_script\r\u001b[0KExecuting "step_script" stage of the job script',
      '$ npm ci',
      'added 812 packages in 21s',
      '$ npm test',
      ...noise.slice(0, 900),
      '\u001b[31m✕\u001b[0m test/webhooks.spec.ts > não duplica a cobrança quando o webhook chega duas vezes',
      '  AssertionError: expected 2 to equal 1',
      '    at test/webhooks.spec.ts:42:31',
      ...noise.slice(900),
      'Tests: 1 failed, 1500 passed',
      'ERROR: Job failed: exit code 1',
    ].join('\n');
    return [{ jobId: 7001, name: 'test', stage: 'test', trace }];
  }

  /** O mock não tem os commits: o serviço de MRs usa o diff do worktree local. */
  async listMergeRequestDiffs(projectId: number, iid: number): Promise<MrDiffFile[]> {
    this.mr(projectId, iid);
    return [];
  }

  async listMergeRequestComments(projectId: number, iid: number): Promise<IssueComment[]> {
    this.mr(projectId, iid);
    return this.extraComments.get(`m${projectId}!${iid}`) ?? [];
  }

  async commentOnMergeRequest(projectId: number, iid: number, body: string): Promise<void> {
    this.mr(projectId, iid);
    this.addComment(`m${projectId}!${iid}`, body);
  }

  async mergeMergeRequest(projectId: number, iid: number): Promise<GitLabMr> {
    const m = this.mr(projectId, iid);
    if (m.state !== 'opened')
      throw new GitLabError('O GitLab recusou a operação: o MR não está aberto.', 405);
    if (this.view(m).pipelineStatus !== 'success')
      throw new GitLabError('O GitLab recusou a operação: o pipeline ainda não passou.', 405);
    m.state = 'merged';
    m.updatedAt = new Date().toISOString();
    return this.view(m);
  }

  private mr(projectId: number, iid: number) {
    const m = this.mrs.get(`${projectId}!${iid}`);
    if (!m) throw new GitLabError('Não encontrado no GitLab. Confira a URL da instância.', 404);
    return m;
  }

  /** O pipeline simulado roda por `pipelineMs` e depois passa (ou falha). */
  private view(m: GitLabMr & { createdAt: number }): GitLabMr {
    const done = Date.now() - m.createdAt >= (this.opts.pipelineMs ?? 20_000);
    const pipelineStatus = done ? (this.opts.pipelineFails ? 'failed' : 'success') : 'running';
    return {
      iid: m.iid,
      title: m.title,
      description: m.description,
      sourceBranch: m.sourceBranch,
      targetBranch: m.targetBranch,
      state: m.state,
      pipelineStatus,
      webUrl: m.webUrl,
      updatedAt: m.updatedAt,
    };
  }

  private addComment(key: string, raw: string): void {
    const agent = parseAgentNote(raw);
    const list = this.extraComments.get(key) ?? [];
    list.push({
      id: this.nextNoteId++,
      author: agent?.agent ?? DEMO_USER.username,
      body: agent?.body ?? raw,
      createdAt: new Date().toISOString(),
      isAgent: !!agent,
    });
    this.extraComments.set(key, list);
  }
}
