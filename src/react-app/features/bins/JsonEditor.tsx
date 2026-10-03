import Editor from "@monaco-editor/react";
import "./monaco";

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
