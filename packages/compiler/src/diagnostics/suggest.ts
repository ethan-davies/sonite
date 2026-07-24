/**
 * High-confidence "did you mean?" helpers.
 *
 * Suggestions are only emitted when a single best match is clearly better than
 * the rest (strict distance + uniqueness gate) to avoid noisy false positives.
 */

/** Levenshtein edit distance between two strings. */
export function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);

  for (let j = 0; j < cols; j += 1) {
    prev[j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j < cols; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j < cols; j += 1) {
      prev[j] = curr[j] ?? 0;
    }
  }

  return prev[b.length] ?? b.length;
}

/** Maximum allowed edit distance for a given input length. */
export function maxSuggestionDistance(inputLength: number): number {
  if (inputLength <= 2) {
    return 0;
  }
  if (inputLength <= 4) {
    return 1;
  }
  if (inputLength <= 8) {
    return 2;
  }
  return 3;
}

export interface SuggestOptions {
  /** Cap on candidates considered after filtering identical names. Default 64. */
  readonly maxCandidates?: number;
}

/**
 * Return a single high-confidence suggestion, or an empty list.
 *
 * Rules:
 * - Exact matches are ignored (caller already knows the name is wrong).
 * - Distance must be ≤ {@link maxSuggestionDistance}.
 * - The best match must beat the runner-up by at least 1 (no ties for best).
 * - Case-insensitive equality with distance 0 after lowercasing is preferred.
 */
export function suggestClosest(
  input: string,
  candidates: Iterable<string>,
  options: SuggestOptions = {},
): readonly string[] {
  const maxCandidates = options.maxCandidates ?? 64;
  const maxDist = maxSuggestionDistance(input.length);
  if (maxDist === 0 && input.length <= 2) {
    // Only accept exact case-insensitive matches for very short names.
    const lower = input.toLowerCase();
    for (const c of candidates) {
      if (c !== input && c.toLowerCase() === lower) {
        return [c];
      }
    }
    return [];
  }

  const seen = new Set<string>();
  const scored: { name: string; distance: number }[] = [];

  for (const candidate of candidates) {
    if (!candidate || candidate === input || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    let distance = editDistance(input, candidate);
    if (distance === 0) {
      continue;
    }
    // Prefer case-fold matches.
    if (input.toLowerCase() === candidate.toLowerCase()) {
      distance = 0;
    }
    if (distance > maxDist) {
      continue;
    }
    scored.push({ name: candidate, distance });
    if (scored.length >= maxCandidates * 4) {
      // Bound work on huge scopes; keep best so far via later sort/slice.
      break;
    }
  }

  if (scored.length === 0) {
    return [];
  }

  scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  const top = scored.slice(0, Math.min(maxCandidates, scored.length));
  const best = top[0]!;
  const second = top[1];

  // Case-fold exact: always suggest.
  if (best.distance === 0) {
    return [best.name];
  }

  // Require a unique best (strictly better than second).
  if (second && second.distance === best.distance) {
    return [];
  }

  return [best.name];
}

/** Format suggestion(s) for appending to a diagnostic message. */
export function formatDidYouMean(suggestions: readonly string[]): string {
  if (suggestions.length === 0) {
    return "";
  }
  if (suggestions.length === 1) {
    return `Did you mean '${suggestions[0]}'?`;
  }
  const listed = suggestions.map((s) => `'${s}'`).join(", ");
  return `Did you mean ${listed}?`;
}
