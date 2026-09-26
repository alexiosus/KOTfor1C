import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    parseStaticBslStepRegistrations,
    type StaticBslStepRegistration
} from '../../src/bslStepSourceParser';
import { enrichStepCatalogCategories } from '../../src/stepCatalogCategories';
import {
    compareCatalogWithLegacyHtml,
    createStepCatalogGenerationReport,
    generateBuiltInStepCatalog,
    parseVanessaStepTemplateXml,
    writeCatalogPublication
} from '../../src/stepCatalogTemplateXml';

const REQUIRED_ARGUMENTS = [
    'source-root',
    'version',
    'ref',
    'commit',
    'timestamp',
    'output',
    'legacy-html'
] as const;
const REGISTRATION_MARKER = 'добавитьшагвмассивтестов';
const SOURCE_READ_CONCURRENCY = 16;

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

async function enumerateBslFiles(sourceRoot: string): Promise<readonly string[]> {
    const directories = [sourceRoot];
    const files: string[] = [];
    while (directories.length > 0) {
        const directory = directories.pop()!;
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                directories.push(entryPath);
            } else if (entry.isFile() && path.extname(entry.name).toLocaleLowerCase() === '.bsl') {
                files.push(entryPath);
            }
        }
    }
    return files.sort((left, right) => left.localeCompare(right));
}

async function collectVanessaRegistrations(sourceRoot: string): Promise<{
    readonly registrations: readonly StaticBslStepRegistration[];
    readonly warningCount: number;
    readonly parsedFileCount: number;
}> {
    const files = await enumerateBslFiles(sourceRoot);
    const registrationsByFile: StaticBslStepRegistration[][] = files.map(() => []);
    const warningCounts = files.map(() => 0);
    const parsedFiles = files.map(() => false);
    let cursor = 0;
    const workers = Array.from(
        { length: Math.min(SOURCE_READ_CONCURRENCY, files.length) },
        async () => {
            while (cursor < files.length) {
                const index = cursor++;
                const source = await readFile(files[index], 'utf8');
                if (!source.toLocaleLowerCase().includes(REGISTRATION_MARKER)) {
                    continue;
                }
                const parsed = parseStaticBslStepRegistrations(
                    source,
                    pathToFileURL(files[index]).toString()
                );
                registrationsByFile[index].push(...parsed.registrations);
                warningCounts[index] = parsed.warnings.length;
                parsedFiles[index] = true;
            }
        }
    );
    await Promise.all(workers);
    return {
        registrations: registrationsByFile.flat(),
        warningCount: warningCounts.reduce((total, count) => total + count, 0),
        parsedFileCount: parsedFiles.filter(Boolean).length
    };
}

async function main(): Promise<void> {
    const args = parseArguments(process.argv.slice(2));
    const sourceRoot = path.resolve(args['source-root']);
    const templatePath = path.join(
        sourceRoot,
        'locales',
        'Steps',
        'Templates',
        'en',
        'Ext',
        'Template.xml'
    );
    const [templateXml, legacyHtml, sourceRegistrations] = await Promise.all([
        readFile(templatePath, 'utf8'),
        readFile(path.resolve(args['legacy-html']), 'utf8'),
        collectVanessaRegistrations(sourceRoot)
    ]);
    const parsedTemplate = parseVanessaStepTemplateXml(templateXml);
    if (parsedTemplate.steps.length < 1_000) {
        throw new Error(`Generated catalog is unexpectedly small (${parsedTemplate.steps.length} rows).`);
    }
    const enrichment = enrichStepCatalogCategories({
        steps: parsedTemplate.steps,
        categoryTranslations: parsedTemplate.categories,
        registrations: sourceRegistrations.registrations
    });
    const parsed = { ...parsedTemplate, steps: enrichment.steps };
    const catalog = generateBuiltInStepCatalog(parsed, {
        version: args.version,
        sourceRef: args.ref,
        sourceCommit: args.commit,
        sourceTimestamp: args.timestamp
    });
    const compatibility = compareCatalogWithLegacyHtml(catalog, legacyHtml);
    const report = createStepCatalogGenerationReport(
        parsed,
        catalog,
        compatibility,
        enrichment.report
    );
    if (report.duplicateStepIds.length > 0) {
        throw new Error(`Generated catalog contains ${report.duplicateStepIds.length} duplicate step IDs.`);
    }
    await writeCatalogPublication(path.resolve(args.output), catalog, report);
    process.stdout.write(
        `Generated Vanessa ${catalog.vanessaVersion} catalog: ${report.stepCount} steps, `
        + `${report.excludedSyntaxRows} syntax rows excluded, `
        + `${report.categoryCount} categories separated, `
        + `${report.categorizedStepCount} steps categorized from `
        + `${sourceRegistrations.parsedFileCount} BSL files, `
        + `${sourceRegistrations.warningCount} BSL warnings, `
        + `${report.duplicateEnglishPatterns.length} duplicate English patterns reported.\n`
    );
}

void main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[step-catalog] ${message}\n`);
    process.exitCode = 1;
});
