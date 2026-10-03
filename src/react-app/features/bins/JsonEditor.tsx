import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/language/json/monaco.contribution.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    return label === "json" ? new JsonWorker() : new EditorWorker();
  },
};
loader.config({ monaco });

export default function JsonEditor({ value, onChange, readOnly, dark }: {
  value: string; onChange: (value: string) => void; readOnly: boolean; dark: boolean;
}) {
  return <Editor height="420px" language="json" value={value}
    theme={dark ? "vs-dark" : "light"} onChange={text => onChange(text ?? "")}
    loading={<p>正在加载 JSON 编辑器…</p>}
    options={{ readOnly, automaticLayout: true, minimap: { enabled: false }, fontSize: 14,
      tabSize: 2, wordWrap: "on", scrollBeyondLastLine: false, ariaLabel: "JSON 编辑器",
      accessibilitySupport: "on", padding: { top: 12 }, fixedOverflowWidgets: true }} />;
}
