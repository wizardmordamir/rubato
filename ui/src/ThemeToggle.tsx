import { useState } from "react";
import { Tooltip } from "./components";
import { IconMoon, IconSun } from "./icons";
import { getTheme, type Theme, toggleTheme } from "./theme";

/** Sidebar button that flips light/dark. Shows the icon for the mode you'd
 *  switch *to* (moon while light, sun while dark). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const next = theme === "dark" ? "light" : "dark";
  // The icon button is the control; on touch reveal the hint on tap rather than
  // appending a disclosure icon next to a toolbar button.
  return (
    <Tooltip content={`Switch to ${next} mode`} mobile="tap">
      <button
        type="button"
        onClick={() => setTheme(toggleTheme())}
        aria-label={`Switch to ${next} mode`}
        className="icon-btn"
      >
        {theme === "dark" ? <IconSun size={24} /> : <IconMoon size={24} />}
      </button>
    </Tooltip>
  );
}
