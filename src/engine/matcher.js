/**
 * Normalize a keyword or search term:
 * - lowercase
 * - strip special characters (keep letters, numbers, spaces, &)
 * - collapse multiple spaces
 * - trim
 */
function normalize(text) {
  return text
    .toString()
    .toLowerCase()
    .replace(/[^\w\s\d&]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

/**
 * Check if any keyword is contained as a whole phrase within the search term.
 * Pads with spaces to ensure whole-word matching.
 *
 * Direct port of isKeywordInsideSearchTerm() from the original Google Ads script.
 *
 * @param {string} searchTerm - The normalized search query
 * @param {string[]} keywords - Array of normalized keywords, sorted longest-first
 * @returns {{ matched: boolean, keyword: string|null }}
 */
function isKeywordInsideSearchTerm(searchTerm, keywords) {
  const padded = ' ' + searchTerm + ' ';
  for (const keyword of keywords) {
    if (padded.includes(' ' + keyword + ' ')) {
      return { matched: true, keyword };
    }
  }
  return { matched: false, keyword: null };
}

/**
 * Check if a search term contains any general negative keyword.
 *
 * @param {string} searchTerm - The normalized search query
 * @param {string[]} negatives - Array of normalized negative keywords
 * @returns {{ matched: boolean, keyword: string|null }}
 */
function containsGeneralNegative(searchTerm, negatives) {
  const padded = ' ' + searchTerm + ' ';
  for (const neg of negatives) {
    if (padded.includes(' ' + neg + ' ')) {
      return { matched: true, keyword: neg };
    }
  }
  return { matched: false, keyword: null };
}

/**
 * Sort keywords by length descending (longest first).
 * Longer keywords are checked first for more specific matching.
 */
function sortKeywordsByLength(keywords) {
  return [...keywords].sort((a, b) => b.length - a.length);
}

module.exports = {
  normalize,
  isKeywordInsideSearchTerm,
  containsGeneralNegative,
  sortKeywordsByLength,
};
