import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { JsonValueField } from "./JsonValueField";
import {
  newNode,
  nodesFromObject,
  objectFromNodes,
  type FormIssue,
  type JsonNode,
  type JsonValue,
} from "./json-form-model";

type JsonObject = { [key: string]: JsonValue };

export type JsonFormState = {
  text: string | null;
  dirty: boolean;
  valid: boolean;
  issues: FormIssue[];
};

function canonicalText(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
}

type Props = {
  value: JsonObject;
  sourceText: string;
  baselineText: string;
  disabled: boolean;
  onChange: (text: string) => void;
  onValidityChange?: (valid: boolean) => void;
  onStateChange?: (state: JsonFormState) => void;
};

export function JsonFormEditor({ value, sourceText, baselineText, disabled, onChange, onValidityChange, onStateChange }: Props) {
  const [nodes, setNodes] = useState<JsonNode[]>(() => nodesFromObject(value));
  const baseline = useRef(canonicalText(baselineText));
  const lastEmitted = useRef<string | null>(null);
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchError, setBatchError] = useState("");
  const editorRef = useRef<HTMLDivElement>(null);
  const pendingFocusId = useRef<string | null>(null);
  const batchButtonRef = useRef<HTMLButtonElement>(null);
  const batchTextareaRef = useRef<HTMLTextAreaElement>(null);
  const restoreBatchFocus = useRef(false);

  useLayoutEffect(() => {
    const nodeId = pendingFocusId.current;
    if (!nodeId) return;
    pendingFocusId.current = null;
    editorRef.current?.querySelector<HTMLElement>(`[data-json-node-focus="${nodeId}"]`)?.focus();
  }, [nodes]);

  useLayoutEffect(() => {
    if (batchOpen) {
      batchTextareaRef.current?.focus();
    } else if (restoreBatchFocus.current) {
      restoreBatchFocus.current = false;
      batchButtonRef.current?.focus();
    }
  }, [batchOpen]);

  useEffect(() => {
    baseline.current = canonicalText(baselineText);
    if (sourceText === lastEmitted.current) {
      lastEmitted.current = null;
      onStateChange?.({ text: sourceText, dirty: canonicalText(sourceText) !== baseline.current, valid: true, issues: [] });
      return;
    }
    setNodes(nodesFromObject(value));
    setIssues([]);
    setBatchError("");
    onValidityChange?.(true);
    onStateChange?.({ text: sourceText, dirty: canonicalText(sourceText) !== baseline.current, valid: true, issues: [] });
  }, [sourceText, baselineText, value, onValidityChange, onStateChange]);

  function commit(nextNodes: JsonNode[]) {
    setNodes(nextNodes);
    const parsed = objectFromNodes(nextNodes);
    if (!parsed.valid) {
      setIssues(parsed.issues);
      onValidityChange?.(false);
      onStateChange?.({ text: null, dirty: true, valid: false, issues: parsed.issues });
      return false;
    }
    const text = JSON.stringify(parsed.value, null, 2);
    setIssues([]);
    onValidityChange?.(true);
    onStateChange?.({ text, dirty: text !== baseline.current, valid: true, issues: [] });
    lastEmitted.current = text;
    onChange(text);
    return true;
  }

  function updateRoot(index: number, node: JsonNode) {
    commit(nodes.map((item, itemIndex) => itemIndex === index ? node : item));
  }

  function moveRoot(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= nodes.length) return;
    const next = [...nodes];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  }

  function addRoot() {
    const node = newNode("string", "");
    pendingFocusId.current = node.id;
    commit([...nodes, node]);
  }

  function removeRoot(index: number) {
    const target = nodes[index + 1] ?? nodes[index - 1];
    pendingFocusId.current = target?.id ?? "root-add";
    commit(nodes.filter((_, itemIndex) => itemIndex !== index));
  }

  function closeBatch() {
    restoreBatchFocus.current = true;
    setBatchOpen(false);
    setBatchError("");
  }

  function applyBatch() {
    setBatchError("");
    if (!objectFromNodes(nodes).valid) {
      setBatchError("请先修正当前表单中的字段后再批量添加。");
      batchTextareaRef.current?.focus();
      return;
    }
    const lines = batchText.split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) {
      setBatchError("请先粘贴要添加的键值数据。");
      batchTextareaRef.current?.focus();
      return;
    }
    const used = new Set(nodes.map(node => node.key ?? ""));
    const additions: JsonNode[] = [];
    for (const line of lines) {
      const tab = line.indexOf("\t");
      const equals = line.indexOf("=");
      const separator = tab >= 0 ? tab : equals;
      if (separator < 0) {
        setBatchError(`无法识别“${line}”，请使用 key=value 或从表格复制两列。`);
        batchTextareaRef.current?.focus();
        return;
      }
      const key = line.slice(0, separator);
      const raw = line.slice(separator + 1);
      if (used.has(key)) {
        setBatchError(`键名“${key}”重复，未添加任何批量数据。`);
        batchTextareaRef.current?.focus();
        return;
      }
      used.add(key);
      additions.push({ ...newNode("string", key), raw });
    }
    if (commit([...nodes, ...additions])) {
      setBatchText("");
      closeBatch();
    }
  }

  return <div ref={editorRef} className={`json-form-editor${disabled ? " json-form-readonly" : ""}`}>
    <p className="json-form-description">直接填写键名、类型和值，系统会自动生成合法 JSON。对象和数组可在当前行展开编辑。</p>
    {disabled && <p className="json-form-readonly-note" role="status">只读：数据仓已锁定</p>}
    <div className="json-form-rows">
      {nodes.map((node, index) => {
        const pathLabel = node.key ? node.key : `字段 ${index + 1}`;
        return <JsonValueField key={node.id} node={node} depth={0} pathLabel={pathLabel} readOnly={disabled} issues={issues}
          keyLabel={`字段 ${index + 1} 键`} onChange={next => updateRoot(index, next)}
          onDelete={() => removeRoot(index)}
          onMove={direction => moveRoot(index, direction)} moveUpDisabled={index === 0} moveDownDisabled={index === nodes.length - 1} />;
      })}
    </div>
    <div className="json-form-actions">
      <button type="button" className="secondary-button" disabled={disabled} data-json-node-focus="root-add" onClick={addRoot}><Plus size={15} />添加字段</button>
      <button ref={batchButtonRef} type="button" className="secondary-button" disabled={disabled} aria-expanded={batchOpen} aria-controls="json-form-batch"
        onClick={() => { setBatchOpen(open => !open); setBatchError(""); }}>批量添加</button>
    </div>
    {batchOpen && <div className="json-form-batch" id="json-form-batch">
      <label>批量数据<textarea ref={batchTextareaRef} aria-label="批量数据" value={batchText} disabled={disabled}
        placeholder={"hello=666world\n地方=df\n或直接从 Excel / 表格复制两列"}
        onChange={event => setBatchText(event.target.value)} /></label>
      <p>每行使用 <code>key=value</code>，或直接粘贴两列表格数据。键和值会按原始文本保留。</p>
      {batchError && <p className="detail-error" role="alert">{batchError}</p>}
      <div className="json-form-actions">
        <button type="button" className="primary-button" disabled={disabled} onClick={applyBatch}>添加到表单</button>
        <button type="button" className="secondary-button" onClick={closeBatch} disabled={disabled}>取消</button>
      </div>
    </div>}
  </div>;
}
