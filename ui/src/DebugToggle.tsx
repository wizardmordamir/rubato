import { toggleDebug, useDebug } from "./debug";
import { Tooltip } from "./components";
import { IconBug } from "./icons";

/** Sidebar button that flips the "show AI debug info" preference. Lit when on. */
export function DebugToggle() {
  const on = useDebug();
  return (
    <Tooltip content={on ? "Hide AI debug info" : "Show AI debug info"}>
      <button
        type="button"
        onClick={toggleDebug}
        aria-label="Toggle AI debug info"
        aria-pressed={on}
        className={`icon-btn ${on ? "text-accent" : ""}`}
      >
        <IconBug />
      </button>
    </Tooltip>
  );
}
