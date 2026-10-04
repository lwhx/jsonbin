import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

type JsonObject = Record<string, unknown>;
type FieldType = "string" | "number" | "boolean" | "null" | "object" | "array";

type FieldRow = {
  id: number;
  key: string;
  type: FieldType;
  raw: string;
  structured: unknown;
};

type Props = {
  value: JsonObject;
  sourceText: string;
  disabled: boolean;
  onChange: (text: string) => void;
  onValidityChange: (valid: boolean) => void;
};

function typeOf(value: unknown): FieldType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function rowFromEntry(id: number, key: string, value: unknown): FieldRow {
  const type = typeOf(value);
  return {
    id,
    key,
    type,
    raw: type === "string" || type === "number" || type === "boolean" ? String(value) : "",
    structured: type === "object" || type === "array" ? value : null,
  };
}

function valueOf(row: FieldRow): { valid: true; value: unknown } | { valid: false; error: string } {
  if (row.type === "string") return { valid: true, value: row.raw };
  if (row.type === "number") {
    if (!row.raw.trim()) return { valid: false, error: "“" + (row.key || "未命名字段") + "”需要填写数字。" };
    const value = Number(row.raw);
    if (!Number.isFinite(value)) return { valid: false, error: "“" + (row.key || "未命名字段") + "”不是有效数字。" };
    return { valid: true, value };
  }
  if (row.type === "boolean") return { valid: true, value: row.raw === "true" };
  if (row.type === "null") return { valid: true, value: null };
  if (row.type === "array") return { valid: true, value: Array.isArray(row.structured) ? row.structured : [] };
  return {
    valid: true,
    value: row.structured && typeof row.structured === "object" && !Array.isArray(row.structured) ? row.structured : {},
  };
}

function objectFromRows(rows: FieldRow[]): { valid: true; value: JsonObject } | { valid: false; error: string } {
  const result: JsonObject = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) return { valid: false, error: "键名不能为空。" };
    if (seen.has(key)) return { valid: false, error: "键名“" + key + "”重复，请修改后再保存。" };
    seen.add(key);
    const parsed = valueOf(row);
    if (!parsed.valid) return parsed;
    result[key] = parsed.value;
  }
  return { valid: true, value: result };
}

function labelForStructured(row: FieldRow) {
  if (row.type === "array") {
    const count = Array.isArray(row.structured) ? row.structured.length : 0;
    return "数组 · " + count + " 项";
  }
  const count = row.structured && typeof row.structured === "object" && !Array.isArray(row.structured)
    ? Object.keys(row.structured as JsonObject).length
    : 0;
  return "对象 · " + count + " 个字段";
}

export function JsonFormEditor({ value, sourceText, disabled, onChange, onValidityChange }: Props) {
  const nextId = useRef(1);
  const lastEmitted = useRef<string | null>(null);
  function rowsFor(input: JsonObject) {
    return Object.entries(input).map(([key, item]) => rowFromEntry(nextId.current++, key, item));
  }
  const [rows, setRows] = useState<FieldRow[]>(() => rowsFor(value));
  const [formError, setFormError] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchError, setBatchError] = useState("");

  useEffect(() => {
    if (sourceText === lastEmitted.current) {
      lastEmitted.current = null;
      return;
    }
    setRows(rowsFor(value));
    setFormError("");
    setBatchError("");
    onValidityChange(true);
  }, [sourceText, value, onValidityChange]);

  function commit(nextRows: FieldRow[]) {
    setRows(nextRows);
    const parsed = objectFromRows(nextRows);
    if (!parsed.valid) {
      setFormError(parsed.error);
      onValidityChange(false);
      return false;
    }
    setFormError("");
    onValidityChange(true);
    const text = JSON.stringify(parsed.value, null, 2);
    lastEmitted.current = text;
    onChange(text);
    return true;
  }

  function updateRow(id: number, patch: Partial<FieldRow>) {
    commit(rows.map(row => row.id === id ? { ...row, ...patch } : row));
  }

  function changeType(row: FieldRow, type: FieldType) {
    if (type === row.type) return;
    let raw = "";
    let structured: unknown = null;
    if (type === "string") {
      const current = valueOf(row);
      raw = current.valid
        ? typeof current.value === "string"
          ? current.value
          : current.value === null
            ? ""
            : typeof current.value === "object"
              ? JSON.stringify(current.value)
              : String(current.value)
        : row.raw;
    } else if (type === "number") {
      raw = row.raw.trim() && Number.isFinite(Number(row.raw)) ? row.raw : "0";
    } else if (type === "boolean") {
      raw = row.raw === "false" ? "false" : "true";
    } else if (type === "object") {
      structured = row.type === "object" ? row.structured : {};
    } else if (type === "array") {
      structured = row.type === "array" ? row.structured : [];
    }
    updateRow(row.id, { type, raw, structured });
  }

  function addRow() {
    commit([...rows, { id: nextId.current++, key: "", type: "string", raw: "", structured: null }]);
  }

  function applyBatch() {
    setBatchError("");
    const current = objectFromRows(rows);
    if (!current.valid) {
      setBatchError("请先修正当前表单中的字段后再批量添加。");
      return;
    }
    const lines = batchText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) {
      setBatchError("请先粘贴要添加的键值数据。");
      return;
    }
    const used = new Set(rows.map(row => row.key.trim()));
    const additions: FieldRow[] = [];
    for (const line of lines) {
      const tab = line.indexOf("\t");
      const equals = line.indexOf("=");
      const separator = tab >= 0 ? tab : equals;
      if (separator < 0) {
        setBatchError("无法识别“" + line + "”，请使用 key=value 或从表格复制两列。");
        return;
      }
      const key = line.slice(0, separator).trim();
      const raw = line.slice(separator + 1).trim();
      if (!key) {
        setBatchError("批量数据中存在空键名。");
        return;
      }
      if (used.has(key)) {
        setBatchError("键名“" + key + "”重复，未添加任何批量数据。");
        return;
      }
      used.add(key);
      additions.push({ id: nextId.current++, key, type: "string", raw, structured: null });
    }
    if (commit([...rows, ...additions])) {
      setBatchText("");
      setBatchOpen(false);
    }
  }

  return <div className="json-form-editor">
    <p className="json-form-description">直接填写键名、类型和值，系统会自动生成合法 JSON。对象和数组会保留现有内容；复杂嵌套建议使用编辑器或树形视图。</p>
    <div className="json-form-header" aria-hidden="true"><span>键 Key</span><span>类型</span><span>值 Value</span><span>操作</span></div>
    <div className="json-form-rows">
      {rows.map((row, index) => <div className="json-form-row" key={row.id}>
        <input aria-label="字段键" value={row.key} disabled={disabled}
          placeholder={"字段 " + (index + 1)} onChange={event => updateRow(row.id, { key: event.target.value })} />
        <select aria-label="字段类型" value={row.type} disabled={disabled} onChange={event => changeType(row, event.target.value as FieldType)}>
          <option value="string">文本</option>
          <option value="number">数字</option>
          <option value="boolean">布尔值</option>
          <option value="null">空值</option>
          <option value="object">对象</option>
          <option value="array">数组</option>
        </select>
        <div className="json-form-value">
          {row.type === "string" && <input aria-label="字段值" value={row.raw} disabled={disabled} onChange={event => updateRow(row.id, { raw: event.target.value })} />}
          {row.type === "number" && <input aria-label="字段值" inputMode="decimal" value={row.raw} disabled={disabled} onChange={event => updateRow(row.id, { raw: event.target.value })} />}
          {row.type === "boolean" && <select aria-label="字段值" value={row.raw} disabled={disabled} onChange={event => updateRow(row.id, { raw: event.target.value })}>
            <option value="true">true</option><option value="false">false</option>
          </select>}
          {row.type === "null" && <code className="json-form-static">null</code>}
          {(row.type === "object" || row.type === "array") && <span className="json-form-structured"><code>{row.type === "object" ? "{…}" : "[…]"}</code>{labelForStructured(row)}</span>}
        </div>
        <button type="button" className="secondary-button json-form-delete" aria-label={"删除字段 " + (row.key || (index + 1))}
          title="删除字段" disabled={disabled} onClick={() => commit(rows.filter(item => item.id !== row.id))}><Trash2 size={14} /><span>删除</span></button>
      </div>)}
    </div>

    {formError && <p className="detail-error json-form-error" role="alert">{formError}</p>}

    <div className="json-form-actions">
      <button type="button" className="secondary-button" disabled={disabled} onClick={addRow}><Plus size={15} />添加字段</button>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => { setBatchOpen(open => !open); setBatchError(""); }}>批量添加</button>
    </div>

    {batchOpen && <div className="json-form-batch">
      <label>批量数据<textarea aria-label="批量数据" value={batchText} disabled={disabled}
        placeholder={"hello=666world\n地方=df\n或直接从 Excel / 表格复制两列"}
        onChange={event => setBatchText(event.target.value)} /></label>
      <p>每行使用 <code>key=value</code>，或直接粘贴两列表格数据。批量添加默认按“文本”类型处理，之后可单独修改类型。</p>
      {batchError && <p className="detail-error" role="alert">{batchError}</p>}
      <div className="json-form-actions">
        <button type="button" className="primary-button" disabled={disabled} onClick={applyBatch}>添加到表单</button>
        <button type="button" className="secondary-button" onClick={() => { setBatchOpen(false); setBatchError(""); }} disabled={disabled}>取消</button>
      </div>
    </div>}
  </div>;
}
