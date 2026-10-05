export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonNodeType = "string" | "number" | "boolean" | "null" | "object" | "array";

export type JsonNode = {
  id: string;
  key?: string;
  type: JsonNodeType;
  raw: string;
  children: JsonNode[];
};

export type FormIssue = {
  nodeId: string;
  field: "key" | "value";
  message: string;
};

export type FormResult =
  | { valid: true; value: JsonValue }
  | { valid: false; issues: FormIssue[] };

let nextNodeId = 1;

function id() {
  return `json-node-${nextNodeId++}`;
}

function typeOf(value: JsonValue): JsonNodeType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value as "string" | "number" | "boolean";
}

export function nodeFromValue(value: JsonValue, key?: string): JsonNode {
  const type = typeOf(value);
  const children = type === "object"
    ? nodesFromObject(value as { [key: string]: JsonValue })
    : type === "array"
      ? (value as JsonValue[]).map(item => nodeFromValue(item))
      : [];
  return {
    id: id(),
    ...(key === undefined ? {} : { key }),
    type,
    raw: type === "string" || type === "number" || type === "boolean" ? String(value) : "",
    children,
  };
}

export function nodesFromObject(value: { [key: string]: JsonValue }): JsonNode[] {
  return Object.entries(value).map(([key, item]) => nodeFromValue(item, key));
}

export function newNode(type: JsonNodeType = "string", key?: string): JsonNode {
  return {
    id: id(),
    ...(key === undefined ? {} : { key }),
    type,
    raw: type === "number" ? "0" : type === "boolean" ? "true" : "",
    children: [],
  };
}

export function changeNodeType(node: JsonNode, type: JsonNodeType): JsonNode {
  if (node.type === type) return node;
  return { ...newNode(type, node.key), id: node.id };
}

const jsonNumberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function decimalParts(raw: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) return null;
  let digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
  if (!digits) return { negative: false, digits: "0", exponent: 0 };
  let exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  while (digits.endsWith("0")) { digits = digits.slice(0, -1); exponent += 1; }
  return { negative: match[1] === "-", digits, exponent };
}

export function parseNumber(raw: string): { valid: true; value: number } | { valid: false; message: string } {
  if (!jsonNumberPattern.test(raw)) return { valid: false, message: "请输入有效的 JSON 数字。" };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { valid: false, message: "数字必须是有限值。" };
  if (Object.is(value, -0)) return { valid: false, message: "负零无法无损保存，请改用文本。" };
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return { valid: false, message: "整数超出安全范围，请改用文本。" };
  }
  const source = decimalParts(raw);
  const serialized = decimalParts(JSON.stringify(value));
  if (!source || !serialized || source.negative !== serialized.negative || source.digits !== serialized.digits || source.exponent !== serialized.exponent) {
    return { valid: false, message: "数字无法无损保存，请改用文本。" };
  }
  return { valid: true, value };
}

export function valueFromNode(node: JsonNode): FormResult {
  if (node.type === "string") return { valid: true, value: node.raw };
  if (node.type === "number") {
    const parsed = parseNumber(node.raw);
    return parsed.valid
      ? parsed
      : { valid: false, issues: [{ nodeId: node.id, field: "value", message: parsed.message }] };
  }
  if (node.type === "boolean") return { valid: true, value: node.raw === "true" };
  if (node.type === "null") return { valid: true, value: null };
  if (node.type === "array") {
    const values: JsonValue[] = [];
    const issues: FormIssue[] = [];
    for (const child of node.children) {
      const result = valueFromNode(child);
      if (result.valid) values.push(result.value);
      else issues.push(...result.issues);
    }
    return issues.length ? { valid: false, issues } : { valid: true, value: values };
  }
  return objectFromNodes(node.children);
}

export function objectFromNodes(nodes: JsonNode[]): FormResult {
  const entries: [string, JsonValue][] = [];
  const issues: FormIssue[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const key = node.key ?? "";
    if (seen.has(key)) {
      issues.push({ nodeId: node.id, field: "key", message: `键名“${key}”重复，请修改后再保存。` });
      continue;
    }
    seen.add(key);
    const result = valueFromNode(node);
    if (result.valid) entries.push([key, result.value]);
    else issues.push(...result.issues);
  }
  if (issues.length) return { valid: false, issues };
  return { valid: true, value: Object.fromEntries(entries) as { [key: string]: JsonValue } };
}

export function updateNode(nodes: JsonNode[], nodeId: string, update: (node: JsonNode) => JsonNode): JsonNode[] {
  return nodes.map(node => {
    if (node.id === nodeId) return update(node);
    const children = updateNode(node.children, nodeId, update);
    return children === node.children ? node : { ...node, children };
  });
}

function mapChildren(nodes: JsonNode[], nodeId: string, transform: (children: JsonNode[], index: number) => JsonNode[]): JsonNode[] {
  const ownIndex = nodes.findIndex(node => node.id === nodeId);
  if (ownIndex >= 0) return transform(nodes, ownIndex);
  let changed = false;
  const next = nodes.map(node => {
    const children = mapChildren(node.children, nodeId, transform);
    if (children === node.children) return node;
    changed = true;
    return { ...node, children };
  });
  return changed ? next : nodes;
}

export function removeNode(nodes: JsonNode[], nodeId: string): JsonNode[] {
  return mapChildren(nodes, nodeId, (siblings, index) => siblings.filter((_, itemIndex) => itemIndex !== index));
}

export function moveNode(nodes: JsonNode[], nodeId: string, direction: -1 | 1): JsonNode[] {
  return mapChildren(nodes, nodeId, (siblings, index) => {
    const target = index + direction;
    if (target < 0 || target >= siblings.length) return siblings;
    const next = [...siblings];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
}
