/// <reference lib="dom" />
/**
 * Funções que rodam dentro da página (Runtime.evaluate). Ficam como funções de verdade para o
 * TypeScript conferir; vão para o Chrome como texto, via `.toString()`.
 */

/**
 * Retrato da página em texto para o agente: títulos, textos e elementos interativos com uma
 * referência [n] para clicar e digitar. Entra em shadow roots (componentes web). As referências
 * ficam em window.__acRefs até o próximo retrato.
 */
function snapshotPage(maxChars: number): string {
  type W = Window & { __acRefs?: Map<number, Element> };
  const w = window as W;
  const refs = new Map<number, Element>();
  w.__acRefs = refs;
  const lines: string[] = [];
  let size = 0;
  let cut = false;
  const push = (depth: number, line: string) => {
    if (cut) return;
    const l = '  '.repeat(Math.min(depth, 8)) + line;
    if (size + l.length > maxChars) {
      cut = true;
      return;
    }
    lines.push(l);
    size += l.length + 1;
  };
  const clean = (s: string | null | undefined, max = 100) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const hidden = (el: Element) => {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return true;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0 && st.display !== 'contents' && !el.children.length;
  };
  const roleOf = (el: Element): string | null => {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type;
      if (t === 'hidden') return null;
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      return 'textbox';
    }
    if ((el as HTMLElement).isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    if (el.hasAttribute('onclick') || (el.getAttribute('tabindex') ?? '-1') !== '-1') return 'clickable';
    return null;
  };
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (clean(t)) return clean(t);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) return clean([...labels].map((l) => l.textContent).join(' '));
    const text = clean((el as HTMLElement).innerText);
    if (text) return text;
    return clean(
      el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        (el as HTMLInputElement).value ||
        el.querySelector('img')?.getAttribute('alt') ||
        '',
    );
  };
  const stateOf = (el: Element): string => {
    const out: string[] = [];
    const i = el as HTMLInputElement;
    const tag = el.tagName.toLowerCase();
    if ((tag === 'input' || tag === 'textarea') && i.type !== 'checkbox' && i.type !== 'radio') {
      if (i.type === 'password') out.push(i.value ? 'value=***' : 'value=""');
      else out.push(`value="${clean(i.value, 80)}"`);
      if (i.placeholder && nameOf(el) !== clean(i.placeholder))
        out.push(`placeholder="${clean(i.placeholder, 60)}"`);
    }
    if (tag === 'select') {
      const s = el as HTMLSelectElement;
      out.push(`value="${clean(s.selectedOptions[0]?.textContent, 60)}"`);
      const opts = [...s.options].slice(0, 12).map((o) => clean(o.textContent, 30));
      out.push(`options=[${opts.join(' | ')}${s.options.length > 12 ? ' | …' : ''}]`);
    }
    if (i.checked || el.getAttribute('aria-checked') === 'true') out.push('checked');
    if (i.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    if (el.getAttribute('aria-expanded')) out.push(`expanded=${el.getAttribute('aria-expanded')}`);
    if (el.getAttribute('aria-selected') === 'true') out.push('selected');
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      if (href && !href.startsWith('javascript:')) out.push(`→ ${clean(href, 80)}`);
    }
    return out.length ? ` ${out.join(' ')}` : '';
  };
  let seq = 0;
  const walk = (root: Node, depth: number) => {
    for (const child of root.childNodes) {
      if (cut) return;
      if (child.nodeType === Node.TEXT_NODE) {
        const t = clean(child.textContent, 300);
        if (t) push(depth, t);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'svg', 'head', 'meta', 'link'].includes(tag)) continue;
      if (hidden(el)) continue;
      const role = roleOf(el);
      if (role) {
        const ref = ++seq;
        refs.set(ref, el);
        push(depth, `[${ref}] ${role} "${nameOf(el)}"${stateOf(el)}`);
        // botões e links já mostram o texto; listas e grupos com role continuam abrindo
        if (
          [
            'link',
            'button',
            'textbox',
            'combobox',
            'checkbox',
            'radio',
            'option',
            'menuitem',
            'tab',
            'switch',
          ].includes(role)
        )
          continue;
      } else if (/^h[1-6]$/.test(tag)) {
        push(depth, `${'#'.repeat(Number(tag[1]))} ${clean((el as HTMLElement).innerText, 200)}`);
        continue;
      } else if (tag === 'img') {
        const alt = clean(el.getAttribute('alt'));
        if (alt) push(depth, `img "${alt}"`);
        continue;
      } else if (tag === 'iframe') {
        push(depth, `iframe ${clean(el.getAttribute('src'), 80)}`);
        continue;
      }
      const landmark = [
        'nav',
        'main',
        'header',
        'footer',
        'form',
        'dialog',
        'aside',
        'table',
        'ul',
        'ol',
      ].includes(tag);
      if (landmark) push(depth, `${tag}:`);
      walk(el, landmark ? depth + 1 : depth);
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
  };
  walk(document.body ?? document.documentElement, 0);
  const sy = Math.round(scrollY);
  const sh = document.documentElement.scrollHeight;
  const head = [
    `Título: ${document.title}`,
    `URL: ${location.href}`,
    `Rolagem: ${sy}px de ${Math.max(0, sh - innerHeight)}px (janela ${innerWidth}x${innerHeight})`,
    '',
  ];
  if (cut) lines.push('… (cortado: role a página ou use browser_evaluate para o resto)');
  return [...head, ...lines].join('\n');
}

/** Centro do elemento [ref] na tela, depois de rolar até ele. */
function refCenter(ref: number): { x: number; y: number } | string {
  const el = (window as Window & { __acRefs?: Map<number, Element> }).__acRefs?.get(ref);
  if (!el) return `Referência [${ref}] não existe. Tire um browser_snapshot novo.`;
  if (!el.isConnected) return `O elemento [${ref}] saiu da página. Tire um browser_snapshot novo.`;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Foca o campo [ref] e seleciona o conteúdo (para a digitação substituir). */
function focusRef(ref: number, clear: boolean): string | null {
  const el = (window as Window & { __acRefs?: Map<number, Element> }).__acRefs?.get(ref) as
    HTMLElement | undefined;
  if (!el?.isConnected) return `Referência [${ref}] não existe mais. Tire um browser_snapshot novo.`;
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  el.focus();
  if (clear) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
    else if (el.isContentEditable) document.execCommand('selectAll');
  }
  return null;
}

/**
 * O tsx (esbuild com keepNames) embrulha funções internas em `__name(...)`, que não existe na
 * página: o script define um `__name` que não faz nada antes de chamar a função.
 */
const call = (fn: (...a: never[]) => unknown, ...args: unknown[]) =>
  `(() => { var __name = (f) => f; return (${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')}); })()`;

export const SNAPSHOT_JS = (maxChars: number) => call(snapshotPage, maxChars);
export const REF_CENTER_JS = (ref: number) => call(refCenter, ref);
export const FOCUS_REF_JS = (ref: number, clear: boolean) => call(focusRef, ref, clear);
