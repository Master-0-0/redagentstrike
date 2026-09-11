/** Next append-only ids: prefix + at least 3 digits (f001, i001, h001, then f1000…). */

export function nextNumericId(prefix: string, ids: Iterable<string>): string {
  let max = 0
  const re = new RegExp(`^${prefix}(\\d+)$`)
  for (const id of ids) {
    const match = re.exec(id)
    if (!match) continue
    const n = Number.parseInt(match[1], 10)
    if (n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}
