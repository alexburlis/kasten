// Marks the words a search matched, in text shown with the results. Words are compared the way
// the index compares them: Unicode word segments, without accents and case.
import { normaliseTerm } from "@kasten/core/search";

export interface Highlighted {
  readonly text: string;
  readonly match: boolean;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * Splits `text` into marked and unmarked parts. A word matches when it equals one of `terms`,
 * or starts with one of `prefixes` (the last word typed is searched as a prefix).
 */
export function highlight(
  text: string,
  terms: readonly string[],
  prefixes: readonly string[] = [],
): Highlighted[] {
  if (terms.length === 0 && prefixes.length === 0) return [{ text, match: false }];

  const exact = new Set(terms.map(normaliseTerm));

  const starts = prefixes.flatMap((prefix) => {
    const normalised = normaliseTerm(prefix);

    return normalised === "" ? [] : [normalised];
  });

  const out: Highlighted[] = [];

  for (const { segment, isWordLike } of segmenter.segment(text)) {
    const word = normaliseTerm(segment);

    const match =
      isWordLike === true && (exact.has(word) || starts.some((prefix) => word.startsWith(prefix)));

    const previous = out.at(-1);

    if (previous !== undefined && previous.match === match)
      out[out.length - 1] = { text: previous.text + segment, match };
    else out.push({ text: segment, match });
  }

  return out;
}
