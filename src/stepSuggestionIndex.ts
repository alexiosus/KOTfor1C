import { calculateLevenshteinSimilarity } from './stringSimilarity';

export interface StepSuggestionSource {
    firstLine: string;
    russianFirstLine?: string;
}

export interface StepSuggestionIndexOptions {
    minSimilarity?: number;
    yieldEvery?: number;
    yieldControl?: () => Promise<void>;
    cacheSize?: number;
}

interface PreparedStepSuggestion {
    text: string;
    normalized: string;
}

interface RankedStepSuggestion extends PreparedStepSuggestion {
    score: number;
}

const GHERKIN_KEYWORDS = /^(?:\*\s*)?(?:And|But|Then|When|Given|If|Но|Тогда|Когда|Если|И|К тому же|Допустим)\s+/i;

export function normalizeStepSuggestionText(text: string): string {
    return text
        .trim()
        .replace(GHERKIN_KEYWORDS, '')
        .replace(/"%\d+\s+[^"]*"/g, ' ')
        .replace(/"[^"]*"/g, ' ')
        .replace(/'[^']*'/g, ' ')
        .replace(/\[[^\]]+\]/g, ' ')
        .replace(/[.,;:!?()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function defaultYieldControl(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

export class StepSuggestionIndex {
    private readonly candidates: readonly PreparedStepSuggestion[];
    private readonly minSimilarity: number;
    private readonly yieldEvery: number;
    private readonly yieldControl: () => Promise<void>;
    private readonly cacheSize: number;
    private readonly cache = new Map<string, readonly string[]>();

    constructor(
        sources: readonly StepSuggestionSource[],
        options: StepSuggestionIndexOptions = {}
    ) {
        const candidatesByText = new Map<string, PreparedStepSuggestion>();
        for (const source of sources) {
            for (const text of [source.firstLine, source.russianFirstLine]) {
                if (!text || candidatesByText.has(text)) {
                    continue;
                }
                const normalized = normalizeStepSuggestionText(text);
                if (!normalized) {
                    continue;
                }
                candidatesByText.set(text, {
                    text,
                    normalized
                });
            }
        }

        this.candidates = Array.from(candidatesByText.values());
        this.minSimilarity = options.minSimilarity ?? 0.25;
        this.yieldEvery = Math.max(1, Math.floor(options.yieldEvery ?? 64));
        this.yieldControl = options.yieldControl ?? defaultYieldControl;
        this.cacheSize = Math.max(1, Math.floor(options.cacheSize ?? 128));
    }

    async getSuggestions(
        lineText: string,
        maxSuggestions: number = 3,
        shouldCancel: () => boolean = () => false
    ): Promise<string[]> {
        const normalizedInput = normalizeStepSuggestionText(lineText);
        if (!normalizedInput || shouldCancel()) {
            return [];
        }

        const limit = Math.max(1, Math.floor(maxSuggestions));
        const cacheKey = `${limit}\u0000${normalizedInput}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            this.cache.delete(cacheKey);
            this.cache.set(cacheKey, cached);
            return Array.from(cached);
        }

        const ranked: RankedStepSuggestion[] = [];
        for (let index = 0; index < this.candidates.length; index += 1) {
            if (shouldCancel()) {
                return [];
            }

            const candidate = this.candidates[index];
            const score = calculateLevenshteinSimilarity(normalizedInput, candidate.normalized);
            if (score >= this.minSimilarity) {
                const rankedCandidate = { ...candidate, score };
                const insertionIndex = ranked.findIndex(existing => score > existing.score);
                if (insertionIndex >= 0) {
                    ranked.splice(insertionIndex, 0, rankedCandidate);
                } else if (ranked.length < limit) {
                    ranked.push(rankedCandidate);
                }
                if (ranked.length > limit) {
                    ranked.pop();
                }
            }

            const processedCount = index + 1;
            if (processedCount < this.candidates.length && processedCount % this.yieldEvery === 0) {
                await this.yieldControl();
                if (shouldCancel()) {
                    return [];
                }
            }
        }

        const result = ranked.map(candidate => candidate.text);
        this.cache.set(cacheKey, result);
        if (this.cache.size > this.cacheSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) {
                this.cache.delete(oldestKey);
            }
        }
        return Array.from(result);
    }
}
