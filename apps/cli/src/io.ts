// IO seam: commands take an IO object and RETURN an exit code (never call process.exit), so unit
// tests drive them with a fake IO and assert codes + captured output. cli.ts wires the real IO.

export interface IO {
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
  color: boolean;
}

export function realIO(): IO {
  const noColor = process.env.NO_COLOR != null || process.env.FORCE_COLOR === '0';
  return {
    cwd: process.cwd(),
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    color: Boolean(process.stdout.isTTY) && !noColor,
  };
}
