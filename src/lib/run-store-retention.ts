export function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();

  if (!rawValue || !/^[1-9]\d*$/.test(rawValue)) {
    return fallback;
  }

  return Number(rawValue);
}
