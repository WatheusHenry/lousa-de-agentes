import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ReactFlow,
  useReactFlow,
  type NodeChange,
  type OnConnectStart,
  type Viewport,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { addIssue, giveContext, newAgentAt, newNoteAt } from '../actions.ts';
import { IssueNode } from '../nodes/IssueNode.tsx';
import { MrNode } from '../nodes/MrNode.tsx';
import { NoteNode } from '../nodes/NoteNode.tsx';
import { AgentNode } from '../nodes/AgentNode.tsx';
import { useStore } from '../state/store.ts';
import { openContextMenu } from './ContextMenu.tsx';
import { EdgeMarkers, FloatingEdge } from './FloatingEdge.tsx';
import { toFlowEdge, toFlowNode, type FlowNode } from './flow.ts';
import { bindViewport, fit, screenToFlow } from './viewport.ts';

const nodeTypes = { issue: IssueNode, note: NoteNode, agent: AgentNode, mr: MrNode };
const edgeTypes = { floating: FloatingEdge };
const VIEW_KEY = 'ac-viewport';

function readViewport(): Viewport | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null') as Viewport | null;
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom) ? v : null;
  } catch {
    return null;
  }
}

export function Canvas() {
  const rf = useReactFlow<FlowNode>();
  const wrapper = useRef<HTMLDivElement>(null);
  const storeNodes = useStore((s) => s.nodes);
  const storeEdges = useStore((s) => s.edges);
  const selected = useStore((s) => s.selected);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [linking, setLinking] = useState<{ noteId: string; hover: string | null } | null>(null);
  const [dropping, setDropping] = useState(false);

  // espelha os nós do bridge no React Flow, sem perder medidas nem o arrasto em andamento
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return Object.values(storeNodes)
        .filter((n) => n.type in nodeTypes)
        .map((n) => toFlowNode(n, selected === n.id, byId.get(n.id)));
    });
  }, [storeNodes, selected]);

  const edges = useMemo(
    () =>
      Object.values(storeEdges)
        .filter((e) => storeNodes[e.fromNodeId] && storeNodes[e.toNodeId])
        .map(toFlowEdge),
    [storeEdges, storeNodes],
  );

  useEffect(() => {
    bindViewport(rf, wrapper.current);
    return () => bindViewport(null, null);
  }, [rf]);

  // primeira abertura: volta para a última câmera, ou enquadra tudo
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !nodes.length || !nodes.every((n) => n.measured?.width)) return;
    initialized.current = true;
    const saved = readViewport();
    if (saved) rf.setViewport(saved);
    else fit(false);
  }, [nodes, rf]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
    for (const c of changes) {
      // fim do arrasto: grava a posição no bridge
      if (c.type === 'position' && c.dragging === false && c.position)
        useStore.getState().moveNode(c.id, c.position.x, c.position.y);
    }
  }, []);

  // ---------- vincular nota arrastando o "+" ----------
  const onConnectStart: OnConnectStart = useCallback((_e, { nodeId }) => {
    const n = nodeId && useStore.getState().nodes[nodeId];
    if (n && n.type === 'note') setLinking({ noteId: n.refId, hover: null });
  }, []);

  const targetAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.react-flow__node');
    const id = el?.dataset.id;
    const n = id && useStore.getState().nodes[id];
    return n && (n.type === 'issue' || n.type === 'agent') ? n.id : null;
  };

  useEffect(() => {
    if (!linking) return;
    const move = (e: PointerEvent) => {
      const hover = targetAt(e.clientX, e.clientY);
      setLinking((l) => (l && l.hover !== hover ? { ...l, hover } : l));
    };
    addEventListener('pointermove', move);
    return () => removeEventListener('pointermove', move);
  }, [linking]);

  useEffect(() => {
    document.querySelectorAll('.react-flow__node.linkt').forEach((el) => el.classList.remove('linkt'));
    if (linking?.hover)
      document.querySelector(`.react-flow__node[data-id="${linking.hover}"]`)?.classList.add('linkt');
  }, [linking?.hover]);

  const onConnectEnd = useCallback(
    (e: globalThis.MouseEvent | TouchEvent) => {
      const p = 'changedTouches' in e ? e.changedTouches[0]! : e;
      const target = targetAt(p.clientX, p.clientY);
      if (linking && target) useStore.getState().linkNote(linking.noteId, target);
      setLinking(null);
    },
    [linking],
  );

  // ---------- arrastar da barra lateral ----------
  // soltar em cima de um agente dá contexto a ele (destaque .dropt, como no protótipo)
  const agentUnder = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.react-flow__node');
    const n = el?.dataset.id ? useStore.getState().nodes[el.dataset.id] : undefined;
    return n?.type === 'agent' ? { el: el!, agentId: n.refId } : null;
  };
  const markDrop = (el: HTMLElement | null) => {
    document
      .querySelectorAll('.react-flow__node.dropt')
      .forEach((x) => x !== el && x.classList.remove('dropt'));
    el?.classList.add('dropt');
  };
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const target = agentUnder(e.clientX, e.clientY);
    markDrop(target?.el ?? null);
    setDropping(!target);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    markDrop(null);
    const [kind, ...rest] = e.dataTransfer.getData('text/plain').split(':');
    const val = rest.join(':');
    if ((kind !== 'issue' && kind !== 'repo') || !val) return;
    const target = agentUnder(e.clientX, e.clientY);
    if (target) return giveContext(target.agentId, kind, val);
    const at = screenToFlow(e.clientX, e.clientY);
    if (kind === 'issue') addIssue(val, at);
    else newAgentAt(at, { repos: [Number(val)] });
  };

  // duplo clique no fundo cria uma nota ali
  const onDoubleClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return;
    newNoteAt(screenToFlow(e.clientX, e.clientY));
  };

  const saveViewport = useCallback((_: unknown, v: Viewport) => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(v));
    } catch {
      /* sem armazenamento: só não lembra a câmera */
    }
  }, []);

  return (
    <div
      ref={wrapper}
      className={`canvas${linking ? ' linking' : ''}${dropping ? ' drop' : ''}`}
      aria-label="Canvas de orquestração"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (wrapper.current?.contains(e.relatedTarget as Node)) return;
        setDropping(false);
        markDrop(null);
      }}
      onDrop={onDrop}
      onDoubleClick={onDoubleClick}
    >
      <EdgeMarkers />
      <ReactFlow<FlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => useStore.getState().select(n.id)}
        onNodeDragStart={(_, n) => useStore.getState().select(n.id)}
        onNodeDoubleClick={(e, n) => {
          if ((e.target as HTMLElement).closest('input,textarea,button,select')) return;
          useStore.getState().openFocus(n.id);
        }}
        onPaneClick={() => useStore.getState().select(null)}
        onPaneContextMenu={(e) => openContextMenu(e as MouseEvent, null)}
        onNodeContextMenu={(e, n) => {
          if ((e.target as HTMLElement).closest('input,textarea')) return; // texto mantém o menu do navegador
          openContextMenu(e, n.id);
        }}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onMoveEnd={saveViewport}
        isValidConnection={() => false}
        connectionRadius={0}
        nodesConnectable
        elementsSelectable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomOnDoubleClick={false}
        zoomOnScroll={false}
        panOnScroll
        zoomActivationKeyCode={['Control', 'Meta']}
        minZoom={0.2}
        maxZoom={1.6}
        defaultViewport={{ x: 40, y: 30, zoom: 1 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={2} color="#d6d6db" bgColor="#f2f2f4" />
      </ReactFlow>
    </div>
  );
}
