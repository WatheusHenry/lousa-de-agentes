import { detectRepos } from '@agent-canvas/shared';
import { focusNode, freeSpot, revealWhenReady, viewCenter } from './canvas/viewport.ts';
import { agentNodeOf, issueNodeOf, useStore } from './state/store.ts';

/** Ações de alto nível, usadas pela barra lateral, menus, painel e atalhos. */

export function addIssue(ref: string, at?: { x: number; y: number }) {
  const st = useStore.getState();
  const existing = issueNodeOf(st, ref);
  if (existing) {
    focusNode(existing.id);
    return existing.id;
  }
  const c = at ?? viewCenter();
  const pos = freeSpot({ x: c.x - 142, y: c.y - 70 }, 284, 160);
  const id = st.placeIssue(ref, pos);
  st.select(id);
  st.setSideOpen(false);
  return id;
}

/** Cria uma nota centrada em `at` (ou no meio da tela) e põe o cursor no título. */
export function newNoteAt(at?: { x: number; y: number }, linkTo?: string) {
  const st = useStore.getState();
  const c = at ?? viewCenter();
  const pos = freeSpot({ x: c.x - 135, y: c.y - 90 }, 270, 200);
  const { nodeId } = st.createNote(pos, linkTo);
  st.select(nodeId);
  focusNoteTitle(nodeId);
  return nodeId;
}

/** Nota nova ao lado de um item, já vinculada a ele. */
export function noteFor(targetNodeId: string) {
  const st = useStore.getState();
  const t = st.nodes[targetNodeId];
  if (!t) return null;
  const nodeId = newNoteAt({ x: t.x + 284 + 60 + 135, y: t.y + 90 }, targetNodeId);
  return nodeId;
}

/** O React Flow só mostra o nó depois de medi-lo; espera ele aparecer para pôr o cursor no título. */
export function focusNoteTitle(nodeId: string, tries = 30) {
  const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`);
  const input = node?.querySelector<HTMLInputElement>('.ntitle-in');
  if (input && node && getComputedStyle(node).visibility !== 'hidden') {
    input.focus({ preventScroll: true });
    input.select();
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusNoteTitle(nodeId, tries - 1));
}

/** Agente novo no canvas: em branco (espera contexto e a primeira instrução) ou já com repositório. */
export function newAgentAt(at?: { x: number; y: number }, opts: { repos?: number[] } = {}) {
  const st = useStore.getState();
  const c = at ?? viewCenter();
  const pos = freeSpot({ x: c.x - 200, y: c.y - 160 }, 400, 330);
  const { nodeId } = st.createAgent({ at: pos, ...(opts.repos ? { repos: opts.repos } : {}) });
  st.setSideOpen(false);
  revealWhenReady(nodeId);
  focusComposer(nodeId);
  return nodeId;
}

/** Inicia um agente para a issue, abaixo do cartão dela. */
export function startIssueAgent(
  issueNodeId: string,
  extra?: string,
  opts: { repos?: number[]; maxDepth?: number; openMr?: boolean } = {},
) {
  const st = useStore.getState();
  const n = st.nodes[issueNodeId];
  if (!n || n.type !== 'issue') return null;
  const pos = freeSpot({ x: n.x - 58, y: n.y + 220 }, 400, 330);
  const { nodeId } = st.createAgent({
    at: pos,
    issueRef: n.refId,
    instruction: extra?.trim() || 'Resolva a issue.',
    fromNodeId: issueNodeId,
    ...(opts.repos?.length ? { repos: opts.repos } : {}),
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    ...(opts.openMr !== undefined ? { openMr: opts.openMr } : {}),
  });
  revealWhenReady(nodeId);
  return nodeId;
}

/**
 * "Iniciar" no cartão da issue, com as mesmas escolhas do painel: num repositório só, começa
 * na hora (sem sub-agentes, abrindo MR ao final). Se a issue cita outros repositórios, abre o
 * painel no botão de iniciar, para o usuário conferir antes de criar um orquestrador.
 */
export function startFromCard(issueNodeId: string): string | null {
  const st = useStore.getState();
  const n = st.nodes[issueNodeId];
  const issue = n ? st.issues[n.refId] : undefined;
  if (!n || !issue) return null;
  const repos = detectRepos(issue, st.settings?.projects ?? []);
  if (repos.length === 1)
    return startIssueAgent(issueNodeId, undefined, { repos, maxDepth: 0, openMr: true });
  st.openFocus(null);
  st.select(issueNodeId);
  focusStartButton();
  return null;
}

/** Rola o painel até o botão de iniciar da issue e foca nele (o painel pode ainda estar abrindo). */
function focusStartButton(tries = 30) {
  const btn = document.querySelector<HTMLButtonElement>('.insp.open .insp-cta .btn.primary');
  if (btn) {
    btn.scrollIntoView({ block: 'nearest' });
    btn.focus({ preventScroll: true });
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusStartButton(tries - 1));
}

/**
 * Repositório ou issue solto em cima de um agente. No agente em branco, define o repositório e a
 * issue da tarefa; depois disso (ou se já estão definidos), entra como item extra de contexto.
 */
export function giveContext(agentId: string, kind: 'repo' | 'issue', val: string) {
  const st = useStore.getState();
  const a = st.agents[agentId];
  if (!a) return;
  const node = agentNodeOf(st, agentId);
  if (node) st.select(node.id);
  if (!a.worktreePath && kind === 'repo' && !a.repos.length)
    return st.updateAgent(agentId, { repos: [Number(val)] });
  if (!a.worktreePath && kind === 'issue' && !a.issueRef) return st.updateAgent(agentId, { issueRef: val });
  if ((kind === 'repo' && a.repos[0] === Number(val)) || (kind === 'issue' && a.issueRef === val)) return;
  st.contextAdd(agentId, kind, val);
}

export function focusComposer(nodeId: string, tries = 30) {
  const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`);
  const input = node?.querySelector<HTMLInputElement>('.composer input');
  if (input && node && getComputedStyle(node).visibility !== 'hidden') {
    input.focus({ preventScroll: true });
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusComposer(nodeId, tries - 1));
}

/** "Abrir MR agora": pede ao agente que abra o MR pela ferramenta do canvas. */
export function askOpenMr(agentId: string) {
  useStore
    .getState()
    .messageAgent(
      agentId,
      'Abra o merge request agora: faça commit do que estiver pronto, rode os testes relevantes e chame a ferramenta open_merge_request. Não faça merge.',
    );
}

/** Pipeline com falha: o bridge cria (ou retoma) o agente fix do MR. */
export function fixPipeline(mrRef: string) {
  useStore.getState().fixMr(mrRef);
}
