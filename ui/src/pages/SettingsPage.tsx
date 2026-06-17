// Settings — the user-facing customization page (route /settings, always available).
// Appearance toggles and nav guidance. Per-entry show/hide/color/reorder live ON
// the sidebar itself (the row kebab + drag + "Show hidden" + search).

import { UiScaleControl } from "cwip/react";
import { type ReactNode, useState } from "react";
import { toggleAutoScroll, useAutoScroll } from "../autoscroll";
import { CARD_CLASS, PageHeading, Switch } from "../components";
import { toggleDebug, useDebug } from "../debug";
import { useNavPrefs } from "../navPrefs";
import { getTheme, type Theme, toggleTheme } from "../theme";

function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={`${CARD_CLASS} p-4`}>
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
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

function NavigationCard() {
  return (
    <SettingsCard title="Navigation">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Reorder, recolor, or hide a sidebar item right from the sidebar — hover a row and use its ⋮ menu. Hidden items
        come back from "Show hidden" at the bottom of the sidebar, and the search box in the header jumps to any page,
        including ones inside a hub.
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
        <NavigationCard />
      </div>
    </div>
  );
}
