import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ask,
  type AskAttachment,
  type ChatMessage,
  deleteConversation,
  fetchApps,
  fetchConversation,
  fetchConversations,
  fetchIndexStatus,
  type IndexState,
  startIndex,
} from "../api";
import { useAutoScroll } from "../autoscroll";
import { AutoScrollToggle } from "../AutoScrollToggle";
import { chatStore, useChatStream } from "../chatStore";
import { Badge, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, FIELD_CLASS, PageHeading, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { DebugToggle } from "../DebugToggle";
import { useToast } from "../toast";
import { Message } from "./chat/Message";

const APP_KEY = "rubato.chat.app";
const FSROOT_KEY = "rubato.chat.fsRoot";
const INPUT_KEY = "rubato.chat.input";

function when(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

type Tone = "neutral" | "accent" | "success" | "error";
const STATE_TONE: Record<IndexState, Tone> = {
  indexed: "success",
  indexing: "accent",
  stale: "accent",
  missing: "neutral",
  error: "error",
};
const STATE_LABEL: Record<IndexState, string> = {
  indexed: "indexed",
  indexing: "indexing…",
  stale: "stale",
  missing: "not indexed",
  error: "index error",
};

export function ChatPage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  // null = no mode chosen yet; "" = general (no repo); else an app name.
  const [app, setApp] = useState<string | null>(() => localStorage.getItem(APP_KEY));
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [input, setInput] = useState(() => localStorage.getItem(INPUT_KEY) ?? "");
  const [attachments, setAttachments] = useState<AskAttachment[]>([]);
  // Screenshots (data URLs) for the vision→code pipeline; the server strips the header.
  const [images, setImages] = useState<string[]>([]);
  // General mode only: a folder the AI may explore with read-only filesystem tools.
  const [fsRoot, setFsRoot] = useState(() => localStorage.getItem(FSROOT_KEY) ?? "");
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const autoScroll = useAutoScroll();
  // While streaming, stay pinned to the bottom — until the user scrolls up,
  // which disengages auto-scroll for the rest of this answer so they can read
  // freely. Returning to the bottom re-pins. Reset to pinned on each new send.
  const pinnedRef = useRef(true);

  // Intake images handed off from the Art Canvas "Send to Vision Chat" action
  // (same localStorage pattern as APP_KEY/FSROOT_KEY); consume + clear once.
  useEffect(() => {
    const raw = localStorage.getItem("rubato.chat.pendingImages");
    if (!raw) return;
    localStorage.removeItem("rubato.chat.pendingImages");
    try {
      const pending: string[] = JSON.parse(raw);
      if (pending.length) setImages((prev) => [...prev, ...pending].slice(0, 6));
    } catch {
      /* ignore malformed handoff */
    }
  }, []);

  const { data: apps = [], isFetched: appsFetched } = useQuery({ queryKey: ["apps"], queryFn: fetchApps });
  // Default to the first app once the list loads, if no mode chosen yet.
  // If there are no apps, fall back to general mode ("") so the composer is never stuck disabled.
  useEffect(() => {
    if (app === null && appsFetched) setApp(apps.length ? apps[0].name : "");
  }, [app, apps, appsFetched]);

  const status = useQuery({
    queryKey: ["index", app],
    queryFn: () => fetchIndexStatus(app ?? ""),
    enabled: !!app,
    refetchInterval: (q) => (q.state.data?.state === "indexing" ? 1500 : false),
  });

  const conversation = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => fetchConversation(conversationId as string),
    enabled: !!conversationId,
  });

  // Loading a general conversation restores the folder it was bound to.
  const loadedConvo = conversation.data?.conversation;
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore only when the loaded conversation changes
  useEffect(() => {
    if (loadedConvo && loadedConvo.app === undefined) setFsRoot(loadedConvo.fsRoot ?? "");
  }, [loadedConvo?.id]);

  const conversations = useQuery({
    queryKey: ["conversations", app],
    // app === "" → general conversations; a real name → that app's; both enabled.
    queryFn: () => fetchConversations(app ?? undefined),
    enabled: app !== null,
  });
  const convos = conversations.data ?? [];

  const delConvo = useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onSuccess: (_r, id) => {
      if (id === conversationId) setConversationId(undefined);
      qc.invalidateQueries({ queryKey: ["conversations", app] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "delete failed", "error"),
  });

  const askM = useMutation({
    mutationFn: (vars: { question: string; attachments?: AskAttachment[]; images?: string[] }) =>
      ask(
        app ?? "",
        vars.question,
        conversationId,
        vars.attachments,
        app === "" ? fsRoot.trim() || undefined : undefined,
        vars.images,
      ),
    onSuccess: (res) => {
      setConversationId(res.conversationId);
      qc.invalidateQueries({ queryKey: ["conversation", res.conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["index", app] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "ask failed", "error"),
  });

  const reindex = useMutation({
    mutationFn: () => startIndex(app ?? ""),
    onSuccess: (s) => {
      qc.setQueryData(["index", app], s);
      notify(`Indexed ${s.files ?? 0} files (${s.chunks ?? 0} chunks)`, "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "index failed", "error"),
  });

  const messages = conversation.data?.messages ?? [];
  const persistedIds = useMemo(() => new Set(messages.map((m) => m.id)), [messages]);

  // The in-flight answer streaming over /ws (keyed by conversationId:messageId).
  const live = useChatStream(conversationId);
  const showLive = !!live && !persistedIds.has(live.messageId);
  // The live bubble: only once there's something to show (answer text, a live
  // tool trace, or an error) — the empty pre-answer phase is covered by the
  // status line below, so we never render a blank bubble.
  const liveMessage: ChatMessage | null =
    showLive && (live.text || live.toolEvents.length || live.status === "error")
      ? {
          id: live.messageId,
          conversationId: live.conversationId,
          role: "assistant",
          content: live.status === "error" ? `⚠ ${live.error ?? "error"}` : live.text,
          thinking: live.thinking || undefined,
          toolEvents: live.toolEvents.length ? live.toolEvents : undefined,
          createdAt: 0,
        }
      : null;

  // Transient "what's happening" line: while pending or streaming, before any
  // answer token arrives. Keeps the user oriented during retrieval/tool rounds.
  const showStatus = (askM.isPending || (showLive && live.status === "streaming")) && !live?.text;
  const statusText = live?.note ?? "Thinking…";

  // When the answer finishes, pull the persisted message + refresh lists.
  useEffect(() => {
    if (live && (live.status === "done" || live.status === "error")) {
      qc.invalidateQueries({ queryKey: ["conversation", live.conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["index", app] });
    }
  }, [live?.status, live?.conversationId, app, qc]);

  // Once the persisted message arrives, drop the now-redundant live buffer.
  useEffect(() => {
    if (live && persistedIds.has(live.messageId)) chatStore.clear(live.conversationId, live.messageId);
  }, [live, persistedIds]);

  // Keep the thread pinned to the latest message / streaming output — but only
  // when the setting is on and the user hasn't scrolled away (see onThreadScroll).
  useEffect(() => {
    if (!autoScroll || !pinnedRef.current) return;
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages.length, liveMessage?.content, liveMessage?.thinking, autoScroll]);

  // Track whether we're parked at the bottom. Our own auto-scroll lands here
  // (stays pinned); a user scrolling up disengages it; scrolling back re-pins.
  const onThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const selectApp = (name: string) => {
    setApp(name);
    localStorage.setItem(APP_KEY, name);
    setConversationId(undefined); // a fresh thread for the new app's context
  };

  const send = () => {
    const q = input.trim();
    if (!q || app === null || askM.isPending) return;
    pinnedRef.current = true; // re-pin for the fresh answer
    setInput("");
    localStorage.removeItem(INPUT_KEY);
    askM.mutate({
      question: q,
      attachments: attachments.length ? attachments : undefined,
      images: images.length ? images : undefined,
    });
    setAttachments([]);
    setImages([]);
  };

  // Read attached files as text (capped to 10), append to the pending list.
  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    const read = await Promise.all([...list].map(async (f) => ({ name: f.name, content: await f.text() })));
    setAttachments((prev) => [...prev, ...read].slice(0, 10));
    if (fileRef.current) fileRef.current.value = ""; // allow re-selecting the same file
  };

  // Read attached screenshots as data URLs (capped to 6) for the vision pipeline.
  const onImages = async (list: FileList | null) => {
    if (!list) return;
    const read = await Promise.all(
      [...list].map(
        (f) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(f);
          }),
      ),
    );
    setImages((prev) => [...prev, ...read].slice(0, 6));
    if (imageRef.current) imageRef.current.value = ""; // allow re-selecting the same file
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const state = status.data?.state ?? "missing";

  return (
    <div className="flex h-full flex-col">
      <PageHeading
        title="Ask"
        actions={
          <>
            {/* Page-local toggles — they only affect this Ask thread (auto-scroll
                pins to the latest output; debug reveals each answer's trace). */}
            <AutoScrollToggle />
            <DebugToggle />
            <button
              type="button"
              onClick={() => setConversationId(undefined)}
              disabled={!conversationId}
              className={`${BTN_GHOST_CLASS} px-2 py-0.5 text-xs`}
            >
              New chat
            </button>
          </>
        }
      />

      {/* App picker + index status strip */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={app ?? ""} onChange={(e) => selectApp(e.target.value)} className={`${FIELD_CLASS} max-w-xs`}>
          <option value="">💬 General (no repo)</option>
          {apps.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
          {apps.length === 0 && <option disabled>— no apps: run rubato-scan —</option>}
        </select>
        {app === "" && (
          <Tooltip content="The AI can read files in this folder (read-only; secrets excluded)" className="flex-1">
            <input
              value={fsRoot}
              onChange={(e) => {
                setFsRoot(e.target.value);
                localStorage.setItem(FSROOT_KEY, e.target.value);
              }}
              placeholder="📁 folder to explore (optional, e.g. ~/projects/my-app)"
              className={`${FIELD_CLASS} w-full`}
            />
          </Tooltip>
        )}
        {app && (
          <>
            <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
            {status.data?.chunks ? (
              <span className="text-xs text-gray-400">{status.data.chunks} chunks</span>
            ) : null}
            {status.data?.lastIndexedAt ? (
              <Tooltip content={`Last indexed ${new Date(status.data.lastIndexedAt).toLocaleString()}`} className="ml-auto">
                <span className="text-xs text-gray-400">
                  indexed {when(status.data.lastIndexedAt)}
                </span>
              </Tooltip>
            ) : null}
            <Tooltip
              multiline
              content="Scans this app's files and rebuilds the semantic search index the AI uses as context, so answers reflect the latest code. Run it after the repo changes; until indexed, replies have little or no codebase grounding."
            >
              <button
                type="button"
                onClick={() => reindex.mutate()}
                disabled={reindex.isPending}
                className={`${BTN_GHOST_CLASS} ${status.data?.lastIndexedAt ? "" : "ml-auto"} px-2 py-0.5 text-xs`}
              >
                {reindex.isPending ? "indexing…" : state === "missing" ? "Index Now" : "Reindex"}
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {/* Conversation history for this mode (app or general) */}
      {app !== null && convos.length > 0 && (
        <details className="mb-3">
          <summary className="cursor-pointer text-xs text-gray-400">History ({convos.length})</summary>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto">
            {convos.map((co) => (
              <li key={co.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setConversationId(co.id)}
                  className={`flex-1 truncate rounded px-2 py-1 text-left text-xs ${
                    co.id === conversationId
                      ? "bg-accent-soft text-accent"
                      : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                  }`}
                >
                  {co.title || "(untitled)"}
                  <span className="ml-2 text-gray-400">{when(co.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (await confirm({ prompt: "Delete this conversation?", confirmText: "Delete" }))
                      delConvo.mutate(co.id);
                  }}
                  className="shrink-0 px-1.5 text-gray-400 hover:text-red-500"
                  aria-label="delete conversation"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Thread */}
      <div ref={threadRef} onScroll={onThreadScroll} className="flex-1 space-y-3 overflow-x-hidden overflow-y-auto rounded-xl pr-1">
        {messages.length === 0 && !liveMessage && !askM.isPending && (
          <p className="mt-8 text-center text-sm text-gray-400">
            {app ? (
              <>
                Ask a question about <span className="font-medium">{app}</span> — its files are the context.
              </>
            ) : (
              "Ask anything — no repo context. Attach files, or point at a folder above to let the AI explore it."
            )}
          </p>
        )}
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        {liveMessage && <Message key={liveMessage.id} message={liveMessage} />}
        {showStatus && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-400 dark:border-gray-800 dark:bg-gray-900">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              {statusText}
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="mt-3">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: attachments are positional
                key={i}
                className="inline-flex items-center gap-1 rounded-lg bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              >
                📎 {a.name}
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  className="text-gray-400 hover:text-red-500"
                  aria-label={`remove ${a.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((src, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: screenshots are positional
                key={i}
                className="relative inline-block"
              >
                <img
                  src={src}
                  alt={`screenshot ${i + 1}`}
                  className="h-14 w-14 rounded-lg border border-gray-200 object-cover dark:border-gray-700"
                />
                <button
                  type="button"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  className="-top-1.5 -right-1.5 absolute flex h-4 w-4 items-center justify-center rounded-full bg-gray-700 text-white text-xs hover:bg-red-500"
                  aria-label={`remove screenshot ${i + 1}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
          <Tooltip content="Attach files (sent as context)">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={app === null}
              aria-label="Attach files (sent as context)"
              className={`${BTN_GHOST_CLASS} h-10 px-3`}
            >
              📎
            </button>
          </Tooltip>
          <input
            ref={imageRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => onImages(e.target.files)}
          />
          <Tooltip content="Attach screenshots (analyzed by the vision model)">
            <button
              type="button"
              onClick={() => imageRef.current?.click()}
              disabled={app === null}
              aria-label="Attach screenshots (analyzed by the vision model)"
              className={`${BTN_GHOST_CLASS} h-10 px-3`}
            >
              🖼️
            </button>
          </Tooltip>
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (e.target.value) localStorage.setItem(INPUT_KEY, e.target.value);
              else localStorage.removeItem(INPUT_KEY);
            }}
            onKeyDown={onKey}
            rows={2}
            placeholder={
              app === null
                ? "Choose a mode above…"
                : app
                  ? `Ask about ${app}…  (Enter to send, Shift+Enter for newline)`
                  : "Ask anything…  (Enter to send, Shift+Enter for newline)"
            }
            disabled={app === null}
            className={`${FIELD_CLASS} resize-none`}
          />
          <button
            type="button"
            onClick={send}
            disabled={app === null || !input.trim() || askM.isPending}
            className={`${BTN_PRIMARY_CLASS} h-10`}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
