const SENSITIVE_VALUE_FLAGS = new Set([
    '/p',
    '--password',
    '--api-key',
    '--apikey',
    '--token'
]);

function redactProcessArguments(args: readonly string[]): string[] {
    let redactNext = false;
    return args.map(argument => {
        if (redactNext) {
            redactNext = false;
            return '***';
        }

        const normalized = argument.toLowerCase();
        if (SENSITIVE_VALUE_FLAGS.has(normalized)) {
            redactNext = true;
            return argument;
        }

        const inlineSecret = /^(\/p|--password|--api-key|--apikey|--token)=/i.exec(argument);
        return inlineSecret ? `${inlineSecret[1]}=***` : argument;
    });
}

function quoteForDisplay(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
}

export function formatProcessCommandForDisplay(
    executable: string,
    args: readonly string[]
): string {
    return [executable, ...redactProcessArguments(args)]
        .map(quoteForDisplay)
        .join(' ');
}
