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
