import { z } from 'zod';
import { Activity, CanvasEdge, CanvasNode, Note, NoteLink } from './canvas.ts';
import { Issue, IssueRef } from './gitlab.ts';
import { SettingsView } from './settings.ts';

/** Nome do cabeçalho / parâmetro com o token de sessão do bridge. */
export const SESSION_HEADER = 'x-agent-canvas-token';
export const SESSION_QUERY = 'token';
/** Meta tag em que o index.html recebe o token de sessão. */
export const SESSION_META = 'agent-canvas-token';

/** GET /state: tudo o que o front precisa para desenhar o canvas. */
export const StateSnapshot = z.object({
  settings: SettingsView,
  nodes: z.array(CanvasNode),
  edges: z.array(CanvasEdge),
  notes: z.array(Note),
  noteLinks: z.array(NoteLink),
  /** Issues referenciadas por nós do canvas (do cache local). */
  issues: z.array(Issue),
  activity: z.array(Activity),
});
export type StateSnapshot = z.infer<typeof StateSnapshot>;

const Id = z.string().min(1).max(64);
const Coord = z.number().finite();

// ---------- cliente → servidor ----------

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('issue.place'),
    nodeId: Id,
    issueRef: IssueRef,
    x: Coord,
    y: Coord,
  }),
  z.object({ type: z.literal('node.move'), nodeId: Id, x: Coord, y: Coord }),
  /** Remoção suave: o nó some, mas pode voltar com node.restore (desfazer). */
  z.object({ type: z.literal('node.remove'), nodeId: Id }),
  z.object({ type: z.literal('node.restore'), nodeId: Id }),
  z.object({
    type: z.literal('note.create'),
    nodeId: Id,
    note: Note.pick({ id: true, title: true, body: true }),
    x: Coord,
    y: Coord,
  }),
  z.object({
    type: z.literal('note.update'),
    noteId: Id,
    title: Note.shape.title.optional(),
    body: Note.shape.body.optional(),
  }),
  z.object({ type: z.literal('note.link'), edgeId: Id, noteId: Id, targetNodeId: Id }),
  z.object({ type: z.literal('note.unlink'), noteId: Id, targetNodeId: Id }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------- servidor → cliente ----------

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), serverVersion: z.string() }),
  z.object({ type: z.literal('node.upsert'), node: CanvasNode }),
  z.object({ type: z.literal('node.remove'), nodeId: Id }),
  z.object({ type: z.literal('edge.upsert'), edge: CanvasEdge }),
  z.object({ type: z.literal('edge.remove'), edgeId: Id }),
  z.object({ type: z.literal('note.upsert'), note: Note }),
  z.object({ type: z.literal('noteLink.upsert'), link: NoteLink }),
  z.object({ type: z.literal('noteLink.remove'), link: NoteLink }),
  z.object({ type: z.literal('issue.upsert'), issue: Issue }),
  z.object({ type: z.literal('settings.updated'), settings: SettingsView }),
  z.object({ type: z.literal('activity'), text: z.string(), ts: z.string() }),
  z.object({ type: z.literal('error'), message: z.string(), cause: z.string().optional() }),
  /**
   * Quando o servidor recarrega o estado (ex.: restaurar um nó traz arestas e notas junto),
   * manda o snapshot inteiro em vez de várias mensagens soltas.
   */
  z.object({ type: z.literal('state.snapshot'), state: StateSnapshot }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
