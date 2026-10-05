import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import {
  changeNodeType,
  newNode,
  type JsonNode,
  type JsonNodeType,
  type FormIssue,
} from "./json-form-model";

type Props = {
  node: JsonNode;
  depth: number;
  pathLabel: string;
  readOnly: boolean;
  onChange: (node: JsonNode) => void;
  onDelete?: () => void;
  onMove?: (direction: -1 | 1) => void;
  moveUpDisabled?: boolean;
  moveDownDisabled?: boolean;
  issues?: FormIssue[];
  keyLabel?: string;
};

const typeLabels: Record<JsonNodeType, string> = {
  string: "文本",
  number: "数字",
  boolean: "布尔值",
  null: "空值",
  object: "对象",
  array: "数组",
};

function childPath(parent: string, child: JsonNode, index: number, array: boolean) {
  if (array) return `${parent} 数组第 ${index + 1} 项`;
  return child.key ? `${parent} ${child.key}` : `${parent} 字段 ${index + 1}`;
}

export function JsonValueField({
  node,
  depth,
  pathLabel,
  readOnly,
  onChange,
  onDelete,
  onMove,
  moveUpDisabled,
  moveDownDisabled,
  issues = [],
  keyLabel,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const childrenId = `json-form-${node.id}-children`;
  const structured = node.type === "object" || node.type === "array";
  const isArray = node.type === "array";
  const count = node.children.length;
  const valueIssue = issues.find(issue => issue.nodeId === node.id && issue.field === "value");
  const keyIssue = issues.find(issue => issue.nodeId === node.id && issue.field === "key");
  const valueErrorId = `json-form-${node.id}-value-error`;
  const keyErrorId = `json-form-${node.id}-key-error`;
  const fieldRef = useRef<HTMLFieldSetElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocusId = useRef<string | null>(null);

  useLayoutEffect(() => {
    const nodeId = pendingFocusId.current;
    if (!nodeId) return;
    pendingFocusId.current = null;
    if (nodeId === "add") addButtonRef.current?.focus();
    else fieldRef.current?.querySelector<HTMLElement>(`[data-json-node-focus="${nodeId}"]`)?.focus();
  }, [node.children]);

  function updateChild(index: number, child: JsonNode) {
    const children = node.children.map((item, itemIndex) => itemIndex === index ? child : item);
    onChange({ ...node, children });
  }

  function addChild() {
    const child = newNode("string", isArray ? undefined : "");
    pendingFocusId.current = child.id;
    onChange({ ...node, children: [...node.children, child] });
  }

  function removeChild(index: number) {
    const target = node.children[index + 1] ?? node.children[index - 1];
    pendingFocusId.current = target?.id ?? "add";
    onChange({ ...node, children: node.children.filter((_, itemIndex) => itemIndex !== index) });
  }

  function moveChild(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= node.children.length) return;
    const children = [...node.children];
    [children[index], children[target]] = [children[target], children[index]];
    onChange({ ...node, children });
  }

  const controls = <>
    {onMove && <>
      <button type="button" className="secondary-button json-value-icon" disabled={readOnly || moveUpDisabled}
        aria-label={`上移 ${pathLabel}`} onClick={() => onMove(-1)}><ChevronUp size={14} /></button>
      <button type="button" className="secondary-button json-value-icon" disabled={readOnly || moveDownDisabled}
        aria-label={`下移 ${pathLabel}`} onClick={() => onMove(1)}><ChevronDown size={14} /></button>
    </>}
    {onDelete && <button type="button" className="secondary-button json-form-delete" disabled={readOnly}
      aria-label={`删除 ${pathLabel}`} onClick={onDelete}><Trash2 size={14} /><span>删除</span></button>}
  </>;

  const groupLabel = keyLabel ? `${keyLabel.slice(0, -2)} ${pathLabel}` : pathLabel;
  return <fieldset ref={fieldRef} className="json-value-row" aria-label={groupLabel}>
    <legend className="sr-only">{pathLabel}</legend>
    {keyLabel && <div className="json-value-key">
      <input aria-label={keyLabel} value={node.key ?? ""} readOnly={readOnly} data-json-node-focus={node.id}
        aria-invalid={keyIssue ? true : undefined} aria-errormessage={keyIssue ? keyErrorId : undefined} aria-describedby={keyIssue ? keyErrorId : undefined}
        onChange={event => onChange({ ...node, key: event.target.value })} />
      {keyIssue && <span id={keyErrorId} className="detail-error json-value-inline-error" role="alert">{keyIssue.message}</span>}
    </div>}
    <div className="json-value-type">
      {readOnly ? <span className="json-form-static" aria-label={`${pathLabel} 类型`}>{typeLabels[node.type]}</span> :
        <select aria-label={`${pathLabel} 类型`} value={node.type} data-json-node-focus={keyLabel ? undefined : node.id}
          onChange={event => onChange(changeNodeType(node, event.target.value as JsonNodeType))}>
          {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>}
    </div>
    <div className="json-form-value">
      {node.type === "string" && (node.raw.includes("\n") || node.raw.includes("\r")
        ? <textarea className="json-form-multiline" aria-label={`${pathLabel} 文本值`} value={node.raw} readOnly={readOnly}
            onChange={event => onChange({ ...node, raw: event.target.value })} />
        : <input aria-label={`${pathLabel} 文本值`} value={node.raw} readOnly={readOnly}
            onChange={event => onChange({ ...node, raw: event.target.value })} />)}
      {node.type === "number" && <>
        <input aria-label={`${pathLabel} 数字值`} inputMode="decimal" value={node.raw} readOnly={readOnly}
          aria-invalid={valueIssue ? true : undefined} aria-errormessage={valueIssue ? valueErrorId : undefined} aria-describedby={valueIssue ? valueErrorId : undefined}
          onChange={event => onChange({ ...node, raw: event.target.value })} />
        {valueIssue && <span id={valueErrorId} className="detail-error json-value-inline-error" role="alert">{valueIssue.message}</span>}
      </>}
      {node.type === "boolean" && (readOnly
        ? <span className="json-form-static" tabIndex={0} aria-label={`${pathLabel} 布尔值`}>{node.raw}</span>
        : <select aria-label={`${pathLabel} 布尔值`} value={node.raw} onChange={event => onChange({ ...node, raw: event.target.value })}>
            <option value="true">true</option><option value="false">false</option>
          </select>)}
      {node.type === "null" && <code className="json-form-static" tabIndex={0} aria-label={`${pathLabel} 空值`}>null</code>}
      {structured && <button type="button" className="json-form-structured" aria-expanded={expanded} aria-controls={childrenId}
        aria-label={`${expanded ? "折叠" : "展开"} ${pathLabel}`} onClick={() => setExpanded(value => !value)}>
        <code>{node.type === "object" ? "{…}" : "[…]"}</code>
        {node.type === "object" ? `对象 · ${count} 个字段` : `数组 · ${count} 项`}
      </button>}
    </div>
    <div className="json-value-operations">{controls}</div>
    {structured && expanded && <div id={childrenId} className="json-value-children">
      {depth >= 8 ? <p className="json-form-depth-note">请使用 JSON 编辑器处理更深层级。当前完整值仍会保留。</p> : <>
        {node.children.map((child, index) => {
          const label = childPath(pathLabel, child, index, isArray);
          return <JsonValueField key={child.id} node={child} depth={depth + 1} pathLabel={label} readOnly={readOnly}
            issues={issues} keyLabel={isArray ? undefined : `${pathLabel} 字段 ${index + 1} 键`}
            onChange={next => updateChild(index, next)} onDelete={() => removeChild(index)}
            onMove={direction => moveChild(index, direction)} moveUpDisabled={index === 0} moveDownDisabled={index === count - 1} />;
        })}
        <button ref={addButtonRef} type="button" className="secondary-button json-value-add" disabled={readOnly} onClick={addChild}
          aria-label={`添加 ${pathLabel} ${isArray ? "数组项" : "对象字段"}`}><Plus size={14} />{isArray ? "添加数组项" : "添加对象字段"}</button>
      </>}
    </div>}
  </fieldset>;
}
