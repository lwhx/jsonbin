import { loader } from "@monaco-editor/react";
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
