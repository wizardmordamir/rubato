import { type ReactNode, useCallback, useEffect } from "react";
import type { GeneratedAsset } from "../api";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS } from "../components";

/**
 * Full-screen image inspector for the Art gallery. Click-thumbnail → big view
 * with: ←/→ (and on-screen chevrons) to traverse, Esc to close, a bottom
 * filmstrip of neighbors, a metadata side panel (prompt/styles/seed/…), and
 * actions (Send to Vision Chat, Open original, Regenerate same-seed, Vary).
 */
export function ArtLightbox({
  assets,
  fileName,
  onClose,
  onNavigate,
  onSendToChat,
  onRegenerate,
  regenerating,
}: {
  assets: GeneratedAsset[];
  fileName: string;
  onClose: () => void;
  onNavigate: (fileName: string) => void;
  onSendToChat: (asset: GeneratedAsset) => void;
  onRegenerate: (asset: GeneratedAsset, mode: "same" | "vary") => void;
  regenerating?: boolean;
}) {
  const index = assets.findIndex((a) => a.fileName === fileName);
  const asset = index >= 0 ? assets[index] : undefined;

  const go = useCallback(
    (delta: number) => {
      if (index < 0) return;
      const next = assets[(index + delta + assets.length) % assets.length];
      if (next) onNavigate(next.fileName);
    },
    [assets, index, onNavigate],
  );

  // Keyboard: arrows traverse, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  if (!asset) return null;
  const meta = asset.meta;
  // A 11-wide window of the filmstrip centred on the current image.
  const stripStart = Math.max(0, Math.min(index - 5, assets.length - 11));
  const strip = assets.slice(stripStart, stripStart + 11);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled above; backdrop click is a convenience close.
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm" onClick={onClose}>
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-4 py-2 text-sm text-gray-300"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="font-mono text-xs">
          {index + 1} / {assets.length}
        </span>
        <div className="flex items-center gap-2">
          <a
            href={asset.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-gray-600 px-2.5 py-1 text-xs transition-colors hover:bg-white/10"
          >
            Open original ↗
          </a>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-lg leading-none text-gray-300 transition-colors hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Stage: image + chevrons + metadata panel */}
      <div className="flex min-h-0 flex-1 items-stretch" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => go(-1)}
          className="px-2 text-3xl text-gray-400 transition-colors hover:text-white sm:px-4"
          aria-label="Previous"
        >
          ‹
        </button>

        <div className="flex min-w-0 flex-1 items-center justify-center p-2">
          <img
            src={asset.url}
            alt={meta?.prompt ?? asset.fileName}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
        </div>

        <button
          type="button"
          onClick={() => go(1)}
          className="px-2 text-3xl text-gray-400 transition-colors hover:text-white sm:px-4"
          aria-label="Next"
        >
          ›
        </button>

        {/* Metadata panel */}
        <aside className="hidden w-72 shrink-0 overflow-auto border-l border-white/10 bg-black/40 p-4 text-sm text-gray-200 lg:block">
          {meta ? (
            <div className="flex flex-col gap-3">
              <Field label="Prompt" value={meta.prompt} copyable />
              {meta.enrichedPrompt && meta.enrichedPrompt !== meta.prompt && (
                <Field label="Final prompt" value={meta.enrichedPrompt} copyable mono />
              )}
              {meta.negativePrompt && <Field label="Negative" value={meta.negativePrompt} mono />}
              {meta.styles.length > 0 && (
                <div>
                  <Label>Styles</Label>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {meta.styles.map((s) => (
                      <span key={s} className="rounded-full bg-white/10 px-2 py-0.5 text-xs">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Stat label="Size" value={`${meta.width}×${meta.height}`} />
                <Stat label="Quality" value={meta.performance || "—"} />
                <Stat label="Seed" value={meta.seed != null ? String(meta.seed) : "—"} />
                <Stat label="Engine" value={meta.backend} />
              </div>
              <span className="text-xs text-gray-500">{new Date(meta.generatedAt).toLocaleString()}</span>
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              No saved metadata for this image (generated before the ledger existed).
            </p>
          )}

          <div className="mt-4 flex flex-col gap-2">
            <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => onSendToChat(asset)}>
              Send to Vision Chat
            </button>
            {meta && (
              <div className="flex gap-2">
                <button
                  type="button"
                  className={`${BTN_GHOST_CLASS} flex-1 text-gray-200`}
                  disabled={regenerating}
                  title="Generate again with the same prompt + seed (reproduce)"
                  onClick={() => onRegenerate(asset, "same")}
                >
                  ↻ Regenerate
                </button>
                <button
                  type="button"
                  className={`${BTN_GHOST_CLASS} flex-1 text-gray-200`}
                  disabled={regenerating}
                  title="Same prompt, new random seed (a fresh variation)"
                  onClick={() => onRegenerate(asset, "vary")}
                >
                  ✦ Vary
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Filmstrip */}
      <div className="flex justify-center gap-1.5 overflow-x-auto px-4 py-2" onClick={(e) => e.stopPropagation()}>
        {strip.map((a) => (
          <button
            type="button"
            key={a.fileName}
            onClick={() => onNavigate(a.fileName)}
            className={`h-14 w-14 shrink-0 overflow-hidden rounded-md border-2 transition-colors ${
              a.fileName === fileName ? "border-accent" : "border-transparent opacity-60 hover:opacity-100"
            }`}
          >
            <img src={a.url} alt="" className="h-full w-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-xs font-medium uppercase tracking-wide text-gray-400">{children}</span>;
}

function Field({ label, value, copyable, mono }: { label: string; value: string; copyable?: boolean; mono?: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {copyable && (
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(value)}
            className="text-xs text-gray-400 transition-colors hover:text-white"
          >
            Copy
          </button>
        )}
      </div>
      <p className={`mt-0.5 whitespace-pre-wrap break-words text-xs text-gray-200 ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-white/5 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="truncate font-mono text-gray-200">{value}</div>
    </div>
  );
}
