export const meta = {
  name: 'ux-anchoring-critic-310',
  description:
    'Adversarial status-quo-bias gate for UI design — flags every way a proposed UI/page/nav still MIRRORS the pre-refactor app (same nav categories, page boundaries, flows, density) and demands a bolder, north-star-realizing alternative for each; passes only when no material/severe anchoring or clear improvement remains.',
  phases: [
    { title: 'Flag', detail: 'seven adversarial lenses (nav/boundaries/flow/density/linking/carryover/bolder) hunt anchoring in parallel' },
    { title: 'Verify', detail: 'each finding adversarially verified — real anchoring? alternative bolder + grounded? not a §11-proven carry-over? drop the unconfirmed' },
    { title: 'Synthesize', detail: 'aggregate into the gate verdict + the §12 north-star realization check + prioritized redesign directive' },
    { title: 'Iterate', detail: 'on NOT-PASS emit the redesign directive; the worker redesigns and re-runs the gate' },
  ],
}

// ---- Inputs (args) ----------------------------------------------------------
// northStar : the full text of the UX north-star (UX_NORTH_STAR.md). The bar. REQUIRED.
// scope     : one-line description of the UI under review (task slug + what surface/nav/page it designs).
// target    : the proposed design / nav spec / built UI / diff to critique. REQUIRED.
// bestInClass : optional reference products to benchmark the "bolder" lens against.
// focusCategories : optional subset of the seven lens keys to scope the run (default: all seven).
// maxRounds : optional in-run iterate cap (default 1 — the real loop is worker-driven re-runs).
const NORTH_STAR = args?.northStar ?? '(The UX north-star was not supplied — the critic CANNOT ground its findings or run the §12 realization check; supply UX_NORTH_STAR.md.)'
const SCOPE = args?.scope ?? '(unspecified UI change)'
const TARGET = args?.target ?? '(no target supplied — supply the proposed design / nav spec / built UI / diff under review.)'
const BEST_IN_CLASS =
  Array.isArray(args?.bestInClass) && args.bestInClass.length
    ? args.bestInClass.join(', ')
    : 'Linear, Superhuman, Things, Notion, Arc, Apple (HIG), Raycast, Vercel, Stripe'
const ALL_KEYS = ['nav', 'boundaries', 'flow', 'density', 'linking', 'carryover', 'bolder']
const FOCUS = Array.isArray(args?.focusCategories) && args.focusCategories.length ? args.focusCategories : ALL_KEYS
const MAX_ROUNDS = Math.max(1, Number(args?.maxRounds ?? 1))

// ---- The seven anchoring lenses (the four named anchoring axes + the north-star
//      vision dimensions + the bolder-than-best-in-class check; grounds in the
//      supplied north-star's §12 anti-anchoring gate). -------------------------
const CATEGORIES = {
  nav: {
    name: 'NAV / IA anchoring — same nav categories (job, not table)',
    hunt: `The information architecture is the OLD app's taxonomy renamed, not re-derived from the user's JOBS. Look for: a nav item / top-level place / hub / tab that reads as one of our FEATURE NAMES (Notes/Lists/Contacts/Tools/Workspace/Curl/Query/ServiceNow) instead of a job (§12.1 — the tell is "X-hub becomes Y-place", a 1:1 rename of the old 8/6-hub tree); a capability parked in a "More / MAKE / Workshop / Tools / Settings" JUNK DRAWER instead of designed as a room or dissolved into objects+commands (§12.3); nav depth/count that mirrors the old sidebar rather than the north-star's small set of "places". The test: "if you'd never seen the old app, would you carve the nav THIS way for these jobs?" If the only honest description is "old-hub → new-place", it anchored.`,
    demand: `Re-derive every place/label from a §1 JOB, not a feature. Replace the old hub taxonomy with the north-star's places + the object+command registry + the command spine (⌘K). Dissolve drawers into objects+commands or design them as a real room. Name the job each surface serves.`,
  },
  boundaries: {
    name: 'PAGE / SURFACE boundary anchoring — same page boundaries (& over-unification)',
    hunt: `Page and surface boundaries trace the OLD per-feature silos rather than the object model — OR the redesign over-corrected and force-fit a distinct surface into the record/table model, losing what made it good. Look for: one page per old feature (a Budgets page AND a Finance page AND an Insurance page where one templated primitive belongs; Notes/Scratch, Contacts/Directory/Connections/Profiles, Curl/Query/ServiceNow kept as separate destinations — §11 duplications); a "public home inside the app" boundary confusion; CONVERSELY, a document / file / secret / conversation / game / media editor / calendar grid crushed into a generic record table and losing its native affordances (§12.6 over-unification — the answer is to DESIGN the surface, not table-ify it). Both the silo and the over-merge are findings.`,
    demand: `Boundaries follow the OBJECT + JOB, not the legacy feature. Collapse the proven duplications into one templated/faceted primitive; but where a surface is genuinely its own medium (§12.6), design that medium as a first-class room rather than a record view. State which it is and why.`,
  },
  flow: {
    name: 'FLOW & MODE anchoring — same flows, modal escapes, GET-unsafe interactions',
    hunt: `The interaction flow re-creates the old click-path, hides depth behind a mode switch, or breaks the command/URL contract. Look for: a Simple/Power, Calm/Workshop, or Basic/Advanced MODE TOGGLE to serve novice + expert (§12.2 — depth must be summoned in-context on ONE surface, never a global switch); a capture/classify step that acts on a GUESS with no visible parse, no Inbox landing, no one-tap correction, no explicit-type escape hatch (§12.5 — unsafe capture); a core interaction that BREAKS without sockets, or an action that is not expressible as a GET-only-safe command-URL (§12.8 — live enhances, never gates); a multi-step wizard/flow carried over verbatim where a single direct surface + summoned depth belongs.`,
    demand: `One surface, depth summoned in context (no mode toggle). Every capture shows its parse, lands in an Inbox, is one-tap correctable, with an explicit-type escape hatch. Every action is a command-URL (GET-only-safe); sockets only ENHANCE. Re-derive the flow from the job, not the old wizard.`,
  },
  density: {
    name: 'DENSITY & DEFAULT anchoring — same density, blank-canvas dumps, hand-waved authoring',
    hunt: `Visual density and the default state are inherited rather than designed. Look for: a blank canvas / empty widget grid / "configure your dashboard" dumped on the user instead of a system-COMPOSED opinionated default (§12.10); the same cramped table-density / chrome-heavy layout as the old app where the north-star calls for a calmer, content-first surface; a list/record/schema-authoring touch that "solves it by substrate" hand-waving instead of making the §8.1 authoring surface the FLAGSHIP (direct, fast, all types, inference overridable, rich types rendering in every view — §12.4). The tell: the default screen looks like the old app's default screen.`,
    demand: `Ship a system-composed, opinionated default (no blank canvas). Make schema/record authoring a direct, fast flagship surface (all types, overridable inference, rich rendering), not "the substrate handles it". Re-derive density + default from the job + Principle 9, not the old layout.`,
  },
  linking: {
    name: 'LINKING & CO-PRESENCE anchoring — technical link jargon, undesigned togetherness',
    hunt: `Connections between objects and between people are bolted on with old-app plumbing rather than native + felt. Look for: linking surfaced as "entity link" / "relationship" / "foreign key" JARGON or a separate modal, instead of in-place connection with live chips and natural language (§12.7); collaboration/togetherness DEMOTED to a boolean flag, a "Shared: yes", or a "Stream" tab instead of a DESIGNED co-presence (presence, shared space, sharing-as-action, a "shared with me" inbox — §12.9). The tell: connecting two things or two people feels like editing a database, not using a product.`,
    demand: `Linking is native, in-place, non-technical — live chips, connect-in-context, zero "entity link" jargon. Where the surface is collaborative, DESIGN togetherness (felt presence + shared space + sharing-as-action + a shared-with-me inbox), don't reduce it to a boolean.`,
  },
  carryover: {
    name: 'CARRY-OVER not justified — kept by inertia, not proven optimal',
    hunt: `Something retained from the old app shipped WITHOUT a proof it is optimal — the tell is the ABSENCE of a reason distinguishing it from "it was already there" (§12.11). Look for: a label, a layout, a flow, a component, a default, an organizing axis carried over with no §11-style justification; "users are familiar with it" / "it already worked this way" / "explicit is clearer" offered as the only defense (that is the FINDING, not a defense — unless §11 PROVED it). Every kept thing must earn its place against the north-star, or be replaced with the deliberate form.`,
    demand: `For each carry-over, supply a concrete proof it is optimal (in the §11 style — the real reason it beats the re-thought alternative) OR replace it with the north-star form. "It was there / users know it" is the finding, not a defense.`,
  },
  bolder: {
    name: 'BOLDER check — what best-in-class would do that this flinched from',
    hunt: `The design is safe where the north-star (and the best products) would be bold — it stops at "fine" instead of reaching the obvious better move. Benchmark against ${BEST_IN_CLASS}: what would they do for THIS surface/job that this design flinched from? Look for: a timid version of a command palette, a missed keyboard-first / URL-first path, a settings page where an inline opinionated control belongs, a generic list where a purpose-built view (Linear's, Things') would delight, a missed "one obvious primary action" the way Superhuman/Things commit. The test: name the bolder move; if it's obvious and untaken, that's the finding.`,
    demand: `Take the obvious bolder move, grounded in a specific best-in-class pattern (name the product + the pattern) AND a north-star principle. "Good enough" is the finding when a clearly-better, on-vision move exists.`,
  },
}

// ---- False-flag / proven-carry-over guardrails (mirrors the north-star §11 + §13) -
const FALSE_FLAG_GUARD = `
FALSE-FLAG DISCIPLINE — a critic that flags everything is as useless as one that flags nothing.
Anti-anchoring is NOT "delete everything familiar"; it is "keep only what is PROVEN optimal". The
north-star already litigated some of this — DROP any finding that collides with it (unless the
design brings NEW evidence, in which case raise it as an OPEN QUESTION, do not silently re-demand):
- PROVEN carry-over (§11) is NOT anchoring: anything the north-star explicitly justified keeping is
  a deliberate KEEP, not inertia. Re-flagging it is a false flag without new evidence.
- DEFERRED decisions (§13) are NOT failures: where the north-star defers a choice to implementation
  (facet model, template set, classifier scope, resolver weights, the Operate enumeration), the task
  CHOOSING a reasonable default is correct — do NOT flag it for "not matching" a particular answer the
  north-star deliberately left open. Flag only if the chosen default itself re-anchors (e.g. a
  type-first Library, which §13 explicitly rules out).
- NOT every familiarity is anchoring: a genuinely-universal convention (a back button, standard form
  affordances) is not "the old app" — the finding is mirroring OUR app's specific old structure, not
  using a web-standard control.
The bar to flag a kept thing is "no §11 proof + it mirrors OUR old app's structure", and the bar to
overturn a §11 KEEP / §13 deferral is NEW evidence — not unfamiliarity or symmetry.`

// ---- Schemas ----------------------------------------------------------------
const FINDING = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'location', 'mirrorsOldApp', 'gateItem', 'degradesQuality', 'bolderAlternative', 'groundedIn', 'severity'],
  properties: {
    title: { type: 'string', description: 'One-line headline of the anchoring / missed-bolder-move.' },
    location: { type: 'string', description: 'Which surface / nav item / page / flow / component in the design under review.' },
    mirrorsOldApp: { type: 'string', description: 'The concrete way it MIRRORS the pre-refactor app (the old hub renamed / the old page boundary / the old flow / the old density) — or, for the bolder lens, the specific timid choice.' },
    gateItem: { type: 'string', description: 'Which §12 anti-anchoring gate item (1–12) or north-star section this fires.' },
    degradesQuality: { type: 'string', enum: ['clarity', 'delight', 'power', 'coherence'], description: 'Which UX quality the anchoring degrades.' },
    bolderAlternative: { type: 'string', description: 'The bolder, more-optimal, north-star-realizing alternative. Be specific — name the place/command/surface and, for the bolder lens, the best-in-class pattern (product + pattern). Not "make it bolder".' },
    groundedIn: { type: 'string', description: 'North-star §/principle ref AND/OR a named best-in-class product pattern that proves the alternative (not invented).' },
    severity: { type: 'string', enum: ['none', 'minor', 'material', 'severe'], description: 'severe = the design IS the old taxonomy renamed / a forbidden mode toggle / a junk drawer / a blank-canvas default — reverts the vision; material = real anchoring or a clear missed bolder move the north-star names the fix for; minor = local timidity; none = false flag.' },
  },
}

const FLAG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'findings', 'sweepNotes'],
  properties: {
    category: { type: 'string', enum: ALL_KEYS },
    findings: { type: 'array', items: FINDING },
    sweepNotes: { type: 'string', description: 'What surfaces you examined and where you looked but found no anchoring (so the gate is auditable).' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmed', 'reason', 'adjustedSeverity', 'alternativeIsBolderAndGrounded', 'collidesWithProvenCarryOver'],
  properties: {
    confirmed: { type: 'boolean', description: 'True only if the design REALLY mirrors the old app here AND it survives the §11/§13 false-flag guard AND the alternative is genuinely bolder + on-vision + grounded.' },
    reason: { type: 'string', description: 'Why confirmed or dropped — cite the design fact and the guard check.' },
    adjustedSeverity: { type: 'string', enum: ['none', 'minor', 'material', 'severe'] },
    alternativeIsBolderAndGrounded: { type: 'boolean', description: 'Is bolderAlternative actually a bolder, north-star-realizing move proven by a north-star section or a named best-in-class pattern (not invented / not lateral)?' },
    collidesWithProvenCarryOver: { type: 'boolean', description: 'Does this re-flag a §11-PROVEN carry-over or demand a particular answer to a §13-DEFERRED decision? If so it is a false flag (unless new evidence).' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['passes', 'realizesVision', 'worstSeverity', 'gateItemsFired', 'byCategory', 'prioritizedRedesignDirective', 'openQuestions', 'summary'],
  properties: {
    passes: { type: 'boolean', description: 'TRUE only when NO confirmed finding is material or severe — i.e. no remaining anchoring AND no clear improvement.' },
    realizesVision: { type: 'boolean', description: 'The §12.0 check: does this design REALIZE the north-star vision (TRUE) or revert to inertia (FALSE)? FALSE forces a fail regardless of severity arithmetic.' },
    worstSeverity: { type: 'string', enum: ['none', 'minor', 'material', 'severe'] },
    gateItemsFired: { type: 'array', items: { type: 'string' }, description: 'Which of the 12 §12 anti-anchoring gate items fired (e.g. "1 Job-not-table", "2 No-mode-toggle").' },
    byCategory: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['category', 'count', 'worst'],
        properties: { category: { type: 'string' }, count: { type: 'number' }, worst: { type: 'string' } },
      },
    },
    prioritizedRedesignDirective: { type: 'array', items: { type: 'string' }, description: 'Ordered, actionable REDESIGN edits the worker must apply before re-running — severe → material first, each naming the surface + the bolder on-vision form to move to.' },
    openQuestions: { type: 'array', items: { type: 'string' }, description: 'New §13-style design questions this change surfaces + the critic\'s recommended default for each.' },
    summary: { type: 'string', description: 'The gate verdict in 2–4 sentences — anchoring found, vision realized or not, what must change.' },
  },
}

// ============ PHASE 1 — flag: seven adversarial lenses in parallel ===========
phase('Flag')

const activeCats = FOCUS.filter((k) => CATEGORIES[k])
log(`Flagging ${activeCats.length} anchoring lens(es) against: ${SCOPE}`)

const flagResults = await parallel(
  activeCats.map((key) => () =>
    agent(
      `You are an ADVERSARIAL UX status-quo-bias critic running the ${'`ux-anchoring-critic`'} gate. Your prior is that the designer ANCHORED — that they preserved the old app's structure out of inertia — until the design proves otherwise. Status-quo bias is the enemy: a redesign that quietly mirrors the pre-refactor app has FAILED even if it "works". Your single job for this pass: hunt ONLY lens (${key}) — ${CATEGORIES[key].name}.

THE BAR — the UX north-star (every finding must tie a concrete design fact to a §12 gate item / north-star section AND a degraded UX quality of {clarity, delight, power, coherence}, and carry a bolder, north-star-realizing alternative grounded in the north-star and/or a named best-in-class product pattern):
${NORTH_STAR}

WHAT TO HUNT for lens (${key}):
${CATEGORIES[key].hunt}

THE BOLDER / OPTIMAL ALTERNATIVE you must demand for each finding (ground it in a north-star section and/or a named best-in-class pattern — do not invent, do not go lateral):
${CATEGORIES[key].demand}
${FALSE_FLAG_GUARD}

THE UI UNDER REVIEW — scope: ${SCOPE}
${TARGET}

Be ruthless, specific, and CONSTRUCTIVE: every finding states exactly how the design mirrors the old app, names the §12 gate item, and carries a concrete bolder alternative + its grounding. If the design is genuinely re-thought-from-the-job for this lens, return an empty findings array and say where you looked in sweepNotes. Do NOT invent findings to look productive, and do NOT flag a §11-proven carry-over or a §13-deferred default. Return ONLY the structured object for lens (${key}).`,
      { label: `flag:${key}`, phase: 'Flag', schema: FLAG_SCHEMA, effort: 'max' },
    ).then((r) => (r ? { ...r, category: key } : null)),
  ),
)

const rawFindings = flagResults
  .filter(Boolean)
  .flatMap((r) => (r.findings ?? []).map((f) => ({ ...f, category: r.category })))
log(`Flagged ${rawFindings.length} candidate anchoring(s) across ${flagResults.filter(Boolean).length} lenses`)

// ============ PHASE 2 — verify each finding adversarially ===================
phase('Verify')

const verified = await parallel(
  rawFindings.map((f) => () =>
    agent(
      `You are an independent VERIFIER on the UX anchoring gate. A lens-(${f.category}) finding has been raised. Adversarially check it: (1) does the design REALLY mirror the old app here (real anchoring, not a misread)? (2) does it survive the §11/§13 false-flag guard — re-flagging a PROVEN carry-over or demanding a particular answer to a DEFERRED decision is a FALSE FLAG (drop unless the finding presents NEW evidence)? (3) is its bolderAlternative actually a BOLDER, north-star-REALIZING move (not lateral, not a different-but-equal taste) and grounded in a north-star section or a named best-in-class pattern (not invented)? Adjust severity to what the design actually warrants. Default to DROP when uncertain — a noisy gate is a useless gate, and a critic that just demands change-for-its-own-sake is as anchoring-blind as one that rubber-stamps.

THE BAR — the UX north-star:
${NORTH_STAR}
${FALSE_FLAG_GUARD}

THE UI UNDER REVIEW — scope: ${SCOPE}
${TARGET}

THE FINDING TO VERIFY:
${JSON.stringify(f, null, 2)}

Return ONLY the structured verdict.`,
      { label: `verify:${f.category}:${(f.title || '').slice(0, 32)}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' },
    ).then((v) => (v ? { finding: f, verify: v } : null)),
  ),
)

const confirmed = verified
  .filter(Boolean)
  .filter((x) => x.verify.confirmed && x.verify.alternativeIsBolderAndGrounded && !x.verify.collidesWithProvenCarryOver && x.verify.adjustedSeverity !== 'none')
  .map((x) => ({ ...x.finding, severity: x.verify.adjustedSeverity, verifyReason: x.verify.reason }))
log(`Confirmed ${confirmed.length}/${rawFindings.length} anchoring(s) after verification`)

// ============ PHASE 3 — synthesize the gate verdict =========================
phase('Synthesize')

const RANK = { none: 0, minor: 1, material: 2, severe: 3 }
const localWorst = confirmed.reduce((w, f) => (RANK[f.severity] > RANK[w] ? f.severity : w), 'none')
const localPasses = !confirmed.some((f) => f.severity === 'material' || f.severity === 'severe')

const verdict = await agent(
  `You are the lead synthesizer of the UX anchoring gate verdict. You are given the CONFIRMED anchorings (already verified + false-flag-filtered). Produce the gate verdict.

PASS RULE (non-negotiable): passes = TRUE only when NO confirmed finding is "material" or "severe" — i.e. no remaining anchoring AND no clear improvement (a clearly-better on-vision move is "material"). "minor"/"none" do not block. (Pre-computed: worst severity = "${localWorst}", so passes should be ${localPasses}. Honor this unless you find a severity that was mis-set.)

VISION-REALIZATION CHECK (§12.0): independently judge whether this design REALIZES the north-star vision or REVERTS to inertia. Set realizesVision accordingly. If realizesVision is FALSE the gate FAILS even if the severity arithmetic would pass — a death-by-a-thousand-minor-anchorings design has still failed. List which of the 12 §12 gate items fired in gateItemsFired.

Build the prioritizedRedesignDirective as ORDERED, ACTIONABLE redesign edits (severe → material → minor), each naming the surface + the exact bolder, on-vision form to move to — this is the worker's redesign to-do for the re-run. Surface any NEW §13-style design questions this change raises with your recommended default.

THE BAR — the UX north-star (for the §12 gate items, §13, and grounding):
${NORTH_STAR}

SCOPE: ${SCOPE}

CONFIRMED ANCHORINGS:
${JSON.stringify(confirmed, null, 2)}

Return ONLY the structured verdict.`,
  { label: 'synthesize:verdict', phase: 'Synthesize', schema: VERDICT_SCHEMA, effort: 'max' },
)

// ============ PHASE 4 — iterate gate (worker-driven re-run) ==================
phase('Iterate')

const finalVerdict = verdict ?? {
  passes: localPasses, realizesVision: localPasses, worstSeverity: localWorst, gateItemsFired: [],
  byCategory: [], prioritizedRedesignDirective: confirmed.map((f) => `[${f.severity}] ${f.location}: ${f.bolderAlternative}`),
  openQuestions: [], summary: 'Synthesis agent unavailable; verdict computed locally from confirmed anchorings.',
}

// The vision check can veto a severity-arithmetic pass.
const passes = finalVerdict.passes && finalVerdict.realizesVision !== false

if (passes) {
  log(`PASS — no material/severe anchoring and the design realizes the vision. It may build/land. (worst: ${finalVerdict.worstSeverity})`)
} else {
  const why = finalVerdict.realizesVision === false ? 'design reverts to inertia (vision not realized)' : `worst severity ${finalVerdict.worstSeverity}`
  log(`NOT PASS — ${why}. Apply the ${finalVerdict.prioritizedRedesignDirective?.length ?? 0}-step redesign directive, then RE-RUN the gate. The task is not done until the critic returns PASS.`)
}

return {
  scope: SCOPE,
  passes,
  realizesVision: finalVerdict.realizesVision,
  worstSeverity: finalVerdict.worstSeverity,
  gateItemsFired: finalVerdict.gateItemsFired,
  confirmedCount: confirmed.length,
  flaggedCount: rawFindings.length,
  verdict: finalVerdict,
  confirmedAnchorings: confirmed,
  // The loop is worker-driven: on NOT PASS, redesign per prioritizedRedesignDirective and re-invoke
  // this workflow against the revised design. maxRounds (${MAX_ROUNDS}) caps in-run rounds; the
  // authoritative re-run happens after the worker redesigns (see UX_ANCHORING_CRITIC.md §4/§7).
}
