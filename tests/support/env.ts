/** Helpers to read the injected dev dependency environment. Values are never printed. */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

export function hostToHttpsBase(host: string): string {
  const withoutScheme = host.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  return `https://${withoutScheme.replace(/:443$/, '')}`;
}

/** Credential values from the environment, used only to scan artifacts for leaks. */
export function knownSecretValues(): { name: string; value: string }[] {
  return Object.keys(process.env)
    .filter((name) => /^AIDH_DEP_.*_KEY$/.test(name))
    .map((name) => ({ name, value: process.env[name]?.trim() ?? '' }))
    .filter((entry) => entry.value.length >= 8);
}
