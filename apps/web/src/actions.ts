import { focusNode, freeSpot, viewCenter } from './canvas/viewport.ts';
import { issueNodeOf, useStore } from './state/store.ts';

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
