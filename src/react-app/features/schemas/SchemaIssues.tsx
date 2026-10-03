import type { SchemaIssue } from "./api";
export function SchemaIssues({ issues }: { issues: SchemaIssue[] }) {
  if (!issues.length) return null;
  return <ul className="schema-issues">{issues.map((issue, i) => <li key={i}><code>{issue.path}</code>：{issue.message}</li>)}</ul>;
}
