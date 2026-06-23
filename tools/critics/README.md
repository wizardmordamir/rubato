# tools/critics

Reusable **adversarial critic** Workflows — independent reviewers with veto power that
hold work to a north-star. The design analogue of the server architecture critic: where
that one fights *anti-port / anti-duplication* in server code, this one fights
**status-quo bias** in UI design.

| Critic | Gate | Spec |
|---|---|---|
| `uxAnchoringCritic.mjs` | **UI design anchoring** — adversarial status-quo-bias gate run BEFORE a UI/page/nav design builds or lands; flags every way the design still mirrors the pre-refactor app (same nav categories, page boundaries, flows, density) and demands a bolder, north-star-realizing alternative for each | [`../../UX_ANCHORING_CRITIC.md`](../../UX_ANCHORING_CRITIC.md) (bar: the UX north-star, `UX_NORTH_STAR.md`) |

These are **Workflow scripts** (run via the Workflow tool / orchestrator), not part of the
app bundle — they live outside `src/` + `ui/src`, so they are intentionally excluded from
`tsc` / `biome` / `build` (ru's `tsconfig` includes only `src`; `biome` only `src/**`).
Run:

```js
Workflow({
  scriptPath: 'tools/critics/uxAnchoringCritic.mjs',
  args: {
    northStar: '<contents of UX_NORTH_STAR.md>',  // the bar (required)
    scope:     '<task slug + which surface/nav/page it designs>',
    target:    '<the proposed design / nav spec / built UI / diff under review>',  // required
    // bestInClass:     ['Linear','Superhuman','Things','Notion','Arc','Apple'],  // optional benchmark set
    // focusCategories: ['nav','flow','bolder'],  // optional: scope to a subset of the seven lenses
  },
})
```

The workflow returns a `verdict` with `passes` (true only when no `material`/`severe`
anchoring remains AND the design realizes the vision), the confirmed anchorings, the §12
gate items that fired, and a prioritized **redesign** directive for the re-run. See the
spec for the seven anchoring lenses, the severity model, the false-flag discipline
(§11-proven carry-overs / §13-deferred decisions are NOT anchoring), and how the gate is
wired into the pre-build/pre-landing flow for the UI tasks (rfc-33 / rfc-34–39 / rfc-40 +
future UI work).

The critic is **north-star-agnostic** — it takes the bar as an arg — so the one canonical
script gates both apps' UI work (ca's UX_NORTH_STAR.md today, a future ru north-star for
ru-specific surfaces).
