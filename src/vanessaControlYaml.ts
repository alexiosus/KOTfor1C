import * as path from 'node:path';
import { getCompilerScenarioBody, scanCompilerLines } from './scenarioCompilerSyntax';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';
import { collectGherkinSyntaxErrors } from './gherkinSyntaxValidator';
import { mapYamlLineToFeatures, mapFeatureLineToYaml, type CompilerControlFeatureLocation, type CompilerControlMappingContext } from './vanessaControlSourceMapping';
import type { VanessaFeatureDocument } from './vanessaControlFeature';

export interface VanessaYamlBuild extends CompilerControlMappingContext { readonly outputRoot: string }
export class VanessaYamlBuildRequiredError extends Error {}
export type VanessaYamlControlMode = 'oneStep' | 'runFromLine' | 'toggleBreakpoint';
export interface VanessaYamlTarget {
    readonly location: CompilerControlFeatureLocation;
    readonly filePath: string;
    readonly featureText: string;
    readonly source: VanessaFeatureDocument;
    readonly build: VanessaYamlBuild;
    readonly breakpointDesired?: boolean;
}
export interface VanessaYamlControlPorts {
    current(): VanessaFeatureDocument | undefined;
    save(): Promise<boolean>;
    readText(filePath: string): Promise<string>;
    loadBuild(): Promise<VanessaYamlBuild | undefined>;
    choose(locations: readonly CompilerControlFeatureLocation[]): Promise<CompilerControlFeatureLocation | undefined>;
    perform(mode: VanessaYamlControlMode, target: VanessaYamlTarget): Promise<{ readonly passed: boolean; readonly nextLineNumber?: number }>;
    selectLine?(lineIndex: number): void;
}

/** A syntactic context check only. Execution still requires a current exact compiler map. */
export function isExecutableYamlControlLine(source: VanessaFeatureDocument): boolean {
    if (!source.uri.startsWith('file:') || !/\.yaml$/iu.test(source.uri) || !Number.isSafeInteger(source.line)) { return false; }
    const body = getCompilerScenarioBody(source.text);
    const index = body ? source.line - body.startLine : -1;
    return !!body && index >= 0 && index < body.lines.length && !!body.lines[index].trim() && scanCompilerLines(body.lines)[index].kind === 'code';
}

const sameLocation = (a: CompilerControlFeatureLocation, b: CompilerControlFeatureLocation) => a.worker === b.worker && a.feature === b.feature && a.lineNumber === b.lineNumber;

/** No queue and no approximate source line: repeated calls and variants require an explicit choice. */
export class VanessaYamlControl {
    private busy = false;
    constructor(private readonly ports: VanessaYamlControlPorts) {}

    private assertCurrent(source: VanessaFeatureDocument): void {
        const active = this.ports.current();
        if (!active || active.uri !== source.uri || active.text !== source.text || active.dirty || active.line !== source.line) {
            throw new Error('The active YAML source or selection changed. Run the command again.');
        }
    }

    private mapped(build: VanessaYamlBuild, source: VanessaFeatureDocument): readonly CompilerControlFeatureLocation[] {
        const saved = build.sources.find(item => item.uri === source.uri);
        if (!saved || !nativeDocumentTextMatchesFileText(source.text, saved.text)) { throw new VanessaYamlBuildRequiredError('Compile this test again: the YAML source or build changed.'); }
        const mapped = mapYamlLineToFeatures(build, source.uri, source.line);
        if (mapped.kind === 'stale') { throw new VanessaYamlBuildRequiredError('Compile this test again: the YAML source or build changed.'); }
        if (mapped.kind === 'unmapped') { throw new Error('The selected YAML line has no exact compiled step.'); }
        return mapped.kind === 'unique' ? [mapped.location] : mapped.locations;
    }

    async run(mode: VanessaYamlControlMode, requestedLine?: number, breakpointDesired?: boolean): Promise<void> {
        if (this.busy) { throw new Error('Vanessa is busy. Wait for the current command.'); }
        const source = this.ports.current();
        const targetSource = source && requestedLine !== undefined ? { ...source, line: requestedLine } : source;
        if (!source || !targetSource || !isExecutableYamlControlLine(targetSource)) { throw new Error('Place the cursor on an executable line in the YAML scenario text.'); }
        this.busy = true;
        try {
            if (source.dirty && !await this.ports.save()) { throw new Error('Save the YAML source before controlling Vanessa.'); }
            if (!nativeDocumentTextMatchesFileText(source.text, await this.ports.readText(source.filePath))) {
                throw new Error('The YAML source changed on disk. Reopen it and compile the test again.');
            }
            this.assertCurrent(source);
            let build = await this.ports.loadBuild(); this.assertCurrent(source);
            if (!build) { throw new VanessaYamlBuildRequiredError('Compile this test before controlling Vanessa from YAML.'); }
            const locations = this.mapped(build, targetSource);
            let location: CompilerControlFeatureLocation | undefined = locations[0];
            if (locations.length > 1) {
                const originalManifest = JSON.stringify(build.manifest);
                location = await this.ports.choose(locations);
                if (!location) { return; }
                this.assertCurrent(source);
                if (!locations.some(candidate => sameLocation(candidate, location!))) { throw new Error('The selected invocation is not in the compiler map.'); }
                // A picker may stay open while sources, profiles or compiler output change.
                build = await this.ports.loadBuild(); this.assertCurrent(source);
                if (!build || JSON.stringify(build.manifest) !== originalManifest || !this.mapped(build, targetSource).some(candidate => sameLocation(candidate, location!))) {
                    throw new Error('Compile this test again: the YAML source or build changed.');
                }
            }
            const artifact = build.artifacts.find(item => item.worker === location.worker && item.feature === location.feature);
            if (!artifact) { throw new Error('The selected invocation is not in the compiler map.'); }
            if (collectGherkinSyntaxErrors(artifact.featureContent).length) { throw new Error('Fix the generated feature syntax before controlling Vanessa.'); }
            this.assertCurrent(source);
            const outcome = await this.ports.perform(mode, { location, source, build, breakpointDesired, featureText: artifact.featureContent,
                filePath: path.join(build.outputRoot, ...location.feature.split('/')) });
            if (mode !== 'oneStep' || !outcome.passed || !outcome.nextLineNumber || outcome.nextLineNumber <= location.lineNumber) { return; }
            const next = mapFeatureLineToYaml(build, location.worker, location.feature, outcome.nextLineNumber);
            const active = this.ports.current();
            if (next.kind === 'unique' && next.location.uri === source.uri && next.location.lineIndex > source.line && active &&
                active.uri === source.uri && active.text === source.text && active.line === source.line && !active.dirty) {
                this.ports.selectLine?.(next.location.lineIndex);
            }
        } finally { this.busy = false; }
    }
}
