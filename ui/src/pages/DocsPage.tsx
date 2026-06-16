import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { fetchDoc, fetchDocs } from "../api";
import { PageHeading } from "../components";

/** "README.md" → "README"; "commands-by-example.md" → "Commands by example". */
function label(name: string): string {
  const base = name.replace(/\.md$/i, "");
  if (base === base.toUpperCase()) return base; // all-caps stays (README, CLAUDE)
  const spaced = base.replace(/[-_]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function DocsPage() {
  const { data: docs = [] } = useQuery({ queryKey: ["docs"], queryFn: fetchDocs });
  const [selected, setSelected] = useState<string | null>(null);
  const active = selected ?? docs[0] ?? null;

  const { data: content, isLoading } = useQuery({
    queryKey: ["doc", active],
    queryFn: () => fetchDoc(active as string),
    enabled: active !== null,
  });

  return (
    <div>
      <PageHeading title="Docs" count={docs.length} />
      <div className="flex gap-6">
        <nav className="flex w-36 shrink-0 flex-col gap-1">
          {docs.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setSelected(name)}
              className={`rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                name === active
                  ? "bg-accent-soft font-medium text-accent"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              }`}
            >
              {label(name)}
            </button>
          ))}
        </nav>
        <article className="chat-md min-w-0 flex-1 dark:text-gray-300">
          {isLoading ? (
            <p className="text-gray-400">loading…</p>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {content ?? ""}
            </ReactMarkdown>
          )}
        </article>
      </div>
    </div>
  );
}
