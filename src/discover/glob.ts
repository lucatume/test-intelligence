// Tiny glob → RegExp compiler for project-relative POSIX paths.
// Supported: *, **, ?, [chars], {alt1,alt2}. No leading "/", no negation.
// Empty pattern matches nothing.

export function compileGlob(pattern: string): RegExp {
  if (pattern === '') return /(?!)/;
  let i = 0;
  let out = '^';
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        out += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
        i++;
      } else {
        out += '[' + pattern.slice(i + 1, end).replace(/\\/g, '\\\\') + ']';
        i = end + 1;
      }
    } else if (c === '{') {
      const end = pattern.indexOf('}', i + 1);
      if (end === -1) {
        out += '\\{';
        i++;
      } else {
        const alts = pattern.slice(i + 1, end).split(',').map(escapeLiteral);
        out += '(?:' + alts.join('|') + ')';
        i = end + 1;
      }
    } else {
      out += escapeLiteralChar(c);
      i++;
    }
  }
  out += '$';
  return new RegExp(out);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (compileGlob(p).test(path)) return true;
  }
  return false;
}

const REGEX_META_RE = /[.+^${}()|\\/]/;
const REGEX_META_G = /[.+^${}()|\\/]/g;

function escapeLiteralChar(c: string): string {
  return REGEX_META_RE.test(c) ? '\\' + c : c;
}

function escapeLiteral(s: string): string {
  return s.replace(REGEX_META_G, '\\$&');
}
