import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ART_ASPECTS, ART_PERFORMANCE_OPTIONS, CURATED_ART_STYLES } from "@shared/art";
import {
  type FooocusMemoryConfig,
  FOOOCUS_MEMORY_PRESETS,
  FOOOCUS_VRAM_MODES,
  type FooocusVramMode,
  fooocusServerView,
  memoryArgs,
} from "@shared/fooocus";
import {
  type ArtTuningState,
  cleanFooocusVram,
  fetchArtTuning,
  fetchFooocusOptions,
  fetchFooocusStats,
  fetchFooocusStatus,
  restartFooocusServer,
  saveArtTuning,
} from "../api";
import {
  Alert,
  Badge,
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  FIELD_CLASS,
  PageHeading,
  Spinner,
  Switch,
  Tooltip,
} from "../components";
import { useToast } from "../toast";

type ArtValues = ArtTuningState["art"];

/** A labelled, sliderable numeric control with a live readout. */
function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
  suffix,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: string;
  suffix?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="flex items-center justify-between font-medium text-gray-600 dark:text-gray-300">
        <span className="flex items-center gap-1">
          {label}
          {hint && (
            <Tooltip multiline content={hint}>
              <span className="cursor-help text-gray-400">ⓘ</span>
            </Tooltip>
          )}
        </span>
        <span className="tabular-nums text-gray-500 dark:text-gray-400">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-[var(--color-accent)]"
      />
    </label>
  );
}

/** A switch row with a label + tooltip hint, for the boolean memory flags. */
function ToggleRow({
  label,
  on,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Switch on={on} onChange={onChange} disabled={disabled} label={label} />
      <span className="font-medium text-gray-600 dark:text-gray-300">{label}</span>
      <Tooltip multiline content={hint}>
        <span className="cursor-help text-gray-400">ⓘ</span>
      </Tooltip>
    </div>
  );
}

function memEqual(a: FooocusMemoryConfig, b: FooocusMemoryConfig): boolean {
  return (
    (a.vram ?? "auto") === (b.vram ?? "auto") &&
    !!a.fp16 === !!b.fp16 &&
    !!a.attentionSplit === !!b.attentionSplit &&
    !!a.offloadFromVram === !!b.offloadFromVram &&
    !!a.disableOffload === !!b.disableOffload
  );
}

/** GB string from MB, one decimal. */
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

/**
 * Fooocus Tuning — reached from the Ask/Chat page and the Art Canvas. Gives
 * hands-on control over the quality↔speed↔memory trade-off of local art
 * generation, talking to the real Fooocus-API:
 *   - a live host-memory gauge + "Free memory now" (GET /v1/engines/clean_vram),
 *   - memory/VRAM launch flags (the big lever on the 32 GB-RAM problem) with a
 *     "Save & Restart" to apply them,
 *   - per-generation quality defaults (performance, size, refiner, guidance,
 *     sharpness, base model, styles) discovered live from the engine.
 */
export function ArtTuningPage() {
  const qc = useQueryClient();
  const { notify } = useToast();

  const tuning = useQuery({ queryKey: ["art-tuning"], queryFn: fetchArtTuning });
  const options = useQuery({ queryKey: ["fooocus-options"], queryFn: fetchFooocusOptions });
  const status = useQuery({ queryKey: ["fooocus-status"], queryFn: fetchFooocusStatus, refetchInterval: 4000 });
  const stats = useQuery({ queryKey: ["fooocus-stats"], queryFn: fetchFooocusStats, refetchInterval: 3000 });

  // Local editable mirror of the saved state, plus a snapshot for dirty-detection.
  const [art, setArt] = useState<ArtValues | null>(null);
  const [memory, setMemory] = useState<FooocusMemoryConfig>({});
  const [styleFilter, setStyleFilter] = useState("");

  useEffect(() => {
    if (tuning.data) {
      setArt(tuning.data.art);
      setMemory(tuning.data.memory ?? {});
    }
  }, [tuning.data]);

  const save = useMutation({
    mutationFn: () => saveArtTuning({ art: art ?? undefined, memory }),
    onSuccess: (state) => {
      qc.setQueryData(["art-tuning"], state);
      setArt(state.art);
      setMemory(state.memory ?? {});
      notify("Tuning saved.", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "Save failed", "error"),
  });

  const restart = useMutation({
    mutationFn: () => restartFooocusServer("api"),
    onSuccess: (s) => {
      qc.setQueryData(["fooocus-status"], s);
      notify("Restarting Fooocus — memory flags will apply once it's back up.", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "Restart failed", "error"),
  });

  const freeMem = useMutation({
    mutationFn: cleanFooocusVram,
    onSuccess: (r) => notify(r.message, r.ok ? "success" : "error"),
    onError: (e) => notify(e instanceof Error ? e.message : "Couldn't free memory", "error"),
  });

  const apiStatus = status.data?.api;
  const apiView = apiStatus ? fooocusServerView(apiStatus) : null;
  const apiRunning = !!apiStatus?.running;
  // Restarting only makes sense for an instance rubato manages; an external one
  // must be cycled by hand (mirrors the start/stop policy).
  const canRestart = !!apiStatus && (apiStatus.managed || !apiStatus.running);

  const savedMem = tuning.data?.memory ?? {};
  const memoryDirty = !memEqual(memory, savedMem);
  const artDirty = !!art && !!tuning.data && JSON.stringify(art) !== JSON.stringify(tuning.data.art);
  const dirty = memoryDirty || artDirty;

  const previewArgs = memoryArgs(memory);

  // Style chips: live engine styles when available, else the curated set. Always
  // surface the selected ones; filter the rest by the search box.
  const allStyles = useMemo<string[]>(() => {
    if (options.data && !options.data.offline && options.data.styles.length) return options.data.styles;
    return CURATED_ART_STYLES.map((s) => s.value);
  }, [options.data]);
  const selectedStyles = art?.styles ?? [];
  const visibleStyles = useMemo(() => {
    const f = styleFilter.trim().toLowerCase();
    const pool = f ? allStyles.filter((s) => s.toLowerCase().includes(f)) : allStyles;
    return pool.slice(0, 60); // cap the rendered list; the filter narrows further
  }, [allStyles, styleFilter]);

  if (!art) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }

  const patchArt = (p: Partial<ArtValues>) => setArt((prev) => (prev ? { ...prev, ...p } : prev));
  const toggleStyle = (value: string) =>
    patchArt({ styles: selectedStyles.includes(value) ? selectedStyles.filter((s) => s !== value) : [...selectedStyles, value] });

  const models = options.data?.models ?? [];
  const usedPct = stats.data?.host.usedPct ?? 0;
  const gaugeColor = usedPct >= 85 ? "bg-red-500" : usedPct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  const refinerDisabled = (art.refinerModel ?? "") === "None";

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeading
        title="Fooocus Tuning"
        actions={
          <div className="flex items-center gap-2 text-xs">
            <Link to="/chat" className={`${BTN_GHOST_CLASS} px-2 py-0.5`}>
              ← Chat
            </Link>
            <Link to="/art" className={`${BTN_GHOST_CLASS} px-2 py-0.5`}>
              Art Canvas
            </Link>
          </div>
        }
      />

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-8">
        {/* ── Live status + memory gauge ─────────────────────────────────── */}
        <section className={`${CARD_CLASS} flex flex-col gap-3`}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="font-medium">🎨 Fooocus API</span>
            {apiView ? <Badge tone={apiView.tone}>{apiView.text}</Badge> : <Spinner />}
            <span className="text-xs text-gray-400">:{apiStatus?.port ?? 8888}</span>
            {stats.data?.queue?.running && <Badge tone="warn">generating…</Badge>}
            <div className="ml-auto flex items-center gap-2">
              <Tooltip
                multiline
                content="Unload all models and free memory immediately (GET /v1/engines/clean_vram). Use it when you're done generating but Fooocus is still holding RAM. Models reload on your next image."
              >
                <button
                  type="button"
                  onClick={() => freeMem.mutate()}
                  disabled={!apiRunning || freeMem.isPending}
                  className={`${BTN_GHOST_CLASS} px-2 py-1 text-xs`}
                >
                  {freeMem.isPending ? "Freeing…" : "🧹 Free memory now"}
                </button>
              </Tooltip>
            </div>
          </div>

          {!apiRunning && (
            <Alert tone="info">
              The Fooocus API isn't running. Start it from the toggle on the{" "}
              <Link to="/chat" className="text-accent hover:underline">
                Chat page
              </Link>
              . Live model/style lists and memory actions need it up; you can still edit and save settings now.
            </Alert>
          )}

          {/* Host memory gauge — makes the RAM pressure the user is fighting visible. */}
          {stats.data && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>System memory</span>
                <span className="tabular-nums">
                  {gb(stats.data.host.usedMb)} / {gb(stats.data.host.totalMb)} used ({usedPct}%) · rubato{" "}
                  {gb(stats.data.processRssMb)}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
                <div className={`h-full rounded-full transition-all ${gaugeColor}`} style={{ width: `${usedPct}%` }} />
              </div>
            </div>
          )}
        </section>

        {/* ── Memory / VRAM (the RAM lever) ──────────────────────────────── */}
        <section className={`${CARD_CLASS} flex flex-col gap-4`}>
          <div>
            <h2 className="font-semibold">Memory &amp; speed</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              How Fooocus uses RAM/VRAM. These are launch flags — they apply on the next restart. On a 32 GB machine,{" "}
              <strong>Light</strong> is the recommended cure for running out of memory.
            </p>
          </div>

          {/* One-click presets */}
          <div className="flex flex-wrap gap-2">
            {FOOOCUS_MEMORY_PRESETS.map((p) => {
              const active = memEqual(memory, p.memory);
              return (
                <Tooltip key={p.key} multiline content={p.description}>
                  <button
                    type="button"
                    onClick={() => setMemory(p.memory)}
                    className={`${BTN_GHOST_CLASS} text-xs ${active ? "ring-2 ring-[var(--color-accent)]" : ""}`}
                  >
                    {p.label}
                  </button>
                </Tooltip>
              );
            })}
          </div>

          {/* VRAM strategy */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-600 dark:text-gray-300">VRAM strategy</span>
            <select
              className={`${FIELD_CLASS} max-w-sm`}
              value={memory.vram ?? "auto"}
              onChange={(e) => setMemory((m) => ({ ...m, vram: e.target.value as FooocusVramMode }))}
            >
              {FOOOCUS_VRAM_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-gray-400">
              {FOOOCUS_VRAM_MODES.find((m) => m.value === (memory.vram ?? "auto"))?.hint}
            </span>
          </label>

          {/* Boolean flags */}
          <div className="flex flex-col gap-2">
            <ToggleRow
              label="Half precision (fp16)"
              on={!!memory.fp16}
              onChange={(v) => setMemory((m) => ({ ...m, fp16: v }))}
              hint="--all-in-fp16: run everything in half precision. Roughly halves model memory with little quality loss. Recommended."
            />
            <ToggleRow
              label="Memory-efficient attention"
              on={!!memory.attentionSplit}
              onChange={(v) => setMemory((m) => ({ ...m, attentionSplit: v }))}
              hint="--attention-split: sub-quadratic attention. Lowers peak memory at large sizes; a little slower."
            />
            <ToggleRow
              label="Offload weights between steps"
              on={!!memory.offloadFromVram}
              onChange={(v) => setMemory((m) => ({ ...m, offloadFromVram: v, disableOffload: v ? false : m.disableOffload }))}
              hint="--always-offload-from-vram: move model weights out of memory between stages. Lightest footprint, slowest. Great for 32 GB."
            />
            <ToggleRow
              label="Keep weights resident (fastest)"
              on={!!memory.disableOffload}
              disabled={!!memory.offloadFromVram}
              onChange={(v) => setMemory((m) => ({ ...m, disableOffload: v }))}
              hint="--disable-offload-from-vram: never offload — fastest, heaviest. Only when you have RAM to spare (conflicts with offload)."
            />
          </div>

          {/* Launch-flag preview */}
          <div className="text-xs text-gray-500 dark:text-gray-400">
            <span className="mr-2 font-medium">Restart flags:</span>
            {previewArgs.length ? (
              <code className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">{previewArgs.join(" ")}</code>
            ) : (
              <span className="italic">none (Fooocus auto-detects)</span>
            )}
          </div>

          {apiStatus && !apiStatus.managed && apiStatus.running && (
            <Alert tone="warning">
              Fooocus was started outside rubato, so it can't be restarted from here. Restart it where you launched it for
              new memory flags to take effect.
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Tooltip
              multiline
              content="Save the memory flags, then restart the Fooocus API so they take effect. Interrupts any running generation and reloads models (~1 min)."
            >
              <button
                type="button"
                onClick={async () => {
                  await save.mutateAsync();
                  restart.mutate();
                }}
                disabled={!canRestart || save.isPending || restart.isPending}
                className={`${BTN_PRIMARY_CLASS} text-sm`}
              >
                {restart.isPending ? "Restarting…" : "💾 Save & Restart Fooocus"}
              </button>
            </Tooltip>
            <span className="text-xs text-gray-400">
              Memory flags need a restart. Quality defaults below apply to your next image with no restart.
            </span>
          </div>
        </section>

        {/* ── Quality vs speed (per-generation defaults) ─────────────────── */}
        <section className={`${CARD_CLASS} flex flex-col gap-4`}>
          <div>
            <h2 className="font-semibold">Quality vs speed</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Defaults applied to every generation (Art Canvas + the Art Co-Pilot chat). Take effect immediately — no
              restart.
            </p>
          </div>

          {/* Performance */}
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-gray-600 dark:text-gray-300">Performance</span>
            <div className="flex flex-wrap gap-1.5">
              {ART_PERFORMANCE_OPTIONS.map((p) => (
                <button
                  type="button"
                  key={p.value}
                  onClick={() => patchArt({ performance: p.value })}
                  className={`${BTN_GHOST_CLASS} text-xs ${art.performance === p.value ? "ring-2 ring-[var(--color-accent)]" : ""}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Default size */}
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="flex items-center gap-1 font-medium text-gray-600 dark:text-gray-300">
              Default size
              <Tooltip multiline content="Smaller images use much less memory and finish faster. A request that specifies its own size still wins.">
                <span className="cursor-help text-gray-400">ⓘ</span>
              </Tooltip>
            </span>
            <div className="flex flex-wrap gap-1.5">
              {ART_ASPECTS.map((a) => {
                const active = art.width === a.width && art.height === a.height;
                return (
                  <button
                    type="button"
                    key={a.key}
                    onClick={() => patchArt({ width: a.width, height: a.height })}
                    className={`${BTN_GHOST_CLASS} text-xs ${active ? "ring-2 ring-[var(--color-accent)]" : ""}`}
                  >
                    {a.label} · {a.width}×{a.height}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Refiner (memory lever) */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="flex items-center gap-1 font-medium text-gray-600 dark:text-gray-300">
              Refiner
              <Tooltip multiline content="A second model that polishes the last steps. It improves detail but roughly doubles resident weights — set 'None' to save memory.">
                <span className="cursor-help text-gray-400">ⓘ</span>
              </Tooltip>
            </span>
            <select
              className={`${FIELD_CLASS} max-w-sm`}
              value={art.refinerModel ?? ""}
              onChange={(e) => patchArt({ refinerModel: e.target.value })}
            >
              <option value="">Engine default</option>
              <option value="None">None — disable (saves memory)</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          {!refinerDisabled && (
            <Slider
              label="Refiner switch"
              value={art.refinerSwitch}
              min={0.1}
              max={1}
              step={0.05}
              onChange={(v) => patchArt({ refinerSwitch: v })}
              hint="Fraction of steps before the refiner takes over (1.0 ≈ never). Higher = the base model does more of the work."
            />
          )}

          {/* Base model */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-600 dark:text-gray-300">Base model (checkpoint)</span>
            <select
              className={`${FIELD_CLASS} max-w-sm`}
              value={art.baseModel ?? ""}
              onChange={(e) => patchArt({ baseModel: e.target.value })}
            >
              <option value="">Engine default</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {options.data?.offline && (
              <span className="text-xs text-gray-400">Start the Fooocus API to load your installed checkpoints.</span>
            )}
          </label>

          <Slider
            label="Guidance (CFG)"
            value={art.guidanceScale}
            min={1}
            max={20}
            step={0.5}
            onChange={(v) => patchArt({ guidanceScale: v })}
            hint="How literally the model follows the prompt. Fooocus is tuned for ~4. Higher = stronger adherence but can look harsh."
          />
          <Slider
            label="Sharpness"
            value={art.sharpness}
            min={0}
            max={30}
            step={0.5}
            onChange={(v) => patchArt({ sharpness: v })}
            hint="Fooocus detail sharpening. Default 2."
          />

          {/* Negative prompt */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-600 dark:text-gray-300">Global negative prompt</span>
            <input
              value={art.negativePrompt}
              onChange={(e) => patchArt({ negativePrompt: e.target.value })}
              placeholder="appended to every generation (e.g. text, watermark, blurry)"
              className={FIELD_CLASS}
            />
          </label>

          {/* Styles */}
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="flex items-center justify-between font-medium text-gray-600 dark:text-gray-300">
              <span>
                Style stack <span className="text-gray-400">({selectedStyles.length} selected)</span>
              </span>
              <span className="text-xs font-normal text-gray-400">
                {options.data && !options.data.offline ? `${allStyles.length} live styles` : "curated styles"}
              </span>
            </span>
            {selectedStyles.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedStyles.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleStyle(s)}
                    className="inline-flex items-center gap-1 rounded-full border border-accent bg-accent-soft px-2 py-0.5 text-xs text-accent"
                  >
                    {s} <span className="text-accent/70">×</span>
                  </button>
                ))}
              </div>
            )}
            <input
              value={styleFilter}
              onChange={(e) => setStyleFilter(e.target.value)}
              placeholder="filter styles…"
              className={`${FIELD_CLASS} max-w-xs`}
            />
            <div className="flex max-h-48 flex-wrap gap-1 overflow-auto rounded-lg border border-gray-200 p-2 dark:border-gray-800">
              {visibleStyles.map((s) => (
                <button
                  type="button"
                  key={s}
                  onClick={() => toggleStyle(s)}
                  className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    selectedStyles.includes(s)
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-gray-300 text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
                  }`}
                >
                  {s}
                </button>
              ))}
              {!visibleStyles.length && <span className="text-xs text-gray-400">No styles match “{styleFilter}”.</span>}
            </div>
          </div>
        </section>

        {/* ── Sticky save bar ────────────────────────────────────────────── */}
        <div className="sticky bottom-0 flex items-center gap-3 rounded-xl border border-gray-200 bg-white/90 px-4 py-2.5 backdrop-blur dark:border-gray-800 dark:bg-gray-900/90">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {dirty ? "Unsaved changes" : "All changes saved"}
            {memoryDirty && <span className="ml-1 text-amber-500">· restart needed for memory flags</span>}
          </span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => {
                if (tuning.data) {
                  setArt(tuning.data.art);
                  setMemory(tuning.data.memory ?? {});
                }
              }}
              disabled={!dirty || save.isPending}
              className={`${BTN_GHOST_CLASS} text-sm`}
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={!dirty || save.isPending}
              className={`${BTN_PRIMARY_CLASS} text-sm`}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
