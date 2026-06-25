// Input errors (bad/empty/unreadable dir, no parseable assets) → CLI exit code 3. Distinct from
// ConfigError (exit 2) and unexpected internal failures (exit 4), so a green check provably means
// measured-and-within-budget rather than "the tool fell over".

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}
