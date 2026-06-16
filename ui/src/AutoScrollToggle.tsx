import { toggleAutoScroll, useAutoScroll } from "./autoscroll";
import { Tooltip } from "./components";
import { IconScrollDown } from "./icons";

export function AutoScrollToggle() {
  const on = useAutoScroll();
  return (
    <Tooltip content={on ? "Auto-scroll chat: on" : "Auto-scroll chat: off"}>
    <button
      type="button"
      onClick={toggleAutoScroll}
      aria-label="Toggle chat auto-scroll"
      aria-pressed={on}
      className={`icon-btn ${on ? "text-accent" : ""}`}
    >
      <IconScrollDown />
    </button>
    </Tooltip>
  );
}
