// `ti resolve export` renders a self-contained markdown prompt per chunk of
// unresolved units. The prompt is the SINGLE source of the output-format
// contract: `WORKED_EXAMPLE` below is a real `ResolutionsFile` value, so the
// type-checker and the drift test in `render-prompt.test.ts` guarantee the
// example shown to the LLM is exactly what `ti resolve import` parses.
import type { ResolveUnit, ResolutionsFile } from './types.js';
import type { ProjectRelativePath } from '../types.js';

// One resolution of each classification: a citation-bearing `structural-rule`
// and a citation-free `data-dependent-unresolvable`. This exercises BOTH arms
// of the `parseResolutionsFile` structural guard. Co-located with the schema
// prose in `HEADER` below — edit the two together.
export const WORKED_EXAMPLE: ResolutionsFile = {
  version: 1,
  pass: 'llm',
  resolutions: [
    {
      exprHash: 'EXAMPLE_HASH_A',
      classification: 'structural-rule',
      resolvedValue: { hookName: 'save_post' },
      citation: { path: 'src/inc.php' as ProjectRelativePath, line: 12 },
      note: 'hook name is the literal assigned to $hook two lines above the do_action call',
    },
    {
      exprHash: 'EXAMPLE_HASH_B',
      classification: 'data-dependent-unresolvable',
      note: 'hook name is built from a runtime request parameter; no static literal exists',
    },
  ],
};

export interface PromptMeta {
  readonly project: string;
  readonly chunkIndex: number; // 1-based
  readonly chunkCount: number;
}

// `.php` -> php fence; JS/TS family -> ts; anything else -> no language.
function fenceLang(filePath: string): string {
  if (filePath.endsWith('.php')) return 'php';
  if (/\.(tsx|ts|jsx|js|mjs|cjs)$/.test(filePath)) return 'ts';
  return '';
}

// Prefix each line of the context window with its absolute source line number.
function withGutter(text: string, startLine: number): string {
  const lines = text.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((ln, i) => `${String(startLine + i).padStart(width, ' ')} | ${ln}`)
    .join('\n');
}

function renderUnit(u: ResolveUnit): string {
  const lang = fenceLang(u.filePath);
  const body = withGutter(u.codeContext.text, u.codeContext.startLine);
  return [
    `## Unit ${u.exprHash}`,
    ``,
    `- kind: ${u.factKind}`,
    `- unresolved expression: \`${u.unresolvedExpression}\``,
    `- enclosing scope: ${u.enclosingScope}`,
    `- file: ${u.filePath} (lines ${String(u.codeContext.startLine)}-${String(u.codeContext.endLine)})`,
    ``,
    '```' + lang,
    body,
    '```',
  ].join('\n');
}

const HEADER = (m: PromptMeta): string => `# ti resolve — hook-name resolution task (batch ${String(m.chunkIndex)} of ${String(m.chunkCount)})

Project: ${m.project}

## Task

Each unit below is an unresolved WordPress hook expression (\`hook-fire\` or
\`hook-listener\`) — \`ti\` could not statically determine the hook name. For
every unit, read the inline code context and determine the real hook name: the
literal string that is passed to the WordPress hook API (\`do_action\`,
\`apply_filters\`, \`add_action\`, \`add_filter\`).

## Citation rule (mandatory)

Every resolved hook name MUST be backed by a citation: a real \`file:line\`
where that exact hook-name string literally appears in the source. The line
number is the ABSOLUTE source line shown in the gutter of the code block, not
an offset within the block.

\`ti resolve import\` re-reads the cited line and rejects any resolution whose
hook name is not found there. A resolution you cannot cite MUST be classified
\`data-dependent-unresolvable\` — never guess a hook name. A fabricated citation
is worse than an honest \`data-dependent-unresolvable\`.

## Classification (mandatory)

Classify every resolution as exactly one of:

- \`structural-rule\` — resolvable by a mechanical rule you can state (e.g. "the
  hook name is the literal assigned to the local variable two lines above").
- \`project-constant\` — resolvable from a project-specific constant whose value
  is visible in the code context.
- \`data-dependent-unresolvable\` — the hook name is computed from runtime data
  (a request parameter, a database value); no static literal exists.

## Output format

Return a SINGLE JSON document — a \`ResolutionsFile\` — and nothing else.

- \`version\`: always the integer \`1\`.
- \`pass\`: always the string \`"llm"\`.
- \`resolutions\`: an array; one entry per unit you resolved (you may omit a
  unit entirely if you cannot classify it, but prefer
  \`data-dependent-unresolvable\`).

Each resolution entry:

- \`exprHash\`: the unit's \`exprHash\`, copied verbatim.
- \`classification\`: one of the three values above.
- \`resolvedValue\`: \`{ "hookName": "<the resolved hook name>" }\` — REQUIRED
  for \`structural-rule\` and \`project-constant\`, and MUST be absent for
  \`data-dependent-unresolvable\`.
- \`citation\`: \`{ "path": "<project-relative file>", "line": <integer> }\` —
  REQUIRED for \`structural-rule\` and \`project-constant\`, and MUST be absent
  for \`data-dependent-unresolvable\`.
- \`note\`: optional free-text rationale.

### Worked example

\`\`\`json
${JSON.stringify(WORKED_EXAMPLE, null, 2)}
\`\`\`

## Units
`;

export function renderPrompt(
  units: readonly ResolveUnit[], meta: PromptMeta,
): string {
  const blocks = units.map(renderUnit).join('\n\n');
  return HEADER(meta) + '\n' + blocks + '\n';
}
