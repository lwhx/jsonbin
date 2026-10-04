export type JsonTreeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
export type JsonTreeRow = {
  pointer: string; parent: string | null; depth: number; label: string;
  value: unknown; kind: JsonTreeKind; count: number; position: number; siblings: number;
};
export const TREE_PAGE_SIZE = 200;

function row(value: unknown, pointer: string, parent: string | null, depth: number, label: string, position: number, siblings: number): JsonTreeRow {
  const kind: JsonTreeKind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean';
  const count = kind === 'array' ? (value as unknown[]).length : kind === 'object' ? Object.keys(value as object).length : 0;
  return { value, pointer, parent, depth, label, kind, count, position, siblings };
}
function* children(parent: JsonTreeRow): Generator<JsonTreeRow> {
  const keys = parent.kind === 'array' ? null : Object.keys(parent.value as object);
  for (let index = 0; index < parent.count; index++) {
    const key = keys ? keys[index] : String(index);
    const segment = key.replace(/~/g, '~0').replace(/\//g, '~1');
    const label = keys ? JSON.stringify(key.length > 80 ? key.slice(0, 80) + '…' : key) : `[${index}]`;
    yield row((parent.value as Record<string, unknown>)[key], `${parent.pointer}/${segment}`, parent.pointer, parent.depth + 1, label, index + 1, parent.count);
  }
}

/** Flat, bounded traversal avoids recursively mounting a potentially deep JSON document. */
export function visibleJsonTree(value: unknown, expanded: ReadonlySet<string>, limit = TREE_PAGE_SIZE) {
  const rows: JsonTreeRow[] = [];
  const stack: Iterator<JsonTreeRow>[] = [[row(value, '', null, 0, '根节点', 1, 1)][Symbol.iterator]()];
  while (stack.length) {
    const next = stack[stack.length - 1].next();
    if (next.done) { stack.pop(); continue; }
    if (rows.length >= limit) return { rows, hasMore: true };
    const node = next.value;
    rows.push(node);
    if (node.count && expanded.has(node.pointer)) stack.push(children(node));
  }
  return { rows, hasMore: false };
}

export const TREE_KIND_LABEL: Record<JsonTreeKind, string> = { object: '对象', array: '数组', string: '文本', number: '数字', boolean: '布尔', null: '空值' };
export function treePreview(node: JsonTreeRow): string {
  if (node.kind === 'object') return node.count ? `{${node.count} 个属性}` : '{}';
  if (node.kind === 'array') return node.count ? `[${node.count} 项]` : '[]';
  if (node.kind === 'string') {
    const text = node.value as string;
    if (text.length > 160) {
      // Avoid cutting a surrogate pair in the preview; copying uses the original value.
      let end = 160;
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
      return `${JSON.stringify(text.slice(0, end))}…（${text.length} 字符）`;
    }
  }
  return JSON.stringify(node.value);
}
