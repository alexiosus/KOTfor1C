export interface ScenarioReferenceMatch {
    start: number;
    length: number;
}

const SCENARIO_STEP_KEYWORD_PATTERN = [
    'К\\s+тому\\s+же',
    'Допустим',
    'Given',
    'When',
    'Then',
    'And',
    'But',
    'Если',
    'Когда',
    'Тогда',
    'Но',
    'И',
    'If'
].join('|');

function escapeRegularExpression(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findScenarioReference(line: string, targetName: string): ScenarioReferenceMatch | null {
    if (!targetName) {
        return null;
    }

    const escapedTargetName = escapeRegularExpression(targetName);
    const referencePattern = new RegExp(
        `^(\\s*(?:\\*\\s*)?(?:${SCENARIO_STEP_KEYWORD_PATTERN})\\s+)(${escapedTargetName})\\s*$`,
        'iu'
    );
    const match = referencePattern.exec(line);
    if (!match) {
        return null;
    }

    return {
        start: match[1].length,
        length: match[2].length
    };
}
