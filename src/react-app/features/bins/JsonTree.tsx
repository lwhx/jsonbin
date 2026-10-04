import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ChevronRight, Copy, FoldVertical } from 'lucide-react';
import { TREE_KIND_LABEL, TREE_PAGE_SIZE, treePreview, visibleJsonTree, type JsonTreeRow } from './json-tree';

export function JsonTree({ value, dirty, onCopy }: { value: unknown; dirty: boolean; onCopy: (text: string) => Promise<void> }) {
  const [expanded, setExpanded] = useState(() => new Set(['']));
  const [limit, setLimit] = useState(TREE_PAGE_SIZE);
  const [active, setActive] = useState('');
  const [error, setError] = useState('');
  const element = useRef<HTMLDivElement>(null);
  const { rows, hasMore } = useMemo(() => visibleJsonTree(value, expanded, limit), [value, expanded, limit]);
  const selected = rows.find(node => node.pointer === active) ?? rows[0];
  function toggle(node: JsonTreeRow) {
    if (!node.count) return;
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(node.pointer)) next.delete(node.pointer); else next.add(node.pointer);
      return next;
    });
  }
  function focus(pointer: string) {
    // Compare data values directly: JSON keys are never interpolated into selectors.
    const item = [...element.current!.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(node => node.dataset.pointer === pointer);
    item?.focus();
  }
  function navigate(event: KeyboardEvent<HTMLDivElement>, node: JsonTreeRow, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case 'ArrowDown': focus(rows[Math.min(index + 1, rows.length - 1)].pointer); break;
      case 'ArrowUp': focus(rows[Math.max(index - 1, 0)].pointer); break;
      case 'Home': focus(rows[0].pointer); break;
      case 'End': focus(rows[rows.length - 1].pointer); break;
      case 'ArrowRight':
        if (node.count && !expanded.has(node.pointer)) toggle(node);
        else if (rows[index + 1]?.parent === node.pointer) focus(rows[index + 1].pointer);
        break;
      case 'ArrowLeft':
        if (node.count && expanded.has(node.pointer)) toggle(node);
        else if (node.parent !== null) focus(node.parent);
        break;
      case 'Enter': case ' ': toggle(node); break;
      default: return;
    }
    event.preventDefault();
  }
  async function copyNode() {
    setError('');
    try { await onCopy(JSON.stringify(selected.value, null, 2)); }
    catch { setError('无法复制节点，请在编辑器中选择内容后复制。'); }
  }
  return <div className="json-tree-panel">
    <div className="editor-toolbar"><span>JSON 树</span>
      <button type="button" className="secondary-button" onClick={() => { setExpanded(new Set()); setActive(''); setLimit(TREE_PAGE_SIZE); }}><FoldVertical size={15} />折叠全部</button>
      <button type="button" className="secondary-button" onClick={() => void copyNode()}><Copy size={15} />复制节点 JSON</button>
    </div>
    <p className="json-tree-description">{dirty ? '当前显示未保存的 JSON 草稿。' : '当前显示已保存的 JSON。'}树形视图仅用于查看，修改请切换到编辑器。</p>
    {error && <p className="detail-error" role="alert">{error}</p>}
    <div ref={element} className="json-tree" role="tree" aria-label="JSON 树形视图">
      {rows.map((node, index) => <div key={node.pointer} role="treeitem" data-pointer={node.pointer}
        aria-level={node.depth + 1} aria-posinset={node.position} aria-setsize={node.siblings}
        aria-selected={selected.pointer === node.pointer} aria-expanded={node.count ? expanded.has(node.pointer) : undefined}
        tabIndex={selected.pointer === node.pointer ? 0 : -1}
        style={{ '--tree-depth': Math.min(node.depth, 16) } as CSSProperties}
        onFocus={() => setActive(node.pointer)} onKeyDown={event => navigate(event, node, index)}
        onClick={() => { focus(node.pointer); toggle(node); }}>
        <span className={`json-tree-chevron ${node.count && expanded.has(node.pointer) ? 'is-open' : ''}`} aria-hidden="true">{node.count ? <ChevronRight size={14} /> : <span>·</span>}</span>
        <span className="json-tree-key">{node.label}</span>
        <span className="json-tree-kind">{TREE_KIND_LABEL[node.kind]}</span>
        <code className="json-tree-value" data-kind={node.kind}>{treePreview(node)}</code>
      </div>)}
    </div>
    <p className="json-tree-pointer">所选节点 JSON Pointer：<code>{selected.pointer || '根节点（空指针）'}</code></p>
    {hasMore && <div className="json-tree-more"><p>已显示 {rows.length} 个节点，继续显示可查看其余已展开内容。</p>
      <button type="button" className="secondary-button" onClick={() => setLimit(previous => previous + TREE_PAGE_SIZE)}>显示更多节点</button></div>}
  </div>;
}
