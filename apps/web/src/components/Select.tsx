import { useEffect, useId, useRef, useState } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  /** Linha menor abaixo do rótulo. */
  hint?: string;
}

/**
 * Seletor com o visual do app no lugar do <select> nativo: botão + lista que abre por cima,
 * com teclado (↑↓, Enter, Esc, letras para pular) e clique fora para fechar.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = 'Escolher…',
  label,
  className = '',
}: {
  value: string;
  options: SelectOption[];
  onChange(value: string): void;
  placeholder?: string;
  /** Nome acessível do campo. */
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const cur = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => {
    list.current?.children[idx]?.scrollIntoView({ block: 'nearest' });
  }, [idx, open]);

  const pick = (o: SelectOption | undefined) => {
    if (!o) return;
    onChange(o.value);
    setOpen(false);
  };
  const show = () => {
    setIdx(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  };

  return (
    <div className={`sel ${className}`} ref={box}>
      <button
        type="button"
        className="field sel-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        aria-controls={id}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            show();
          } else if (open && e.key === 'ArrowDown') {
            e.preventDefault();
            setIdx(Math.min(idx + 1, options.length - 1));
          } else if (open && e.key === 'ArrowUp') {
            e.preventDefault();
            setIdx(Math.max(idx - 1, 0));
          } else if (open && e.key === 'Enter') {
            e.preventDefault();
            pick(options[idx]);
          } else if (open && e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if (open && e.key.length === 1) {
            const k = options.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
            if (k >= 0) setIdx(k);
          }
        }}
      >
        <span className={cur ? '' : 'sel-ph'}>{cur?.label ?? placeholder}</span>
        <span className="sel-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="sel-list" role="listbox" id={id} ref={list}>
          {options.length === 0 && <li className="sel-empty">Nada para escolher.</li>}
          {options.map((o, k) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`${k === idx ? 'act' : ''}${o.value === value ? ' on' : ''}`}
              onPointerEnter={() => setIdx(k)}
              onClick={() => pick(o)}
            >
              <span className="sel-l">{o.label}</span>
              {o.hint && <small>{o.hint}</small>}
              {o.value === value && (
                <span className="sel-ck" aria-hidden="true">
                  ✓
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
