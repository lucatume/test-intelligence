# Handoff

Updated July 23, 2026.

## Current state

`main` is six commits ahead of `origin/main`:

```text
90e88d3 fix(rest): improve method and wildcard matching
1b7142f fix(derive): prefer specific REST wildcard routes
52c36b0 fix(derive): mark scoped hook listeners uncertain
7340937 fix: improve dependency edge accuracy
acdfcd6 feat: improve edge discovery and dependency queries
```

The implementation and regression are committed. The only working-tree item is this untracked `handoff.md`.

## Test repositories

Real-PR snapshots live under `_scratchpad/real-prs/`:

- WooCommerce: `pr-66695`, `pr-66700`, `pr-66701`, `pr-66706`, `pr-66710`
- WordPress: `pr-12551`, `pr-12552`, `pr-12553`, `pr-12555`, `pr-12556`
- wp-calypso: `pr-112632`, `pr-112650`, `pr-112654`, `pr-112687`, `pr-112692`
- This repository: Vitest, ESLint, typecheck, build, and `git diff --check`

Saved reproduction commands normally live at `results/<framework>/command.txt`.

Latest reviewed snapshots:

- WooCommerce `pr-66706`: six REST/AJAX-related PHP sources, exercised with PHPUnit, Jest, and Playwright
- WordPress `pr-12556`: seven REST/AJAX-related PHP sources, exercised with PHPUnit, QUnit, and Playwright
- WooCommerce `pr-66710`: one changed production PHP source, exercised with PHPUnit
- WordPress `pr-12555`: three changed REST controller sources, exercised with PHPUnit
- wp-calypso `pr-112687`: two production TypeScript modules targeted by the changed tests, exercised with Jest and Playwright

## Benchmark history

WordPress #12556 expanded graph:

| Stage | Workers | Peak RSS | Runtime | Tests | Edges | Evidence |
|---|---:|---:|---:|---:|---:|---:|
| Old baseline | auto | n/a | 22.847s | 12,339 | 144,152 | 147,421 |
| Expanded, PHP pool retained | 8 | 4.32 GiB | 118.979s | 13,247 | 419,587 | 458,429 |
| Worker comparison | 4 | 2.71 GiB | 172.398s | 13,247 | 419,587 | 458,429 |
| Worker comparison | 2 | 1.96 GiB | 188.155s | 13,247 | 419,587 | 458,429 |
| OOM fix | 2 | 1.69 GiB | 102.392s | 13,247 | 419,587 | 458,429 |
| Previous spot-check graph | config default | n/a | 92.694s | 13,280 | 387,655 | 431,783 |
| Callable-scoped hook fix replay | config default | n/a | 102.554s | 13,280 | 387,655 | 422,040 |

Post-fix WordPress serial runtimes:

- #12551 PHPUnit: 100.425s
- #12552 PHPUnit: 103.010s
- #12553 PHPUnit: 99.025s
- #12555 PHPUnit: 99.719s
- #12556 PHPUnit: 102.392s
- Historical five-source QUnit: 100.372s
- Previous QUnit replay: 99.242s, 3,606 files, 195,263 facts, 13,280 tests, 409,998 edges, 454,509 evidence
- Latest combined PHPUnit/QUnit spot-check graph: 92.694s, 3,606 files, 195,264 facts, 13,280 tests, 387,655 edges, 431,783 evidence

Latest WooCommerce #66706 combined PHPUnit/Playwright graph:

- Runtime: 20.074s
- Files: 9,645
- Facts: 243,930
- Tests: 12,504
- Edges: 146,451
- Evidence: 178,585

Latest Calypso #112692 Jest graph:

- Runtime: 27.154s
- Files: 17,356
- Facts: 216,597
- Tests: 20,450
- Edges: 197,234
- Evidence: 293,767

Latest cold-build spot-check wave:

- WooCommerce #66710 PHPUnit: 19.22s, 9,648 files, 244,026 facts, 12,509 tests, 146,483 edges, 178,619 evidence
- WordPress #12555 PHPUnit after the REST specificity fix: 98.49s, 3,606 files, 195,256 facts, 13,279 tests, 386,064 edges, 420,219 evidence
- Calypso #112687 Jest: 27.11s, 17,378 files, 216,815 facts, 20,466 tests, 197,247 edges, 293,781 evidence
- Calypso #112687 Playwright: 25.54s with the same graph totals

Latest REST/AJAX fix replays:

| Repository | Runtime | Files | Facts | Tests | Edges | Evidence |
|---|---:|---:|---:|---:|---:|---:|
| WooCommerce #66706 | 19.444s | 9,645 | 243,927 | 12,504 | 145,973 | 178,135 |
| WordPress #12556 | 100.164s | 3,606 | 195,260 | 13,280 | 387,192 | 421,677 |

The latest WooCommerce serial queries completed in 19.41s for PHPUnit, 19.20s for Jest, and 19.50s for Playwright. The redundant WordPress serial replay was stopped after the complete in-memory probe because each framework query rebuilds the same roughly 100-second graph.

## Work completed this session

- Committed the REST method and compatible-wildcard fixes as `90e88d3 fix(rest): improve method and wildcard matching`.
- JavaScript `apiFetch` calls now use a literal configured HTTP method instead of retaining the pattern's default `GET`.
- REST traversal now matches compatible wildcard shapes when constructor-derived endpoints lose namespace/base precision.
- WordPress `HEAD` and `OPTIONS` requests fall back to readable REST endpoints when no exact-method endpoint exists.
- WooCommerce #66706 replay: `Notes.php` now returns five Jest edges through the POST promo route; the other reviewed counts remain orders 9 PHPUnit, order actions 10 PHPUnit, and submission handler 22 PHPUnit.
- WordPress #12556 replay: application passwords 20 PHPUnit edges, autosaves 37, search 10, image header 8, Customize Manager 5,239, and Customize Nav Menus 164. Custom background, QUnit, and Playwright remain zero.
- The redundant serial WordPress CLI replay was stopped after the full in-memory repository probe completed. WooCommerce serial PHPUnit/Jest/Playwright queries completed.
- Rebuilt and verified under Node 22.18.0: 106 Vitest files and 888 tests, ESLint, typecheck, build, and `git diff --check`.
- Confirmed the WooCommerce and WordPress snapshot statuses were identical before and after every completed probe/query.

Extraction and traversal fixes:

- Transitive lazy TypeScript imports no longer act eager.
- PHP includes no longer execute unrelated callable bodies.
- Inherited REST endpoints are materialized on routing-property overrides.
- Subclasses that call `parent::register_routes()` and add their own endpoints now retain inherited routes.
- Nested WordPress REST definitions emit all methods represented by `READABLE`, `CREATABLE`, `EDITABLE`, `DELETABLE`, and `ALLMETHODS`.
- Dynamic REST routes prefer the identical wildcard shape over literal siblings such as `/orders/batch`.
- Literal REST calls prefer the most specific matching wildcard route, so `/abilities/{*}/run` wins over `/abilities/{*}`.
- JavaScript sibling test bodies and describe-local hooks no longer leak between tests.
- `test.describe`, hooks, and steps are no longer classified as tests.
- File-wide `wp.*` symbol-use deduplication no longer drops scoped QUnit edges.
- Unresolved hook patterns with no known alphanumeric name fragment, such as `{*}_{*}`, no longer bind every literal hook listener.

Targeted real-repository spot checks reviewed all requested candidates:

- WooCommerce #66706: five sources across PHPUnit and Playwright.
  - The V3 products controller initially returned zero Playwright tests despite direct `wc/v3/products` calls.
  - The resolver fix restored 111 Playwright edges across seven relevant test files.
  - Coupons: 52 PHPUnit, 28 Playwright.
  - Customers: 38 PHPUnit, 34 Playwright.
  - Products: 115 PHPUnit, 111 Playwright.
  - `class-wc-ajax.php`: 4 PHPUnit.
  - `class-wc-admin-assets.php`: 11 PHPUnit.
- WordPress #12556: eight sources across PHPUnit and QUnit.
  - `admin-ajax.php` initially fanned out to 3,746 unrelated PHPUnit tests through unresolved `{*}` and `{*}_{*}` hooks.
  - The traversal fix removed the entire false-positive fan-out.
  - `script-loader.php`: 511 PHPUnit.
  - Comments controller: 805 PHPUnit.
  - Users controller: 139 PHPUnit.
  - Posts controller: 1,636 PHPUnit.
  - The three wp-admin entry files and `admin-ajax.php` correctly returned no edges for these frameworks.
- Calypso #112692: six login sources across Jest.
  - Counts: 24, 9, 25, 29, 7, and 11.
  - All sources were known, all edges were non-partial, direct nearby tests were present, and broader controller edges were explained by file-level imports.
- WooCommerce #66710: one PHP source across PHPUnit.
  - `LegacySelect2UsageTracker.php`: 10 direct tests, no partial or unknown edges.
- WordPress #12555: three REST controller sources across PHPUnit.
  - Categories: 21 tests.
  - List: 38 tests.
  - Run: 45 tests.
  - Three validation edges are partial; no path or test ID is unknown.
- Calypso #112687: two production TypeScript sources across Jest and Playwright.
  - Jest: 13 direct tests.
  - Playwright: zero, as expected for these low-level modules.
  - No partial or unknown edges.

Final evidence:

- `/private/tmp/ti-spotcheck-woocommerce-final.json`
- `/private/tmp/ti-spotcheck-woocommerce-final.stderr`
- `/private/tmp/ti-spotcheck-wordpress-final.json`
- `/private/tmp/ti-spotcheck-wordpress-final.stderr`
- `/private/tmp/ti-spotcheck-calypso-final.json`
- `/private/tmp/ti-spotcheck-calypso-final.stderr`
- `/private/tmp/ti-spotcheck-final-counts.tsv`
- `/private/tmp/ti-cold-66710-phpunit.json`
- `/private/tmp/ti-cold-66710-phpunit.stderr`
- `/private/tmp/ti-cold-12555-phpunit-fixed.json`
- `/private/tmp/ti-cold-12555-phpunit-fixed.stderr`
- `/private/tmp/ti-cold-12555-evidence.json`
- `/private/tmp/ti-wp-evidence-store/.ti/store.db`
- `/private/tmp/ti-cold-112687-jest.json`
- `/private/tmp/ti-cold-112687-jest.stderr`
- `/private/tmp/ti-cold-112687-playwright.json`
- `/private/tmp/ti-cold-112687-playwright.stderr`

Final verification under Node 22.18.0 passed:

- Vitest: 106 files, 883 tests
- ESLint
- Typecheck
- Build
- `git diff --check`
- Final real-repository replays for WooCommerce, WordPress, and Calypso

Current committed change verification under Node 22.18.0 passed:

- Vitest: 106 files, 888 tests
- ESLint
- Typecheck
- Build
- `git diff --check`
- WooCommerce #66706 and WordPress #12556 full in-memory real-repository probes

No snapshot repository was modified.

## What to do next

Use this order:

1. If a spot check or verification exposes incorrect edges, unknown paths, unexplained fan-out, sibling leakage, or missing nearby tests, stop and fix the issue first. Add one focused failing regression, trace the shared extraction or traversal cause, implement the fix, rebuild, and replay the affected repository.
2. If runtime, peak RSS, edge count, or evidence count regresses materially against the benchmark history, stop accuracy expansion and work on performance. Preserve edge/evidence correctness while profiling extraction, index construction, traversal, and writes.
3. Otherwise, continue spot-testing production files and inspect whether every produced edge is correct.

For the next spot-test wave, focus on PHP production sources that:

- register REST API routes through `register_rest_route()`
- handle `wp_ajax_*` or `wp_ajax_nopriv_*` actions

Prefer untouched changed files from the existing WooCommerce and WordPress snapshots. Include every configured framework that can reasonably exercise each source, especially PHPUnit plus Playwright or QUnit where a JavaScript caller exists.

For every candidate, inspect exact returned tests, evidence, provenance, unknown paths or test IDs, nearby-test coverage, sibling leakage, partial matches, and unexplained fan-out.
