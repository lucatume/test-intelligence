import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { extractTsFile } from './extract.js';
import { CompilerOptionsResolver } from './compiler.js';
import type { Fact } from '../../facts/types.js';
import type { FrameworkName, Language } from '../../types.js';
import type { UserPattern } from '../declarative/pattern.js';

interface WorkerInit {
  readonly projectRoot: string;
}

interface ExtractRequest {
  readonly id: number;
  readonly relPath: string;
  readonly language: Language;
  readonly framework: FrameworkName | null;
  readonly source: string;
  readonly patterns: readonly UserPattern[];
}

interface ExtractOk {
  readonly id: number;
  readonly facts: Fact[];
}

interface ExtractErr {
  readonly id: number;
  readonly error: string;
}

if (!parentPort) throw new Error('worker requires parentPort');
const port = parentPort;

const init = workerData as WorkerInit;
// Each worker owns its own resolver. The tsconfig walk-up cache duplicates
// I/O across N workers, but structured-cloning the cache per request would
// cost more than the re-read.
const resolver = new CompilerOptionsResolver(init.projectRoot);

port.on('message', (req: ExtractRequest) => {
  void (async () => {
    try {
      const compilerOptions = resolver.forFile(join(init.projectRoot, req.relPath));
      const facts = await extractTsFile({
        projectRoot: init.projectRoot,
        relPath: req.relPath,
        language: req.language,
        framework: req.framework,
        compilerOptions,
        patterns: req.patterns,
        source: req.source,
      });
      const resp: ExtractOk = { id: req.id, facts };
      port.postMessage(resp);
    } catch (e) {
      const resp: ExtractErr = {
        id: req.id,
        error: e instanceof Error ? e.message : String(e),
      };
      port.postMessage(resp);
    }
  })();
});
