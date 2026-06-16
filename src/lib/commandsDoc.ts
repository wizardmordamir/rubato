/**
 * Render the "Commands by example" cheatsheet from the command registry.
 *
 * The registry (src/commands.ts) is the single source of truth, so this doc is
 * generated on demand (served virtually by the docs route) rather than written
 * to disk — it can never drift from the actual commands/flags.
 */

import { COMMANDS, type CommandDef } from '../commands';

/** Markdown for one command: signature, description, args, flags, usage block. */
function renderCommand(c: CommandDef): string[] {
  const out: string[] = [];
  const argSig = (c.args ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
  out.push(`## \`${c.name}${argSig ? ` ${argSig}` : ''}\``);
  out.push('');
  out.push(c.description);
  out.push('');

  if (c.args?.length) {
    for (const a of c.args) {
      out.push(`- \`${a.name}\`${a.required ? '' : ' _(optional)_'} — ${a.description}`);
    }
    out.push('');
  }

  if (c.flags?.length) {
    out.push('**Flags**');
    out.push('');
    for (const f of c.flags) {
      const val = f.takesValue ? ` ${f.example ? `<${f.example}>` : '<value>'}` : '';
      out.push(`- \`${f.flag}${val}\` — ${f.description}`);
    }
    out.push('');
  }

  const examples = c.examples?.length ? c.examples : [{ args: '', note: undefined }];
  out.push('```sh');
  for (const ex of examples) {
    const inv = `${c.name}${ex.args ? ` ${ex.args}` : ''}`;
    out.push(ex.note ? `${inv}    # ${ex.note}` : inv);
  }
  out.push('```');
  out.push('');
  return out;
}

/** The full cheatsheet as a markdown string (defaults to the live registry). */
export function renderCommandsByExample(commands: CommandDef[] = COMMANDS): string {
  const lines: string[] = [
    '# Commands by example',
    '',
    'A scannable index of every rubato command — what it does, the flags it takes,',
    'and copy-paste usage. Generated live from the registry',
    "([src/commands.ts](src/commands.ts)), so it's always current; see",
    '[COMMANDS.md](COMMANDS.md) for the guided cheatsheet and [OVERVIEW.md](OVERVIEW.md)',
    'for the full tour. Run `rubato list` for the live list.',
    '',
  ];
  for (const c of commands) lines.push(...renderCommand(c));
  return lines.join('\n');
}
