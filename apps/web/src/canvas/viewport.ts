import type { Edge, ReactFlowInstance } from '@xyflow/react';
import type { FlowNode } from './flow.ts';
import { useStore } from '../state/store.ts';

/** Acesso à câmera do React Flow fora do componente do canvas (barra lateral, menus, atalhos). */
let rf: ReactFlowInstance<FlowNode, Edge> | null = null;
let el: HTMLElement | null = null;

export function bindViewport(
  instance: ReactFlowInstance<FlowNode, Edge> | null,
  element: HTMLElement | null,
) {
  rf = instance;
  el = element;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const dur = (ms: number) => (reducedMotion() ? 0 : ms);

/** Área do canvas que não fica atrás dos painéis flutuantes (como no protótipo). */
export function safeArea() {
  const W = el?.clientWidth ?? innerWidth;
  const H = el?.clientHeight ?? innerHeight;
  const wide = W > 860;
  const s = useStore.getState();
  const left = wide && !s.sideHidden ? 320 : 0;
  const right = wide && (s.selected || s.panel) ? 396 : 0;
  return { x: left, y: 56, w: W - left - right, h: H - 56 - (wide ? 16 : 70) };
}

/** Centro da área livre, em coordenadas do canvas. */
export function viewCenter() {
  const v = rf?.getViewport() ?? { x: 0, y: 0, zoom: 1 };
  const A = safeArea();
  return { x: (A.x + A.w / 2 - v.x) / v.zoom, y: (A.y + A.h / 2 - v.y) / v.zoom };
}

export function screenToFlow(clientX: number, clientY: number) {
  return rf ? rf.screenToFlowPosition({ x: clientX, y: clientY }) : { x: clientX, y: clientY };
}

const sizeOf = (id: string) => {
  const n = rf?.getInternalNode(id);
  return {
    x: n?.internals.positionAbsolute.x ?? 0,
    y: n?.internals.positionAbsolute.y ?? 0,
    w: n?.measured.width ?? 284,
    h: n?.measured.height ?? 160,
  };
};

/** Enquadra todos os nós na área livre. */
export function fit(animate = true) {
  if (!rf) return;
  const ids = rf.getNodes().map((n) => n.id);
  if (!ids.length) return;
  let a = 1e9,
    b = 1e9,
    c = -1e9,
    d = -1e9;
  for (const id of ids) {
    const r = sizeOf(id);
    a = Math.min(a, r.x);
    b = Math.min(b, r.y);
    c = Math.max(c, r.x + r.w);
    d = Math.max(d, r.y + r.h);
  }
  const A = safeArea();
  const pad = 36;
  const k = Math.max(0.2, Math.min(1, (A.w - pad * 2) / (c - a), (A.h - pad * 2) / (d - b)));
  rf.setViewport(
    {
      zoom: k,
      x: A.x + (A.w - (c - a) * k) / 2 - a * k,
      y: A.y + Math.max(pad * 0.4, (A.h - (d - b) * k) / 2) - b * k,
    },
    { duration: animate ? dur(300) : 0 },
  );
}

/** Seleciona e centraliza um nó na área livre. */
export function focusNode(id: string) {
  useStore.getState().select(id);
  if (!rf) return;
  // espera o painel da direita abrir para calcular a área livre
  requestAnimationFrame(() => {
    if (!rf) return;
    const k = rf.getViewport().zoom;
    const r = sizeOf(id);
    const A = safeArea();
    rf.setViewport(
      {
        zoom: k,
        x: A.x + A.w / 2 - (r.x + r.w / 2) * k,
        y: A.y + Math.min(A.h / 2, (A.h - r.h * k) / 2 + (r.h * k) / 2) - (r.y + r.h / 2) * k,
      },
      { duration: dur(300) },
    );
  });
}

export function zoomBy(f: number) {
  if (!rf) return;
  const v = rf.getViewport();
  const W = el?.clientWidth ?? innerWidth;
  const H = el?.clientHeight ?? innerHeight;
  const k = Math.min(1.6, Math.max(0.2, v.zoom * f));
  const cx = W / 2;
  const cy = H / 2;
  rf.setViewport(
    { zoom: k, x: cx - ((cx - v.x) * k) / v.zoom, y: cy - ((cy - v.y) * k) / v.zoom },
    { duration: dur(200) },
  );
}

/** Procura um lugar livre perto de `at` para um cartão de w×h (como o freeSpot do protótipo). */
export function freeSpot(at: { x: number; y: number }, w: number, h: number) {
  const rects = (rf?.getNodes() ?? []).map((n) => sizeOf(n.id));
  const free = (x: number, y: number) =>
    !rects.some((r) => x < r.x + r.w + 30 && x + w + 30 > r.x && y < r.y + r.h + 30 && y + h + 30 > r.y);
  const x = at.x;
  let y = at.y;
  if (free(x, y)) return { x, y };
  for (let i = 0; i < 60; i++) {
    y += 50;
    if (free(x, y)) return { x, y };
  }
  return at;
}

export function nodeScreenRect(id: string): DOMRect | null {
  return el?.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect() ?? null;
}

export const canvasElement = () => el;
