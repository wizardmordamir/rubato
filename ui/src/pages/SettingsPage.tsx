// Settings — the user-facing customization page (route /settings, always available).
// Appearance toggles and Pages (enable/disable features, which is server config
// `ui.pages` — moved here out of the gated Admin page so it's discoverable).
// Per-entry show/hide/color/reorder now live ON the sidebar itself (the row kebab +
// drag + "Show hidden" + search), so there's no nav list to maintain here.

import { NAV_HUBS, pagesInGroup, type UiPage, UI_PAGES } from "@shared/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UiScaleControl } from "cwip/react";
import { type ReactNode, useState } from "react";
import { fetchUi, saveUi } from "../api";
import { toggleAutoScroll, useAutoScroll } from "../autoscroll";
import { CARD_CLASS, OpenPathButton, PageHeading, Switch } from "../components";
import { toggleDebug, useDebug } from "../debug";
import { useNavPrefs } from "../navPrefs";
import { getTheme, type Theme, toggleTheme } from "../theme";
import { useToast } from "../toast";

function SettingsCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className={`${CARD_CLASS} p-4`}>
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {description && <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{description}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function SettingRow({ label, description, control }: { label: string; description?: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</p>
        {description && <p className="text-xs text-gray-500 dark:text-gray-400">{description}</p>}
      </div>
      {control}
    </div>
  );
}

function AppearanceCard() {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const { prefs, setCollapsed } = useNavPrefs();
  const autoScroll = useAutoScroll();
  const debug = useDebug();
  return (
    <SettingsCard title="Appearance">
      <SettingRow
        label="Dark mode"
        description="Switch between the light and dark theme."
        control={<Switch on={theme === "dark"} onChange={() => setTheme(toggleTheme())} label="Dark mode" />}
      />
      <SettingRow
        label="UI size"
        description="Scale the whole interface up or down for easier reading."
        control={<UiScaleControl />}
      />
      <SettingRow
        label="Keep sidebar collapsed"
        description="Start the desktop sidebar as an icon-only rail."
        control={<Switch on={prefs.collapsed} onChange={setCollapsed} label="Keep sidebar collapsed" />}
      />
      <SettingRow
        label="Auto-scroll chat"
        description="Pin the Ask thread to the latest streaming output."
        control={<Switch on={autoScroll} onChange={toggleAutoScroll} label="Auto-scroll chat" />}
      />
      <SettingRow
        label="Show AI debug info"
        description="Reveal the AI debug panel on the Ask page."
        control={<Switch on={debug} onChange={toggleDebug} label="Show AI debug info" />}
      />
    </SettingsCard>
  );
}

function PagesCard() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const { data: ui } = useQuery({ queryKey: ["ui"], queryFn: fetchUi });

  const save = useMutation({
    mutationFn: (p: { key: string; on: boolean }) => saveUi({ pages: { [p.key]: p.on } }),
    onSuccess: (next) => {
      qc.setQueryData(["ui"], next);
      qc.invalidateQueries({ queryKey: ["ui"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const groups: { label: string; pages: UiPage[] }[] = [
    { label: "General", pages: UI_PAGES.filter((p) => p.group === "top" && !p.mergedInto) },
    ...NAV_HUBS.map((h) => ({ label: h.label, pages: pagesInGroup(h.key) })),
  ];

  return (
    <SettingsCard
      title="Pages"
      description="Turn features on or off. Disabled pages are removed from the sidebar and their routes; hub pages appear once one of their pages is on."
    >
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.label}>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">{g.label}</p>
            <ul className="space-y-1.5">
              {g.pages.map((p) => {
                const on = ui?.pages[p.key] ?? false;
                return (
                  <li key={p.key} className="flex items-center gap-3">
                    <Switch on={on} disabled={save.isPending} onChange={(v) => save.mutate({ key: p.key, on: v })} label={p.label} />
                    <span className="text-sm font-medium">{p.label}</span>
                    <span className="font-mono text-xs text-gray-400">{p.path}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-gray-400">
        The Admin page (backups + DB viewer) is enabled by setting{" "}
        <span className="font-mono">{`{"ui":{"admin":true}}`}</span> in <span className="font-mono">~/.rubato/config.json</span>
        <OpenPathButton path="~/.rubato/config.json" />.
      </p>
    </SettingsCard>
  );
}

export function SettingsPage() {
  return (
    <div>
      <PageHeading title="Settings" />
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <AppearanceCard />
        <PagesCard />
      </div>
    </div>
  );
}
