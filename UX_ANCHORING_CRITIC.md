# UX anchoring critic — the adversarial status-quo-bias gate for UI design

> Runnable: [`tools/critics/uxAnchoringCritic.mjs`](tools/critics/uxAnchoringCritic.mjs) ·
> Bar: the UX north-star (`UX_NORTH_STAR.md`) · Code analogue:
> `q-code-review-gate` (correctness) and cursedalchemy's
> `SERVER_ARCHITECTURE_CRITIC.md` (server architecture). This one is adversarial about
> **DESIGN anchoring**, not code correctness.

## 0. What this gate is, in one paragraph

The multi-app refactor re-derives every UI surface *from the user's jobs* on the shared
cursedbelt primitives. The standing risk is **status-quo bias**: a redesign that quietly
preserves the old app's structure — the same nav categories, the same page boundaries, the
same flows, the same density — and calls it done because it compiles and "works". A green
`tsc` + build + a passing render smoke prove the UI *runs*; they say nothing about whether
it was *re-thought*. This gate is the adversarial reviewer that proves the re-think: given a
proposed UI/page/nav design (or a built UI), it (1) lists EVERY way the design still mirrors
the pre-refactor app and, for each, demands a bolder, more-optimal alternative grounded in
UX principles + best-in-class products; (2) runs the north-star's §12 anti-anchoring gate —
does this realize the vision or revert to inertia?; (3) returns **PASS only when no
anchoring and no clear improvement remain**. Otherwise the design iterates.

## 1. Why a separate critic (and why adversarial)

The scoped engineering gate (tsc + lint + tests, plus the render smoke for UI-touching
work) and `q-code-review-gate` answer *"is the code correct, well-built, and does it do what
the task asked?"*. None of them can answer *"did the design escape the old app's gravity?"* —
a perfectly-correct, well-tested page can be a faithful re-skin of the surface it was meant
to replace. Status-quo bias is invisible to a correctness gate because the anchored design
is, locally, fine. It takes a reviewer whose **prior is that the designer anchored** — who
assumes inertia until the design proves otherwise — to surface it. So the critic is
deliberately adversarial and has **veto power**: a UI task is not done until the critic
returns PASS, exactly as a server task is not done until the architecture critic passes.

## 2. The bar: the north-star × the four UX qualities

Every finding ties a concrete **design fact** to two axes — *what good looks like* (a
north-star §/principle) and *why it matters* (a degraded UX quality):

### The four UX qualities (the *why it matters* axis)
- **clarity** — the user instantly knows where they are and what to do; nav/labels read as jobs.
- **delight** — the surface feels designed and bold, not a dutiful re-skin.
- **power** — depth is reachable in-context; expert paths (command/URL/keyboard) are first-class.
- **coherence** — one model across surfaces; connections + co-presence feel native, not bolted on.

### The bar (the *what good looks like* axis)
The supplied **UX north-star** is the bar. Its **§12 anti-anchoring gate** is the 12-item
checklist this critic enforces; its **§11** records the *proven* carry-overs (deliberate
KEEPs — not anchoring); its **§13** records the *deferred* decisions (choosing a sane default
is correct, not a failure). The critic is **north-star-agnostic** — it takes the bar as an
arg — so the same script gates both apps.

## 3. The seven anchoring lenses — what to hunt, and the bolder alternative to demand

The four anchoring axes the task names (nav categories, page boundaries, flows, density) are
first-class lenses; the remaining north-star vision dimensions and the bolder-than-best-in-class
check round out the seven. Each lens maps to specific §12 gate items.

### (nav) NAV / IA anchoring — *same nav categories (job, not table)* — §12.1, §12.3
The IA is the old taxonomy renamed, not re-derived from jobs: a place/hub/tab that reads as a
feature name (Notes/Tools/Workspace/Curl/Query) instead of a job; a capability parked in a
More/MAKE/Tools junk drawer; nav depth mirroring the old sidebar. **Demand:** re-derive every
place from a §1 job; replace the old hub tree with the north-star's places + the object+command
registry + ⌘K; dissolve drawers into objects+commands or design them as a real room.

### (boundaries) PAGE / SURFACE boundary anchoring — *same page boundaries (& over-unification)* — §12.6, §12.3
Page boundaries trace the old per-feature silos (Budgets/Finance/Insurance as three pages;
Notes/Scratch; Curl/Query/ServiceNow as separate destinations) — OR the redesign over-corrected
and crushed a distinct medium (document / file / conversation / game / calendar grid) into a
generic record table, losing its affordances. **Demand:** boundaries follow the object + job;
collapse the proven duplications into one templated primitive; design a genuine medium as a
first-class room, don't table-ify it.

### (flow) FLOW & MODE anchoring — *same flows, modal escapes, GET-unsafe interactions* — §12.2, §12.5, §12.8
A Simple/Power (or Calm/Workshop) mode toggle to serve novice + expert; a capture step that
acts on a guess with no visible parse / Inbox / one-tap correction / explicit-type escape; a
core interaction that breaks without sockets or isn't a GET-only-safe command-URL; an old
multi-step wizard carried over verbatim. **Demand:** one surface, depth summoned in context (no
mode toggle); safe capture (visible parse + Inbox + correction + escape hatch); every action a
command-URL, sockets only enhance.

### (density) DENSITY & DEFAULT anchoring — *same density, blank-canvas dumps, hand-waved authoring* — §12.10, §12.4
A blank canvas / empty widget grid / "configure your dashboard" dumped on the user instead of a
system-composed opinionated default; the same cramped chrome-heavy density as the old app; a
schema/record-authoring touch "solved by substrate" hand-waving instead of the §8.1 authoring
flagship. **Demand:** a system-composed opinionated default; authoring as a direct, fast flagship
(all types, overridable inference, rich rendering); re-derive density from the job, not the old
layout.

### (linking) LINKING & CO-PRESENCE anchoring — *technical jargon, undesigned togetherness* — §12.7, §12.9
Linking surfaced as "entity link" / "relationship" jargon or a separate modal instead of
in-place connection with live chips; collaboration demoted to a boolean / "Shared: yes" / a
"Stream" tab instead of designed co-presence. **Demand:** native, in-place, non-technical
linking; where collaborative, DESIGN togetherness (presence + shared space + sharing-as-action +
a shared-with-me inbox).

### (carryover) CARRY-OVER not justified — *kept by inertia, not proven optimal* — §12.11
Anything retained from the old app with no §11-style proof it is optimal — the tell is the
absence of a reason distinguishing it from "it was already there". "Users are familiar with it" /
"explicit is clearer" is the finding, not a defense (unless §11 proved it). **Demand:** a concrete
proof in the §11 style, or replacement with the north-star form.

### (bolder) BOLDER check — *what best-in-class would do that this flinched from* — §12.12
The design is safe where the north-star and the best products would be bold. Benchmark against
Linear / Superhuman / Things / Notion / Arc / Apple / Raycast / Vercel: a timid command palette,
a missed keyboard/URL-first path, a settings page where an inline opinionated control belongs, a
generic list where a purpose-built view would delight. **Demand:** take the obvious bolder move,
grounded in a specific best-in-class pattern (product + pattern) AND a north-star principle.

## 4. Severity, the PASS condition, and the iterate loop

Each confirmed finding gets a severity:

| Severity | Meaning |
|---|---|
| **severe** | The design IS the old taxonomy renamed / a forbidden mode toggle / a junk drawer / a blank-canvas default — it reverts the vision. |
| **material** | Real anchoring, or a clear missed bolder move, that degrades a UX quality and the north-star names the better form. |
| **minor** | Local timidity — noted, does not block. |
| **none** | False flag — dropped in verify. |

**PASS condition (non-negotiable):** the gate passes only when **no confirmed finding is
`material` or `severe`** — i.e. *no remaining anchoring and no clear improvement* (a
clearly-better on-vision move is `material`). **Plus** the §12.0 **vision-realization check**:
the synthesizer independently judges `realizesVision`; a design that dies by a thousand minor
anchorings can be FAILED on `realizesVision: false` even when the severity arithmetic would
pass. The runnable applies `passes = passes && realizesVision !== false`.

**The iterate loop is worker-driven:** on NOT PASS the gate emits an ordered
`prioritizedRedesignDirective` (severe → material first, each naming the surface + the bolder
on-vision form). The worker **redesigns** to that directive and **re-runs the gate against the
revised design**. The task is not done until the critic returns PASS. (`maxRounds` caps in-run
rounds; the authoritative loop is re-run-after-redesign.)

## 5. False-flag discipline — the critic must respect the deliberate

Anti-anchoring is *"keep only what is proven optimal"*, not *"delete everything familiar"*. The
critic DROPS a finding that collides with the north-star's own litigation (unless the design
brings NEW evidence, raised then as an open question, never a silent re-demand):

- **§11 PROVEN carry-overs are deliberate KEEPs**, not inertia — re-flagging one without new
  evidence is a false flag.
- **§13 DEFERRED decisions** — choosing a reasonable default is correct; do not flag it for "not
  matching" an answer the north-star deliberately left open. (Flag only if the chosen default
  itself re-anchors — e.g. a type-first Library, which §13 rules out.)
- **Universal web conventions** (a back button, standard form affordances) are not "the old app".
  The finding is mirroring OUR specific old structure, not using a standard control.

A critic that flags everything is as useless as one that rubber-stamps. Verify defaults to DROP
when uncertain, and confirms a finding only when the alternative is genuinely **bolder + on-vision
+ grounded** (a lateral, different-but-equal taste change is dropped).

## 6. The runnable critic — `tools/critics/uxAnchoringCritic.mjs`

Four phases (mirrors the server critic for consistency):

1. **Flag** — seven adversarial lens-agents (one per §3 lens) hunt anchoring in parallel, each
   grounded in the supplied north-star and forced through the `FINDING` schema.
2. **Verify** — every flagged finding is adversarially re-checked by an independent agent: real
   anchoring? survives §11/§13? alternative bolder + grounded? Unconfirmed / collide-with-KEEP /
   ungrounded findings are dropped; severity is adjusted.
3. **Synthesize** — the confirmed anchorings aggregate into the `VERDICT` — `passes`,
   `realizesVision`, `gateItemsFired`, and the ordered `prioritizedRedesignDirective`.
4. **Iterate** — on NOT PASS, emit the directive; the worker redesigns and re-runs.

Inputs (`args`): `northStar` (the bar, required), `scope` (task slug + surface), `target` (the
design/diff under review, required), optional `bestInClass` (benchmark set) and `focusCategories`
(lens subset). See `tools/critics/README.md` for the call shape. The script lives outside `src/`
so it is excluded from `tsc` / `biome` / `build`.

## 7. Wiring — the pre-build / pre-landing gate for UI tasks

Any task that **designs or builds a UI surface** — the shell/nav (rfc-33), the ca page domains
(rfc-34–39), ru adoption (rfc-40), and **all future UI work** — must pass this gate:

- **At design time, BEFORE building:** run the critic against the proposed design / nav spec so
  anchoring is caught while it is cheap to change (the cheapest redesign is the one not yet coded).
- **Before landing on `refactor/integration`,** after the scoped engineering gate (tsc + lint +
  test, + the render smoke for UI-touching work) is green: run the critic against the built UI /
  diff. A green build proves the UI *runs*, not that it *escaped the old app*. Land only on PASS.

The owner's localhost runs off `main`, which only ever fast-forwards to a verified-green
integration — so this gate is part of what "verified-green" means for UI work.

## 8. Relationship to the other gates

- **Engineering gate** (tsc + lint + test + render smoke) — *does it run + is it correct?*
- **`q-code-review-gate`** — *is the diff correct and does it do what the task asked?*
- **`SERVER_ARCHITECTURE_CRITIC.md`** (ca) — *was the server re-thought, not ported?*
- **this critic** — *did the UI escape status-quo bias and realize the vision?*

The four are complementary: the first three can all be green on a design that faithfully
re-skins the old app. This is the gate that proves the re-think.
