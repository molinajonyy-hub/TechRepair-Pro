export function parseUnitQuantity(value: string | number): number {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (!isFinite(n)) return 0;
  return Math.round(n);
}

export function formatUnitQuantity(value: number): string {
  return String(Math.round(value));
}
