// A budget config that is malformed, references an unknown metric, or budgets a metric this build
// cannot measure (browser-only) is a CONFIG error — distinct from an asset regression. The CLI maps
// it to exit code 2 (fail-closed). The optional `path` points at the offending config location.

export class ConfigError extends Error {
  readonly path?: string;
  constructor(message: string, path?: string) {
    super(message);
    this.name = 'ConfigError';
    this.path = path;
  }
}
