import type { ReactNode } from "react";

function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return <em key={i}>{p.slice(1, -1)}</em>;
    return p;
  });
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];

  const flushList = (key: number) => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`ul-${key}`}>
        {list.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>
    );
    list = [];
  };

  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (/^###\s+/.test(trimmed)) {
      flushList(i);
      blocks.push(<h3 key={i}>{inline(trimmed.slice(4))}</h3>);
    } else if (/^##\s+/.test(trimmed)) {
      flushList(i);
      blocks.push(<h2 key={i}>{inline(trimmed.slice(3))}</h2>);
    } else if (/^#\s+/.test(trimmed)) {
      flushList(i);
      blocks.push(<h1 key={i}>{inline(trimmed.slice(2))}</h1>);
    } else if (/^[-*]\s+/.test(trimmed)) {
      list.push(trimmed.slice(2));
    } else if (trimmed === "") {
      flushList(i);
    } else {
      flushList(i);
      blocks.push(<p key={i}>{inline(trimmed)}</p>);
    }
  });
  flushList(text.length);

  return <div className="markdown-preview">{blocks}</div>;
}
