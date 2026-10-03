import type { BinRecord } from "./types";

export type Draft = { record: BinRecord; text: string; savedText: string };
export function parseJson(text: string): { valid: true; value: unknown } | { valid: false; error: string } {
  try { return { valid: true, value: JSON.parse(text) }; }
  catch { return { valid: false, error: "JSON 语法不正确，请检查引号、逗号和括号。" }; }
}
export function createDraft(record: BinRecord): Draft {
  const text = JSON.stringify(record.value, null, 2);
  return { record, text, savedText: text };
}
export function isDirty(draft: Draft) { return draft.text !== draft.savedText; }
export function receiveRecord(draft: Draft, record: BinRecord): Draft {
  return isDirty(draft) ? draft : createDraft(record);
}
export function savedDraft(draft: Draft, record: BinRecord, submittedText: string): Draft {
  const saved = createDraft(record);
  return draft.text === submittedText ? saved : { ...saved, text: draft.text };
}
