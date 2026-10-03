import { dereference, format, schemaMapKeyword, Validator, type Schema, type OutputUnit } from "@cfworker/json-schema";
import metaSchema from "./draft7-meta-schema.json" with { type: "json" };

export type JsonSchema = Schema | boolean;
export type SchemaIssue = { path: string; keyword: string; message: string };
export class SchemaError extends Error {
  issues: SchemaIssue[];
  constructor(code: string, issues: SchemaIssue[] = []) { super(code); this.issues = issues; }
}
// Official Draft 7 meta-schema: https://json-schema.org/draft-07/schema
// Attribution/license: docs/licenses/JSON-Schema.txt.
// Draft 7 dependencies mixes property-name arrays and subschemas. Register its
// subschema map explicitly so references under names such as "type" resolve.
schemaMapKeyword.dependencies = true;
const definitionValidator = new Validator(metaSchema as Schema, "7", false);
const keywords = new Set(Object.keys(metaSchema.properties));
const single = ["additionalItems", "contains", "additionalProperties", "propertyNames", "not", "if", "then", "else"];
const maps = ["definitions", "properties", "patternProperties", "dependencies"];
const arrays = ["allOf", "anyOf", "oneOf"];
const sameInstance = new Set(["allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependencies"]);
const escapePointer = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
function issuesOf(errors: OutputUnit[]): SchemaIssue[] {
  // Do not echo instance values from the interpreter's numerical error messages.
  const labels: Record<string, string> = { type: "字段类型不符", required: "缺少必填字段", minimum: "数值小于最小值", maximum: "数值大于最大值",
    exclusiveMinimum: "数值必须大于下限", exclusiveMaximum: "数值必须小于上限", multipleOf: "数值不符合倍数约束",
    minLength: "文本长度不足", maxLength: "文本过长", pattern: "文本不符合指定模式", format: "文本格式不符",
    additionalProperties: "包含模型不允许的字段", enum: "值不在允许的选项中", const: "值与规定常量不符" };
  return errors.slice(0, 20).map(error => {
    let path = error.instanceLocation || "#";
    const missing = error.keyword === "required" && /^Instance does not have required property "(.*)"\.$/.exec(error.error);
    if (missing) path += `/${escapePointer(missing[1])}`;
    return { path, keyword: error.keyword, message: labels[error.keyword] ?? `不满足 ${error.keyword} 约束` };
  });
}
function invalid(path: string, keyword: string, message: string): never {
  throw new SchemaError("invalid_schema", [{ path, keyword, message }]);
}

export function assertSchemaDefinition(schema: JsonSchema) {
  if (new TextEncoder().encode(JSON.stringify(schema)).length > 65536) invalid("#", "size", "模型定义不能超过 64 KiB。");
  // Check depth before invoking the recursive meta-schema validator.
  function depthCheck(value: unknown, depth = 0) {
    if (depth > 64) invalid("#", "depth", "模型定义嵌套不能超过 64 层。");
    if (value && typeof value === "object") for (const child of Object.values(value)) depthCheck(child, depth + 1);
  }
  depthCheck(schema);
  const result = definitionValidator.validate(schema);
  if (!result.valid) throw new SchemaError("invalid_schema", issuesOf(result.errors));
  const edges = new Map<string, string[]>();
  const references: [string, string][] = [];
  function visit(node: JsonSchema, path: string) {
    if (typeof node === "boolean") { edges.set(path, []); return; }
    edges.set(path, []);
    for (const key of Object.keys(node)) {
      if (!keywords.has(key) && !key.startsWith("x-")) invalid(`${path}/${escapePointer(key)}`, key, "仅支持 Draft 7 关键字；扩展注释请使用 x- 前缀。");
    }
    if (node.$schema && !/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(node.$schema)) invalid(path, "$schema", "当前仅支持 JSON Schema Draft 7。");
    if (path !== "#" && node.$id) invalid(path, "$id", "嵌套模型不支持独立 $id，请使用根定义和本地 JSON Pointer 引用。");
    if (node.$ref !== undefined) {
      let ref: string;
      try { ref = decodeURIComponent(node.$ref); } catch { invalid(path, "$ref", "引用编码无效。"); }
      if (!/^#(?:\/.*)?$/.test(ref!) || /~(?![01])/.test(ref!)) invalid(path, "$ref", "仅支持当前模型中的 JSON Pointer 引用。");
      references.push([path, ref!]);
    }
    function patternCheck(pattern: string) { try { new RegExp(pattern, "u"); } catch { invalid(path, "pattern", "正则表达式无效。"); } }
    if (node.format !== undefined && !Object.hasOwn(format, node.format)) invalid(path, "format", "不支持此格式，请使用标准格式或显式 pattern。");
    if (node.pattern !== undefined) patternCheck(node.pattern);
    for (const pattern of Object.keys(node.patternProperties ?? {})) patternCheck(pattern);
    function child(value: unknown, keyword: string, suffix = "") {
      if (typeof value !== "boolean" && (!value || typeof value !== "object" || Array.isArray(value))) return;
      const childPath = `${path}/${keyword}${suffix}`;
      visit(value as JsonSchema, childPath);
      if (sameInstance.has(keyword)) edges.get(path)!.push(childPath);
    }
    for (const key of single) if (node[key] !== undefined) child(node[key], key);
    if (Array.isArray(node.items)) node.items.forEach((item, i) => child(item, "items", `/${i}`));
    else if (node.items !== undefined) child(node.items, "items");
    for (const key of arrays) (node[key] as JsonSchema[] | undefined)?.forEach((item, i) => child(item, key, `/${i}`));
    for (const key of maps) for (const [name, value] of Object.entries(node[key] ?? {})) child(value, key, `/${escapePointer(name)}`);
  }
  visit(schema, "#");
  for (const [path, ref] of references) {
    if (!edges.has(ref)) invalid(path, "$ref", "引用目标不存在或不是模型定义。");
    edges.get(path)!.push(ref);
  }
  // Allow recursive properties/items, but reject cycles that evaluate the same instance forever.
  const visiting = new Set<string>(), visited = new Set<string>();
  function checkCycle(path: string) {
    if (visiting.has(path)) invalid(path, "$ref", "引用形成了不消费数据层级的循环。");
    if (visited.has(path)) return;
    visiting.add(path); for (const target of edges.get(path) ?? []) checkCycle(target);
    visiting.delete(path); visited.add(path);
  }
  for (const path of edges.keys()) checkCycle(path);
  try {
    const prepared = structuredClone(schema);
    const lookup = dereference(prepared);
    for (const [path] of references) {
      let node = prepared as Schema;
      for (const key of path.slice(2).split("/")) {
        if (path === "#") break;
        node = node[key.replaceAll("~1", "/").replaceAll("~0", "~")];
      }
      if (!node.__absolute_ref__ || lookup[node.__absolute_ref__] === undefined) invalid(path, "$ref", "引用无法解析。");
    }
  } catch (error) {
    if (error instanceof SchemaError) throw error;
    invalid("#", "$id", "模型标识或引用无效。");
  }
}
export function validateSchemaValue(schema: JsonSchema, value: unknown) {
  const result = new Validator(structuredClone(schema), "7", false).validate(value);
  return { valid: result.valid, issues: issuesOf(result.errors) };
}
export function assertSchemaValue(schema: JsonSchema, value: unknown) {
  const result = validateSchemaValue(schema, value);
  if (!result.valid) throw new SchemaError("schema_validation_failed", result.issues);
}
