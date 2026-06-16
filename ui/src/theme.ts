// Theme state lives on the <html> `.dark` class (see styles.css) and is mirrored
// to localStorage. The initial class is set by an inline script in index.html
// before paint to avoid a flash; these helpers drive runtime toggling.

export type Theme = "light" | "dark";

export function getTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function setTheme(theme: Theme): Theme {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // private mode / storage disabled — class still applies for this session.
  }
  return theme;
}

export function toggleTheme(): Theme {
  return setTheme(getTheme() === "dark" ? "light" : "dark");
}
