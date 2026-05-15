import type { ChildProcessWithoutNullStreams } from 'node:child_process';

interface Pending {
  resolve: (msg: unknown) => void;
  reject: (e: Error) => void;
}

export class Protocol {
  private buffer = '';
  private queue: Pending[] = [];
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { this.onData(chunk); });
    child.on('exit', () => { this.handleClose(new Error('worker exited')); });
    child.on('error', (e: Error) => { this.handleClose(e); });
    // A half-closed worker pipe surfaces EPIPE as an async 'error' event on
    // stdin, which a try/catch around write() cannot catch. An attached
    // listener turns it into a handled event; worker liveness is tracked via
    // the child 'exit'/'error' handlers above.
    child.stdin.on('error', () => { /* dead pipe — handled via child exit */ });
  }

  request(msg: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('worker closed'));
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      if (!this.child.stdin.writable || this.child.stdin.destroyed) {
        const pending = this.queue.pop();
        if (pending) pending.reject(new Error('worker stdin closed'));
        return;
      }
      try {
        this.child.stdin.write(JSON.stringify(msg) + '\n');
      } catch (e) {
        const pending = this.queue.pop();
        if (pending) pending.reject(e as Error);
      }
    });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    // Worker pipe already gone — nothing to tell it, and waiting on 'exit'
    // would hang since the process is already dead.
    if (!this.child.stdin.writable || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n');
    } catch {
      // worker may already be gone
    }
    await new Promise<void>((r) => {
      if (this.closed) { r(); return; }
      this.child.once('exit', () => { r(); });
    });
  }

  private handleClose(e: Error): void {
    this.closed = true;
    while (this.queue.length > 0) {
      const p = this.queue.shift();
      if (p) p.reject(e);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line !== '') this.handleLine(line);
      nl = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    const pending = this.queue.shift();
    if (!pending) return;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'op' in parsed &&
      parsed.op === 'error'
    ) {
      const m = (parsed as { message?: unknown }).message;
      const msg = typeof m === 'string' ? m : 'unknown protocol error';
      pending.reject(new Error(msg));
    } else {
      pending.resolve(parsed);
    }
  }
}
