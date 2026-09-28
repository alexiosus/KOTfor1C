import { parse } from 'node-html-parser';
import {
    BuiltInStepDefinition,
    createStepDefinitionId,
    normalizeStepCatalogText,
    StepTextVariant
} from './stepCatalog';

function createVariant(pattern: string, description: string): StepTextVariant | undefined {
    const normalizedPattern = normalizeStepCatalogText(pattern);
    if (!normalizedPattern) {
        return undefined;
    }
    return {
        pattern: normalizedPattern,
        description: normalizeStepCatalogText(description)
    };
}

export function parseLegacyStepsHtml(html: string): readonly BuiltInStepDefinition[] {
    if (!html.trim()) {
        throw new Error('Legacy steps HTML does not contain valid step rows.');
    }

    const root = parse(html);
    const steps: BuiltInStepDefinition[] = [];
    for (const row of root.querySelectorAll('tr')) {
        if (!row.classNames?.startsWith('R')) {
            continue;
        }

        const cells = row.querySelectorAll('td');
        if (cells.length < 4) {
            continue;
        }

        const ru = createVariant(cells[0].textContent, cells[1].textContent);
        const en = createVariant(cells[2].textContent, cells[3].textContent);
        if (!ru && !en) {
            continue;
        }

        steps.push({
            id: createStepDefinitionId(ru?.pattern, en?.pattern),
            ru,
            en
        });
    }

    if (steps.length === 0) {
        throw new Error('Legacy steps HTML does not contain valid step rows.');
    }
    return steps;
}
