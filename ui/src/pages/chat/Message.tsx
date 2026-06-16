import { type ComponentPropsWithoutRef, useRef, useState } from "react";
import rehypeHighlight from "rehype-highlight";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../../api";
import { useDebug } from "../../debug";
import { IconCheck, IconCopy } from "../../icons";
import { Tooltip } from "../../components";
import { TracePanel } from "./Trace";

/** A copy-to-clipboard button that flips to a check for a beat after success. */
function CopyButton({
  getText,
  className = "",
  label = "Copy",
}: {
  getText: () => string;
  className?: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);
  const onClick = () => {
    const text = getText();
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    });
  };
  return (
    <Tooltip content={done ? "Copied" : label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={done ? "Copied" : label}
        className={`shrink-0 cursor-pointer rounded-md p-1 transition-colors ${className}`}
      >
        {done ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
    </Tooltip>
  );
}

/** Code fence with a hover copy button; reads the raw text off the rendered <pre>. */
function CodeBlock(props: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block group/code">
      <CopyButton
        getText={() => ref.current?.textContent ?? ""}
        label="Copy code"
        className="absolute right-2 top-2 bg-gray-200/80 text-gray-500 opacity-0 hover:text-accent group-hover/code:opacity-100 dark:bg-gray-700/80 dark:text-gray-400"
      />
      <pre ref={ref} {...props} />
    </div>
  );
}

/** A single chat bubble. User text is plain; assistant text renders as markdown. */
export function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const debug = useDebug();
  const bubbleCopy = (
    <CopyButton
      getText={() => message.content}
      label="Copy message"
      className="text-gray-400 opacity-0 hover:text-accent group-hover/msg:opacity-100"
    />
  );
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      {/* Column shrink-wraps the bubble so the copy button sits at its bottom-right,
          the same offset from the bubble edge for both roles. min-w-0 lets max-w-[85%]
          win over a flex item's default min-content width, so long code/tokens scroll
          inside the bubble instead of stretching it past 85% (horizontal scrollbar). */}
      <div className="group/msg flex max-w-[85%] min-w-0 flex-col items-end gap-0.5">
        <div
          className={`min-w-0 max-w-full rounded-2xl px-4 py-2.5 ${
            isUser
              ? "bg-accent text-white"
              : "self-start border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
          }`}
        >
          {message.thinking && (
            <details className="mb-2">
              <summary className="cursor-pointer text-xs opacity-70">thinking</summary>
              <pre className="mt-1 max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap opacity-80">
                {message.thinking}
              </pre>
            </details>
          )}

          {message.toolEvents?.map((t) => (
            <details key={t.toolCallId} className="mb-2">
              <summary className="cursor-pointer text-xs opacity-70">
                🔧 {t.tool}
                {t.isError ? " (error)" : ""}
              </summary>
              {t.input !== undefined && (
                <pre className="mt-1 overflow-auto font-mono text-xs opacity-80">
                  {typeof t.input === "string" ? t.input : JSON.stringify(t.input, null, 2)}
                </pre>
              )}
              {t.result !== undefined && (
                <pre className="mt-1 max-h-48 overflow-auto font-mono text-xs opacity-70">
                  {typeof t.result === "string" ? t.result : JSON.stringify(t.result, null, 2)}
                </pre>
              )}
            </details>
          ))}

          {isUser ? (
            <p className="user-msg text-sm whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="chat-md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{ pre: CodeBlock }}
              >
                {message.content || "…"}
              </ReactMarkdown>
            </div>
          )}

          {message.sources && message.sources.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs opacity-60">
                {message.sources.length} source{message.sources.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 space-y-0.5">
                {message.sources.map((s) => (
                  <li key={`${s.relativePath}:${s.startLine}`} className="font-mono text-xs opacity-70">
                    {s.relativePath}:{s.startLine}-{s.endLine}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {debug && message.trace && <TracePanel trace={message.trace} />}
        </div>
        {bubbleCopy}
      </div>
    </div>
  );
}
