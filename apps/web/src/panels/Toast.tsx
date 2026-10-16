import { useEffect, useState } from 'react';
import { useStore } from '../state/store.ts';

/** Aviso no rodapé do canvas, com "Desfazer" (ou uma ação própria). Some sozinho. */
export function Toast() {
  const toast = useStore((s) => s.toast);
  const hide = useStore((s) => s.hideToast);
  const undo = useStore((s) => s.undo);
  // mantém o texto durante a animação de saída
  const [shown, setShown] = useState(toast);
  useEffect(() => {
    if (toast) setShown(toast);
  }, [toast]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(hide, toast.action ? 7000 : 6000);
    return () => clearTimeout(t);
  }, [toast, hide]);

  return (
    <div className={`toast${toast ? ' show' : ''}`} role="status" aria-live="polite">
      <span>{shown?.msg}</span>
      <kbd hidden={!!shown?.action}>Ctrl/⌘ Z</kbd>
      <button
        className="btn sm"
        onClick={() => {
          if (toast?.action) {
            useStore.setState({ toast: null });
            toast.action.run();
          } else undo();
        }}
      >
        {shown?.action ? shown.action.label : 'Desfazer'}
      </button>
    </div>
  );
}
