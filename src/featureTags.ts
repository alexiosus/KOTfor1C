/** Vanessa / Gherkin tags may contain punctuation, but never whitespace or another @. */
export function normalizeFeatureTags(values: readonly string[]): string[] {
    const tags = values.map(value => value.replace(/^@/u, ''));
    for (const tag of tags) {
        if (!tag || /[\s@\u0000-\u001F\u007F]/u.test(tag)) {
            throw new Error('Invalid feature tag. Use a single tag without whitespace.');
        }
    }
    return [...new Set(tags)];
}
