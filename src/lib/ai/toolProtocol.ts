/**
 * Provider-agnostic tool-calling protocol (pure). Instead of relying on a
 * provider's native function-calling, the model asks for tools by emitting a
 * fenced ```tool_use block of JSON; we parse, validate against each tool's param
 * spec, run the tools ourselves, and feed results back as "Observations". Works
 * on any text LLM — including locked-down endpoints with no function API.
 *
 * This module is the wire format only: types, the parser, param validation,
 * observation formatting, and the instruction block shown to the model. The
 * tools themselves (which do I/O against a repo/app) live server-side.
 */

export type ToolParamType = 'string' | 'number' | 'boolean';

export interface ToolParam {
  name: string;
  type: ToolParamType;
  description: string;
  required?: boolean;
}

/** What the model is told about a tool, and what we validate its calls against. */
export interface ToolSpec {
  name: string;
  description: string;
  params: ToolParam[];
}

/** One requested call, parsed from the model's tool_use block. */
export interface ToolCall {
  id: string;
  tool: string;
  params: Record<string, unknown>;
}

const FENCE = /```tool_use\s*([\s\S]*?)```/i;

/**
 * Extract the tool calls the model requested, or null if it asked for none
 * (i.e. it's ready to answer). Forgiving: accepts the fenced form first, then a
 * bare JSON object containing a `calls` array. Malformed JSON → null (treated as
 * "no tools"), so a chatty model can't wedge the loop.
 */
export function parseToolUse(text: string): ToolCall[] | null {
  const fenced = text.match(FENCE);
  const json = fenced ? fenced[1] : text.match(/\{[\s\S]*"calls"[\s\S]*\}/)?.[0];
  if (!json) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(json.trim());
  } catch {
    return null;
  }
  const calls = (raw as { calls?: unknown })?.calls;
  if (!Array.isArray(calls)) return null;

  const out: ToolCall[] = [];
  calls.forEach((c, i) => {
    if (typeof c !== 'object' || c === null) return;
    const obj = c as Record<string, unknown>;
    if (typeof obj.tool !== 'string' || !obj.tool.trim()) return;
    const params = typeof obj.params === 'object' && obj.params !== null ? (obj.params as Record<string, unknown>) : {};
    out.push({ id: typeof obj.id === 'string' && obj.id ? obj.id : `c${i + 1}`, tool: obj.tool, params });
  });
  return out.length ? out : null;
}

export type ValidatedParams = { ok: true; params: Record<string, unknown> } | { ok: false; error: string };

/** Validate + coerce a call's params against a spec. Returns an error string the
 *  model can act on (fed back as an observation) rather than throwing. */
export function validateCall(spec: ToolSpec, call: ToolCall): ValidatedParams {
  const params: Record<string, unknown> = {};
  for (const p of spec.params) {
    const raw = call.params[p.name];
    if (raw === undefined || raw === null || raw === '') {
      if (p.required) return { ok: false, error: `missing required param "${p.name}" (${p.type})` };
      continue;
    }
    if (p.type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isNaN(n)) return { ok: false, error: `param "${p.name}" must be a number` };
      params[p.name] = n;
    } else if (p.type === 'boolean') {
      params[p.name] = raw === true || raw === 'true';
    } else {
      params[p.name] = String(raw);
    }
  }
  return { ok: true, params };
}

export interface ObservationLine {
  id: string;
  tool: string;
  ok: boolean;
  content: string;
}

/** Render tool results back into a single user message for the next round. */
export function formatObservations(lines: ObservationLine[]): string {
  const body = lines.map((l) => `[${l.id}] ${l.tool} → ${l.ok ? '' : 'ERROR: '}${l.content}`).join('\n\n');
  return `Observations:\n\n${body}`;
}

/** The instruction block + tool catalog appended to the system prompt. */
export function renderToolInstructions(specs: ToolSpec[]): string {
  const catalog = specs
    .map((s) => {
      const ps = s.params
        .map((p) => `    - ${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`)
        .join('\n');
      return `- ${s.name}: ${s.description}${ps ? `\n${ps}` : ''}`;
    })
    .join('\n');

  return [
    'You can call tools to gather information before answering. To call tools,',
    'reply with ONLY a fenced code block tagged tool_use containing JSON:',
    '',
    '```tool_use',
    '{"calls":[{"id":"c1","tool":"read_file","params":{"path":"src/x.ts"}}]}',
    '```',
    '',
    'You may request several calls at once. After you receive the Observations,',
    'you may call more tools, or — once you have enough — answer the question',
    'normally in prose (do NOT emit a tool_use block when you are ready to answer).',
    'Prefer reading whole relevant files for counting/enumeration questions.',
    '',
    'Available tools:',
    catalog,
  ].join('\n');
}
