import { ScenarioYamlDocument } from './scenarioYamlDocument';

export interface ProcessStepsEditorAction {
    line: number;
    title: string;
    command: 'kotTestToolkit.addProcessSteps';
    documentUri: string;
}

export function buildProcessStepsEditorAction(
    source: string, documentUri: string, translate: (message: string) => string
): ProcessStepsEditorAction | undefined {
    try {
        const document = ScenarioYamlDocument.parse(source);
        document.requireValidForEdit();
        const uid = document.findField('ДанныеПроцесса', 'UID');
        if (!uid || uid.ambiguous || !String(uid.value ?? '').trim()) { return undefined; }
        const section = document.findSection('ШагиПроцесса') ?? document.findSection('ДанныеПроцесса');
        if (!section) { return undefined; }
        return {
            line: source.slice(0, section.pairRange.start).split(/\r\n|\r|\n/u).length - 1,
            title: translate('Add process steps'), command: 'kotTestToolkit.addProcessSteps', documentUri
        };
    } catch { return undefined; }
}
