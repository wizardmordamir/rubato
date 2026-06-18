import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type ArtPreset,
  fetchApps,
  type GeneratedAsset,
  generateArt,
  listGeneratedAssets,
} from "../api";
import {
  Alert,
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  FIELD_CLASS,
  PageHeading,
  Spinner,
  Tooltip,
} from "../components";
import { useToast } from "../toast";

/** Handoff key the ChatPage reads on mount (mirrors its APP_KEY/FSROOT_KEY pattern). */
const PENDING_IMAGES_KEY = "rubato.chat.pendingImages";
const APP_KEY = "rubato.art.app";

const PRESETS: { value: ArtPreset; label: string; desc: string }[] = [
  { value: "web_ui", label: "Web UI mockup", desc: "Clean landing-page / UI layout concepts." },
  { value: "game_art_2d", label: "2D game art", desc: "Isolated sprite on a flat background, alpha-ready." },
  { value: "abstract_texture", label: "Abstract texture", desc: "Seamless patterns & wallpaper backgrounds." },
  { value: "app_icon", label: "App icon", desc: "Centered squircle icon, app-store style." },
  { value: "raw_creative", label: "Raw / no preset", desc: "Your prompt verbatim — no style modifiers." },
];

const DIMENSIONS: { label: string; width: number; height: number }[] = [
  { label: "Square 1024²", width: 1024, height: 1024 },
  { label: "Landscape 1216×832", width: 1216, height: 832 },
  { label: "Portrait 832×1216", width: 832, height: 1216 },
];

/** Fetch an asset and convert it to a base64 data URL for the vision chat handoff. */
async function urlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function ArtCanvasPage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const navigate = useNavigate();

  const apps = useQuery({ queryKey: ["apps"], queryFn: fetchApps });
  const [appId, setAppId] = useState<string>(() => localStorage.getItem(APP_KEY) ?? "");
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState<ArtPreset>("web_ui");
  const [dim, setDim] = useState(0);

  const galleryKey = appId || "__global";
  const gallery = useQuery({
    queryKey: ["generated-assets", galleryKey],
    queryFn: () => listGeneratedAssets(galleryKey),
  });

  const gen = useMutation({
    mutationFn: () =>
      generateArt({
        appId: appId || undefined,
        prompt,
        preset,
        width: DIMENSIONS[dim].width,
        height: DIMENSIONS[dim].height,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["generated-assets", galleryKey] });
      notify("Artwork generated.", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "Generation failed.", "error"),
  });

  const selectApp = (name: string) => {
    setAppId(name);
    localStorage.setItem(APP_KEY, name);
  };

  const sendToChat = async (asset: GeneratedAsset) => {
    try {
      const dataUrl = await urlToDataUrl(asset.url);
      const existing: string[] = JSON.parse(localStorage.getItem(PENDING_IMAGES_KEY) ?? "[]");
      localStorage.setItem(PENDING_IMAGES_KEY, JSON.stringify([...existing, dataUrl].slice(0, 6)));
      navigate("/chat");
    } catch {
      notify("Couldn't load that asset for the chat.", "error");
    }
  };

  // The offline diffusion server returns a 503 with an actionable message.
  const genError = gen.error instanceof Error ? gen.error.message : null;

  return (
    <div className="flex h-full flex-col">
      <PageHeading title="Art Canvas" />

      <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(320px,420px)_1fr]">
        {/* Left: inputs */}
        <div className="flex flex-col gap-4 overflow-auto pr-1">
          {genError && <Alert tone="warning">{genError}</Alert>}

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-600 dark:text-gray-300">App (asset folder)</span>
            <select className={FIELD_CLASS} value={appId} onChange={(e) => selectApp(e.target.value)}>
              <option value="">(global)</option>
              {apps.data?.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-600 dark:text-gray-300">Prompt</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="e.g. a friendly wizard mascot holding a glowing book"
              className={`${FIELD_CLASS} resize-none`}
            />
          </label>

          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-gray-600 dark:text-gray-300">Preset</span>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.value}
                  onClick={() => setPreset(p.value)}
                  className={`${CARD_CLASS} text-left ${
                    preset === p.value ? "ring-2 ring-[var(--color-accent)]" : ""
                  }`}
                >
                  <div className="font-medium">{p.label}</div>
                  <div className="text-gray-500 text-xs dark:text-gray-400">{p.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-gray-600 dark:text-gray-300">Dimensions</span>
            <div className="flex flex-wrap gap-1.5">
              {DIMENSIONS.map((d, i) => (
                <button
                  type="button"
                  key={d.label}
                  onClick={() => setDim(i)}
                  className={`${BTN_GHOST_CLASS} ${dim === i ? "ring-2 ring-[var(--color-accent)]" : ""}`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => gen.mutate()}
            disabled={!prompt.trim() || gen.isPending}
            className={`${BTN_PRIMARY_CLASS} mt-1`}
          >
            {gen.isPending ? "Generating…" : "Generate"}
          </button>
        </div>

        {/* Right: gallery */}
        <div className="overflow-auto">
          {gallery.isLoading ? (
            <Spinner />
          ) : !gallery.data?.files.length ? (
            <div className="grid h-full place-items-center text-gray-400 text-sm">
              No assets yet for {appId || "(global)"} — generate one on the left.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {gallery.data.files.map((asset) => (
                <div key={asset.fileName} className={`${CARD_CLASS} group relative overflow-hidden p-0`}>
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: image preview, action is the button below */}
                  <img src={asset.url} alt={asset.fileName} className="aspect-square w-full object-cover" />
                  <div className="absolute inset-x-0 bottom-0 flex justify-center bg-black/55 p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <Tooltip content="Send this asset to the vision chat as an attachment">
                      <button type="button" onClick={() => sendToChat(asset)} className={`${BTN_GHOST_CLASS} text-xs`}>
                        Send to Vision Chat
                      </button>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
