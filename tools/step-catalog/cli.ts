import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    compareCatalogWithLegacyHtml,
    createStepCatalogGenerationReport,
    generateBuiltInStepCatalog,
    parseVanessaStepTemplateXml,
    writeCatalogPublication
} from '../../src/stepCatalogTemplateXml';

const REQUIRED_ARGUMENTS = [
    'source',
    'version',
    'ref',
    'commit',
    'source-timestamp',
    'publication-root',
    'legacy-html'
] as const;

type RequiredArgument = typeof REQUIRED_ARGUMENTS[number];
type Arguments = Record<RequiredArgument, string>;

function parseArguments(argv: readonly string[]): Arguments {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
            throw new Error('Arguments must use --name value pairs.');
        }
        const name = flag.slice(2);
        if (!REQUIRED_ARGUMENTS.includes(name as RequiredArgument)) {
            throw new Error(`Unknown argument --${name}.`);
        }
        if (values.has(name)) {
            throw new Error(`Argument --${name} was provided more than once.`);
        }
        values.set(name, value);
    }

    const missing = REQUIRED_ARGUMENTS.filter(name => !values.has(name));
    if (missing.length > 0) {
        throw new Error(`Missing required argument${missing.length === 1 ? '' : 's'}: ${missing.map(name => `--${name}`).join(', ')}.`);
    }
    return Object.fromEntries(values) as Arguments;
}

async function main(): Promise<void> {
    const args = parseArguments(process.argv.slice(2));
    const templatePath = path.join(
        path.resolve(args.source),
        'locales',
        'Steps',
        'Templates',
        'en',
        'Ext',
        'Template.xml'
    );
    const [templateXml, legacyHtml] = await Promise.all([
        readFile(templatePath, 'utf8'),
        readFile(path.resolve(args['legacy-html']), 'utf8')
    ]);
    const parsed = parseVanessaStepTemplateXml(templateXml);
    if (parsed.steps.length < 1_000) {
        throw new Error(`Generated catalog is unexpectedly small (${parsed.steps.length} rows).`);
    }
    const catalog = generateBuiltInStepCatalog(parsed, {
        version: args.version,
        sourceRef: args.ref,
        sourceCommit: args.commit,
        sourceTimestamp: args['source-timestamp']
    });
    const compatibility = compareCatalogWithLegacyHtml(catalog, legacyHtml);
    const report = createStepCatalogGenerationReport(parsed, catalog, compatibility);
    if (report.duplicateStepIds.length > 0) {
        throw new Error(`Generated catalog contains ${report.duplicateStepIds.length} duplicate step IDs.`);
    }
    await writeCatalogPublication(path.resolve(args['publication-root']), catalog, report);
    process.stdout.write(
        `Generated Vanessa ${catalog.vanessaVersion} catalog: ${report.stepCount} steps, `
        + `${report.excludedSyntaxRows} syntax rows excluded, `
        + `${report.duplicateEnglishPatterns.length} duplicate English patterns reported.\n`
    );
}

void main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[step-catalog] ${message}\n`);
    process.exitCode = 1;
});
