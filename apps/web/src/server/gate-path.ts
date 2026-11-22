/**
 * The path the default-deny gate decides on (M1.3 lead decision 7): the request path decoded and
 * normalised, so an encoded or dotted spelling of /api/v1/... can't slip past a prefix match that the
 * router would still route to the API. Decoding repeats until the path stops changing (a
 * double-encoded %252F is decoded too); a path that fails to decode, or never settles, is refused.
 */
const MAX_DECODE_ROUNDS = 5;

export function normalisePath(rawPathname: string): string | null {
  let path = rawPathname;
  let settled = false;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let next: string;
    try {
      next = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (next === path) {
      settled = true;
      break;
    }
    path = next;
  }
  if (!settled) return null;

  const kept: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") kept.pop();
    else kept.push(segment);
  }
  return `/${kept.join("/")}`.toLowerCase();
}
