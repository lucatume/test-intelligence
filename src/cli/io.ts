export interface Io {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
  readStdin(): Promise<string>;    // returns entire stdin as a single string
  readonly stdinIsTty: boolean;
}
