import { useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import type { ExampleLanguage } from './types';
export function CodeExample({label,language,code}:{label:string;language:ExampleLanguage;code:string}) {
  const alive = useRef(false), serial = useRef(0), identity = useRef('');
  const key = language+'\0'+code;
  if(identity.current !== key) { identity.current=key; serial.current++; }
  const [feedback,setFeedback]=useState<{serial:number;kind:'pending'|'success'|'error'}|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;serial.current++;};},[]);
  const current=feedback?.serial===serial.current ? feedback.kind : null;
  async function copy() {
    const attempt=++serial.current;
    setFeedback({serial:attempt,kind:'pending'});
    try {
      await navigator.clipboard.writeText(code);
      if(alive.current && serial.current===attempt) setFeedback({serial:attempt,kind:'success'});
    } catch {
      if(alive.current && serial.current===attempt) setFeedback({serial:attempt,kind:'error'});
    }
  }
  return <div className="code-example">
    <div className="code-toolbar"><span>{label} · {language==='javascript'?'JavaScript fetch':language==='python'?'Python requests':'curl'}</span>
      <button type="button" className="secondary-button" onClick={copy} disabled={current==='pending'}><Copy size={14}/>{current==='pending'?'正在复制…':'复制代码'}</button></div>
    <pre><code>{code}</code></pre>
    {current==='success' && <p role="status">已复制。</p>}
    {current==='error' && <p role="alert">无法访问剪贴板，请手动选择并复制代码。</p>}
  </div>;
}
