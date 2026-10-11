/**
 * What a command reads and writes besides files: its working folder and the two output streams
 * (`index.ts` passes the process's, the specs capture them). `env` is where `~/.pix3` and an SSH
 * session are looked up (default `process.env`).
 */
export interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env?: NodeJS.ProcessEnv;
}
