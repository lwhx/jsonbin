import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import "./monaco";

export default function JsonDiff({ original, modified, dark }: {
  original: string; modified: string; dark: boolean;
}) {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 760px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 760px)");
    const change = () => setWide(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return <DiffEditor height="420px" language="json" original={original} modified={modified}
    theme={dark ? "vs-dark" : "light"} loading={<p role="status">正在加载版本对比…</p>}
    options={{ readOnly: true, originalEditable: false, automaticLayout: true,
      renderSideBySide: wide, useInlineViewWhenSpaceIsLimited: true,
      minimap: { enabled: false }, fontSize: 14, wordWrap: "on", scrollBeyondLastLine: false,
      ariaLabel: "JSON 版本对比", accessibilitySupport: "on" }} />;
}
