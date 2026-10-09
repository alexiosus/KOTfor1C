export interface GherkinSyntaxError {
    readonly message: string;
    readonly line: number;
    readonly column: number;
}

export function collectGherkinSyntaxErrors(source: string): readonly GherkinSyntaxError[];
