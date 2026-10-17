import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Configurações não secretas (URL do GitLab, pasta dos repositórios, usuário validado). */
export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

/** Projetos do GitLab escolhidos para o canvas. */
export const repo = sqliteTable('repo', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  gitlabProjectId: integer('gitlab_project_id').notNull().unique(),
  pathWithNamespace: text('path_with_namespace').notNull(),
  name: text('name').notNull(),
  localPath: text('local_path'),
  defaultBranch: text('default_branch'),
  description: text('description'),
  webUrl: text('web_url').notNull(),
  /** Repositório local escolhido pela pasta (id negativo, fora do GitLab do app). */
  local: integer('local', { mode: 'boolean' }).notNull().default(false),
});

export const issueCache = sqliteTable(
  'issue_cache',
  {
    projectId: integer('project_id').notNull(),
    iid: integer('iid').notNull(),
    projectPath: text('project_path').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    labels: text('labels', { mode: 'json' }).$type<string[]>().notNull(),
    author: text('author').notNull(),
    state: text('state', { enum: ['opened', 'closed'] }).notNull(),
    updatedAt: text('updated_at').notNull(),
    commentCount: integer('comment_count').notNull(),
    webUrl: text('web_url').notNull(),
    fetchedAt: text('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.iid] })],
);

export const node = sqliteTable(
  'node',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['issue', 'agent', 'mr', 'note'] }).notNull(),
    refId: text('ref_id').notNull(),
    x: real('x').notNull(),
    y: real('y').notNull(),
    createdAt: text('created_at').notNull(),
    /** Remoção suave, para o desfazer. */
    removedAt: text('removed_at'),
    /**
     * Arquivado junto com a issue (também tem removedAt, então some do canvas). A limpeza dos
     * removidos não apaga arquivados; restaurar devolve o grupo inteiro (mesmo carimbo).
     */
    archivedAt: text('archived_at'),
  },
  (t) => [index('node_ref_idx').on(t.type, t.refId)],
);

export const edge = sqliteTable('edge', {
  id: text('id').primaryKey(),
  fromNodeId: text('from_node_id').notNull(),
  toNodeId: text('to_node_id').notNull(),
  kind: text('kind', { enum: ['issue', 'spawn', 'mr', 'note'] }).notNull(),
});

export const note = sqliteTable('note', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  isHandoff: integer('is_handoff', { mode: 'boolean' }).notNull().default(false),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const noteLink = sqliteTable(
  'note_link',
  {
    noteId: text('note_id').notNull(),
    targetNodeId: text('target_node_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.targetNodeId] })],
);

export const activity = sqliteTable('activity', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  ts: text('ts').notNull(),
});

export const agent = sqliteTable('agent', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role', { enum: ['main', 'orchestrator', 'sub', 'reviewer', 'fix'] }).notNull(),
  parentId: text('parent_id'),
  issueRef: text('issue_ref'),
  repos: text('repos', { mode: 'json' }).$type<number[]>().notNull(),
  instruction: text('instruction'),
  title: text('title').notNull(),
  branch: text('branch'),
  worktreePath: text('worktree_path'),
  sessionId: text('session_id'),
  status: text('status', {
    enum: ['idle', 'queued', 'running', 'waiting', 'coordinating', 'paused', 'done', 'stopped', 'error'],
  }).notNull(),
  error: text('error'),
  depth: integer('depth').notNull().default(0),
  maxDepth: integer('max_depth').notNull().default(0),
  openMr: integer('open_mr', { mode: 'boolean' }).notNull().default(false),
  /** Os agentes de antes do modo automático continuam pedindo permissão. */
  autoMode: integer('auto_mode', { mode: 'boolean' }).notNull().default(false),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  contextTokens: integer('context_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  /** Plano em checklist publicado com report_plan. */
  plan: text('plan', { mode: 'json' }).$type<{ text: string; done: boolean; agentId?: string | null }[]>(),
  /** MR em que o agente trabalha sem ser o autor (fix e reviewer). */
  mrRef: text('mr_ref'),
  createdAt: text('created_at').notNull(),
});

export const agentEvent = sqliteTable(
  'agent_event',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id').notNull(),
    ts: text('ts').notNull(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    /** Linha original do stream-json, para o modo "saída bruta". */
    raw: text('raw'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
  },
  (t) => [index('agent_event_agent_idx').on(t.agentId, t.id)],
);

export const approval = sqliteTable('approval', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  toolName: text('tool_name').notNull(),
  input: text('input', { mode: 'json' }).notNull(),
  toolUseId: text('tool_use_id'),
  summary: text('summary').notNull(),
  suggestedRule: text('suggested_rule').notNull(),
  status: text('status', { enum: ['pending', 'allowed', 'denied'] }).notNull(),
  decidedBy: text('decided_by'),
  createdAt: text('created_at').notNull(),
});

export const policy = sqliteTable('policy', {
  id: text('id').primaryKey(),
  pattern: text('pattern').notNull(),
  scope: text('scope').notNull(),
  createdAt: text('created_at').notNull(),
});

/** MRs que o canvas conhece (abertos por agentes), com o último estado lido do GitLab. */
export const mergeRequestCache = sqliteTable(
  'merge_request_cache',
  {
    projectId: integer('project_id').notNull(),
    iid: integer('iid').notNull(),
    projectPath: text('project_path').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    sourceBranch: text('source_branch').notNull(),
    targetBranch: text('target_branch').notNull(),
    state: text('state', { enum: ['opened', 'merged', 'closed', 'locked'] }).notNull(),
    pipelineStatus: text('pipeline_status').notNull(),
    webUrl: text('web_url').notNull(),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    agentId: text('agent_id'),
    issueRef: text('issue_ref'),
    /** Último comentário já visto pelo poller (nulo: ainda não leu a discussão). */
    seenCommentId: integer('seen_comment_id'),
    /** Agentes fix já acionados para este MR (a automação para no limite). */
    fixAttempts: integer('fix_attempts').notNull().default(0),
    /** Revisão local enviada ao remoto: link do MR (GitLab) ou da página do PR (GitHub). */
    remoteUrl: text('remote_url'),
    publishedTo: text('published_to', { enum: ['gitlab', 'github', 'other'] }),
    updatedAt: text('updated_at').notNull(),
    fetchedAt: text('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.iid] })],
);

/**
 * Itens de contexto por agente. Os itens que vêm dos vínculos do canvas (issue, repositório,
 * notas ligadas) só ganham linha aqui para guardar resumo ou exclusão; os escolhidos à mão
 * têm `added`.
 */
export const contextItem = sqliteTable(
  'context_item',
  {
    agentId: text('agent_id').notNull(),
    kind: text('kind', {
      enum: ['issue', 'repo', 'note', 'file', 'pipeline_log', 'mr_diff', 'plan'],
    }).notNull(),
    ref: text('ref').notNull(),
    added: integer('added', { mode: 'boolean' }).notNull().default(false),
    excluded: integer('excluded', { mode: 'boolean' }).notNull().default(false),
    /** Resumo usado no context.md no lugar do conteúdo completo. */
    summary: text('summary'),
    /** Hash do conteúdo que foi resumido: se o conteúdo mudar, o resumo deixa de valer. */
    contentHash: text('content_hash'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.kind, t.ref] })],
);

/** Perguntas dos agentes ao usuário (ask_human), respondidas na aba Ações. */
export const question = sqliteTable('question', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  text: text('text').notNull(),
  options: text('options', { mode: 'json' }).$type<string[]>().notNull(),
  answer: text('answer'),
  status: text('status', { enum: ['pending', 'answered', 'cancelled'] }).notNull(),
  createdAt: text('created_at').notNull(),
});
