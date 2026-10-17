import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteBody } from './NoteBody.tsx';

function Harness({ initial, onCommit = () => {} }: { initial: string; onCommit?(): void }) {
  const [v, setV] = useState(initial);
  return <NoteBody value={v} onChange={setV} onCommit={onCommit} placeholder="Escreva" />;
}

afterEach(cleanup);

describe('NoteBody', () => {
  it('nota com texto abre formatada; clique edita; sair grava e volta à prévia', () => {
    const commit = vi.fn();
    const { container } = render(<Harness initial={'# Regra\n\n- **sem** desconto'} onCommit={commit} />);
    expect(container.querySelector('h1')?.textContent).toBe('Regra');
    expect(container.querySelector('strong')?.textContent).toBe('sem');
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button'));
    const area = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(area.value).toBe('# Regra\n\n- **sem** desconto');
    expect(document.activeElement).toBe(area);

    fireEvent.change(area, { target: { value: 'Agora `x`' } });
    act(() => area.blur());
    expect(commit).toHaveBeenCalledOnce();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('x');
  });

  it('nota vazia começa editando e continua editando se sair vazia', () => {
    render(<Harness initial="" />);
    const area = screen.getByRole('textbox');
    fireEvent.blur(area);
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('clique num link não entra na edição', () => {
    render(<Harness initial="[doc](https://x.dev)" />);
    fireEvent.click(screen.getByRole('link'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
