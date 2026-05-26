import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnchorKey } from '../../types.js';

// PHP-side anchor emission for the canonical WordPress entry-point files
// catalogued by the JS-side `wp-frontend-or-admin-url` transform (plan 05).
//
// The JS bridge produces facts whose anchor key is `wp-admin-page:<file>` or
// `wp-frontend:<key>`. For an edge to form, a PHP-side fact must carry the
// same anchor on the subject side. Core wp-admin pages (edit.php, plugins.php
// etc.) and the front-end entry points (wp-login.php, index.php) are NOT
// registered via add_menu_page — they ARE the files — so the static extractor
// never emits anchors for them. This bootstrap fills the gap by probing the
// project root for the canonical files and emitting one synthetic
// `admin-page-register` fact per discovered file. The fn is tagged
// 'core-bootstrap' to make these facts grep-able and distinguishable from
// real add_menu_page-derived facts.

export interface CoreAnchorRef { readonly key: AnchorKey; readonly role: 'subject' | 'target' | 'callback' | 'module'; }

export interface CoreAnchorFactInsert {
  readonly kind: 'admin-page-register';
  readonly resolved: true;
  readonly relativePath: string;
  readonly startLine: 1;
  readonly endLine: 1;
  readonly anchors: readonly CoreAnchorRef[];
  readonly payload: { readonly kind: 'admin-page-register'; readonly slug: string; readonly fn: 'core-bootstrap' };
}

interface CatalogueEntry { readonly probe: readonly string[]; readonly anchorKey: string; readonly slug: string; }

const CATALOGUE: readonly CatalogueEntry[] = [
  { probe: ['src/wp-admin/index.php',    'wp-admin/index.php'],    anchorKey: 'wp-admin-page:index.php',    slug: 'index.php' },
  { probe: ['src/wp-admin/edit.php',     'wp-admin/edit.php'],     anchorKey: 'wp-admin-page:edit.php',     slug: 'edit.php' },
  { probe: ['src/wp-admin/edit-tags.php', 'wp-admin/edit-tags.php'], anchorKey: 'wp-admin-page:edit-tags.php', slug: 'edit-tags.php' },
  { probe: ['src/wp-admin/post.php',     'wp-admin/post.php'],     anchorKey: 'wp-admin-page:post.php',     slug: 'post.php' },
  { probe: ['src/wp-admin/post-new.php', 'wp-admin/post-new.php'], anchorKey: 'wp-admin-page:post-new.php', slug: 'post-new.php' },
  { probe: ['src/wp-admin/upload.php',   'wp-admin/upload.php'],   anchorKey: 'wp-admin-page:upload.php',   slug: 'upload.php' },
  { probe: ['src/wp-admin/themes.php',   'wp-admin/themes.php'],   anchorKey: 'wp-admin-page:themes.php',   slug: 'themes.php' },
  { probe: ['src/wp-admin/plugins.php',  'wp-admin/plugins.php'],  anchorKey: 'wp-admin-page:plugins.php',  slug: 'plugins.php' },
  { probe: ['src/wp-admin/users.php',    'wp-admin/users.php'],    anchorKey: 'wp-admin-page:users.php',    slug: 'users.php' },
  { probe: ['src/wp-admin/user-new.php', 'wp-admin/user-new.php'], anchorKey: 'wp-admin-page:user-new.php', slug: 'user-new.php' },
  { probe: ['src/wp-admin/profile.php',  'wp-admin/profile.php'],  anchorKey: 'wp-admin-page:profile.php',  slug: 'profile.php' },
  { probe: ['src/wp-admin/tools.php',    'wp-admin/tools.php'],    anchorKey: 'wp-admin-page:tools.php',    slug: 'tools.php' },
  { probe: ['src/wp-admin/options-general.php',    'wp-admin/options-general.php'],    anchorKey: 'wp-admin-page:options-general.php',    slug: 'options-general.php' },
  { probe: ['src/wp-admin/options-writing.php',    'wp-admin/options-writing.php'],    anchorKey: 'wp-admin-page:options-writing.php',    slug: 'options-writing.php' },
  { probe: ['src/wp-admin/options-reading.php',    'wp-admin/options-reading.php'],    anchorKey: 'wp-admin-page:options-reading.php',    slug: 'options-reading.php' },
  { probe: ['src/wp-admin/options-discussion.php', 'wp-admin/options-discussion.php'], anchorKey: 'wp-admin-page:options-discussion.php', slug: 'options-discussion.php' },
  { probe: ['src/wp-admin/options-media.php',      'wp-admin/options-media.php'],      anchorKey: 'wp-admin-page:options-media.php',      slug: 'options-media.php' },
  { probe: ['src/wp-admin/options-permalink.php',  'wp-admin/options-permalink.php'],  anchorKey: 'wp-admin-page:options-permalink.php',  slug: 'options-permalink.php' },
  { probe: ['src/wp-login.php',          'wp-login.php'],          anchorKey: 'wp-frontend:login',          slug: 'wp-login.php' },
  { probe: ['src/index.php',             'index.php'],             anchorKey: 'wp-frontend:home',           slug: 'index.php' },
];

async function fileExists(p: string): Promise<boolean> {
  try { const s = await stat(p); return s.isFile(); } catch { return false; }
}

export async function emitCoreAdminEntryPointFacts(opts: { projectRoot: string }): Promise<readonly CoreAnchorFactInsert[]> {
  const out: CoreAnchorFactInsert[] = [];
  for (const entry of CATALOGUE) {
    let foundPath: string | null = null;
    for (const rel of entry.probe) {
      const abs = join(opts.projectRoot, rel);
      if (await fileExists(abs)) { foundPath = rel; break; }
    }
    if (foundPath === null) continue;
    out.push({
      kind: 'admin-page-register',
      resolved: true,
      relativePath: foundPath,
      startLine: 1,
      endLine: 1,
      anchors: [{ key: entry.anchorKey as AnchorKey, role: 'subject' }],
      payload: { kind: 'admin-page-register', slug: entry.slug, fn: 'core-bootstrap' },
    });
  }
  return out;
}
