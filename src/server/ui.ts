/** The single-file explorer UI (vanilla JS, no build step). Served at "/". */

export const UI_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rubato</title>
<style>
  :root { color-scheme: light dark; --b: #8884; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 1.5rem; max-width: 960px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { opacity: .6; margin-bottom: 1rem; }
  input { width: 100%; padding: .5rem .6rem; margin-bottom: 1rem; border: 1px solid var(--b); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
  .tabs { display: flex; gap: .5rem; margin-bottom: 1rem; }
  .tabs button { padding: .35rem .8rem; border: 1px solid var(--b); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font: inherit; }
  .tabs button.active { background: #8882; }
  .row { padding: .5rem .6rem; border: 1px solid var(--b); border-radius: 6px; margin-bottom: .4rem; }
  .row .name { font-weight: 600; }
  .row .meta { opacity: .65; font-size: .85em; }
  .tag { display: inline-block; padding: 0 .4em; border: 1px solid var(--b); border-radius: 4px; margin: 0 .2em .2em 0; font-size: .8em; opacity: .8; }
  .empty { opacity: .5; padding: 1rem 0; }
</style>
</head>
<body>
  <h1>rubato</h1>
  <div class="sub" id="sub">loading…</div>
  <input id="q" placeholder="filter…" autofocus />
  <div class="tabs">
    <button data-tab="apps" class="active">apps</button>
    <button data-tab="commands">commands</button>
  </div>
  <div id="list"></div>
<script>
  const state = { tab: "apps", q: "", apps: [], commands: [] };
  const el = (id) => document.getElementById(id);

  async function load() {
    const [apps, commands] = await Promise.all([
      fetch("/api/apps").then((r) => r.json()),
      fetch("/api/commands").then((r) => r.json()),
    ]);
    state.apps = apps; state.commands = commands;
    el("sub").textContent = apps.length + " apps · " + commands.length + " commands";
    render();
  }

  function matches(text, q) { return text.toLowerCase().includes(q); }

  function render() {
    const q = state.q.toLowerCase();
    const list = el("list");
    if (state.tab === "apps") {
      const rows = state.apps.filter((a) =>
        matches([a.name, a.group, a.dirName, (a.aliases || []).join(" ")].join(" "), q));
      list.innerHTML = rows.length ? rows.map(appRow).join("") : empty();
    } else {
      const rows = state.commands.filter((c) => matches(c.name + " " + c.description, q));
      list.innerHTML = rows.length ? rows.map(cmdRow).join("") : empty();
    }
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const empty = () => '<div class="empty">no matches</div>';
  const appRow = (a) =>
    '<div class="row"><div class="name">' + esc(a.name) + (a.group ? ' <span class="meta">/ ' + esc(a.group) + "</span>" : "") +
    "</div>" + (a.aliases || []).map((x) => '<span class="tag">' + esc(x) + "</span>").join("") +
    '<div class="meta">' + esc(a.absolutePath) + "</div></div>";
  const cmdRow = (c) =>
    '<div class="row"><div class="name">' + esc(c.name) + ' <span class="tag">' + esc(c.kind) + "</span></div>" +
    '<div class="meta">' + esc(c.description) + "</div></div>";

  el("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  for (const b of document.querySelectorAll(".tabs button")) {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      for (const x of document.querySelectorAll(".tabs button")) x.classList.toggle("active", x === b);
      render();
    });
  }
  load();
</script>
</body>
</html>`;
