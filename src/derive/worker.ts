import { parentPort, workerData } from 'node:worker_threads';
import { traverseTest } from './traverse.js';
import type { TraversalResult } from './traverse.js';
import type { Graph } from './types.js';
import type { AnchorIndex } from './anchor-index.js';
import { systemClock } from '../clock.js';

interface WorkerInit {
  readonly graph: Graph;
  readonly index: AnchorIndex;
  readonly params: {
    readonly maxDepth: number;
    readonly maxMillisPerTest: number;
    readonly threshold: number;
    readonly hookStopList: readonly string[];
    readonly maxWildcardMatchesPerAnchor: number;
  };
}

interface DeriveRequest {
  readonly id: number;
  readonly testFactId: number;
  readonly testId: string;
  readonly frameworkClass: 'unit' | 'e2e';
}

interface DeriveResponse {
  readonly id: number;
  readonly result: TraversalResult;
}

if (!parentPort) throw new Error('worker requires parentPort');
const port = parentPort;

const init = workerData as WorkerInit;
const stopList = new Set<string>(init.params.hookStopList);

port.on('message', (req: DeriveRequest) => {
  const result = traverseTest(
    init.graph,
    init.index,
    req.testFactId,
    req.testId,
    req.frameworkClass,
    {
      maxDepth: init.params.maxDepth,
      maxMillisPerTest: init.params.maxMillisPerTest,
      threshold: init.params.threshold,
      hookStopList: stopList,
      now: () => systemClock.nowMillis(),
      maxWildcardMatchesPerAnchor: init.params.maxWildcardMatchesPerAnchor,
    },
  );
  const resp: DeriveResponse = { id: req.id, result };
  port.postMessage(resp);
});
