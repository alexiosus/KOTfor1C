import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStepDefinitionId, sha256Hex } from '../src/stepCatalog';
import { enrichStepCatalogCategories } from '../src/stepCatalogCategories';
import {
    compareCatalogWithLegacyHtml,
    createStepCatalogGenerationReport,
    generateBuiltInStepCatalog,
    parseVanessaStepTemplateXml,
    serializeStepCatalogJson,
    writeCatalogPublication
} from '../src/stepCatalogTemplateXml';

function readFixture(relativePath: string): string {
    return readFileSync(path.join(__dirname, '../../test/fixtures', relativePath), 'utf8');
}

function replaceFirstDataRow(xml: string, replacement: string): string {
    const marker = '<rowsItem>\n    <index>1</index>';
    const start = xml.indexOf(marker);
    const end = xml.indexOf('</rowsItem>', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    return `${xml.slice(0, start)}${replacement}${xml.slice(end + '</rowsItem>'.length)}`;
}

test('official template parser separates category translations from executable steps', () => {
    const xml = readFixture('step-catalog/Template.xml');
    const result = parseVanessaStepTemplateXml(xml);

    assert.equal(result.sourceRows, 4);
    assert.equal(result.steps.length, 2);
    assert.equal(result.excludedSyntaxRows, 1);
    assert.deepEqual(result.categories, [{ ru: 'Файлы', en: 'Files' }]);
    assert.equal(result.steps[0].ru?.pattern, 'И поле <Имя> равно "Значение"');
    assert.equal(result.steps[0].en?.description, 'Checks value & title');
    assert.deepEqual(result.steps[0].categoryPath, { ru: ['Файлы'], en: ['Files'] });
    assert.equal(result.steps[1].en, undefined);
    assert.equal(result.steps[1].ru?.description, 'Описание\nв две строки');
    assert.deepEqual(result.steps[1].categoryPath, { ru: ['Файлы'], en: ['Files'] });
});

test('official template parser rejects a row with three outer cells', () => {
    const xml = readFixture('step-catalog/Template.xml');
    const malformed = replaceFirstDataRow(xml, `
  <rowsItem>
    <index>1</index>
    <row><c/><c/><c/></row>
  </rowsItem>`);

    assert.throws(
        () => parseVanessaStepTemplateXml(malformed),
        /exactly four cells/
    );
});

test('official template parser rejects namespace or header drift', () => {
    const xml = readFixture('step-catalog/Template.xml');

    assert.throws(
        () => parseVanessaStepTemplateXml(xml.replace('Шаг оригинал', 'Другой заголовок')),
        /header/
    );
    assert.throws(
        () => parseVanessaStepTemplateXml(xml.replace(
            'http://v8.1c.ru/8.2/data/spreadsheet',
            'http://example.invalid/spreadsheet'
        )),
        /namespace/
    );
});

const generationOptions = {
    version: '1.2.043.28',
    sourceRef: '1.2.043.28',
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    sourceTimestamp: '2026-09-22T00:00:00.000Z'
};

function generatedFixture() {
    const parsed = parseVanessaStepTemplateXml(readFixture('step-catalog/Template.xml'));
    const enrichment = enrichStepCatalogCategories({
        steps: parsed.steps,
        categoryTranslations: parsed.categories,
        registrations: [{
            template: 'И поле <Имя> равно "Значение"',
            category: 'Файлы'
        }]
    });
    const enrichedParsed = { ...parsed, steps: enrichment.steps };
    const catalog = generateBuiltInStepCatalog(enrichedParsed, generationOptions);
    const compatibility = compareCatalogWithLegacyHtml(catalog, `
        <table>
          <tr class="R1"><td>И поле &lt;Имя&gt; равно "Значение"</td><td>Есть</td><td></td><td></td></tr>
          <tr class="R2"><td>  И старый шаг  </td><td>Нет</td><td>And legacy step</td><td>Missing</td></tr>
        </table>`);
    const report = createStepCatalogGenerationReport(
        enrichedParsed,
        catalog,
        compatibility,
        enrichment.report
    );
    return { parsed: enrichedParsed, catalog, compatibility, report, enrichment };
}

test('catalog generation sorts definitions and uses only deterministic source metadata', () => {
    const { catalog } = generatedFixture();

    assert.equal(catalog.generatedAt, generationOptions.sourceTimestamp);
    assert.equal(catalog.source.ref, generationOptions.sourceRef);
    assert.equal(catalog.steps.length, 2);
    assert.deepEqual(
        catalog.steps.map(step => step.ru?.pattern),
        ['И поле <Имя> равно "Значение"', 'И только русский шаг']
    );
    assert.deepEqual(catalog.steps[0].categoryPath, {
        ru: ['Файлы'],
        en: ['Files']
    });
    assert.ok(serializeStepCatalogJson(catalog).endsWith('\n'));
    assert.equal(serializeStepCatalogJson(catalog), serializeStepCatalogJson(catalog));
});

test('catalog generation rejects structurally invalid placeholders', () => {
    const parsed = parseVanessaStepTemplateXml(readFixture('step-catalog/Template.xml'));
    for (const pattern of [
        'И поле "%0 Имя" равно "Значение"',
        'И поле %1 Имя равно "Значение"',
        'И поле "%1Имя" равно "Значение"'
    ]) {
        const invalid = {
            ...parsed,
            steps: parsed.steps.map((step, index) => index === 0
                ? { ...step, ru: { ...step.ru!, pattern } }
                : step)
        };

        assert.throws(
            () => generateBuiltInStepCatalog(invalid, generationOptions),
            /invalid placeholder/
        );
    }
});

test('compatibility report lists every normalized legacy pattern missing from generated data', () => {
    const { compatibility } = generatedFixture();

    assert.deepEqual(compatibility.missingLegacyRuPatterns, ['И старый шаг']);
    assert.deepEqual(compatibility.missingLegacyEnPatterns, ['And legacy step']);
});

test('generation report records source, duplicate, and category coverage data', () => {
    const { parsed, catalog, compatibility, enrichment } = generatedFixture();
    const duplicatedCatalog = {
        ...catalog,
        steps: [
            ...catalog.steps,
            {
                ...catalog.steps[1],
                id: 'f'.repeat(64),
                en: { pattern: 'And field <Name> equals "Value"', description: 'Duplicate' }
            }
        ]
    };
    const report = createStepCatalogGenerationReport(
        parsed,
        duplicatedCatalog,
        compatibility,
        {
            ...enrichment.report,
            uncategorizedStepCount: 2
        }
    );

    assert.equal(report.sourceRows, 4);
    assert.equal(report.excludedSyntaxRows, 1);
    assert.equal(report.categoryCount, 1);
    assert.equal(report.stepCount, 3);
    assert.deepEqual(report.duplicateRussianPatterns, ['И только русский шаг']);
    assert.deepEqual(report.duplicateEnglishPatterns, ['And field <Name> equals "Value"']);
    assert.equal(report.categorizedStepCount, 2);
    assert.equal(report.uncategorizedStepCount, 2);
    assert.equal(report.unmatchedRegistrationCount, 0);
    assert.deepEqual(report.conflictingCategoryMappings, []);
    assert.deepEqual(report.untranslatableCategorySegments, []);
});

test('publication refuses to replace an existing version with different bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kot-step-catalog-'));
    const versionDirectory = path.join(root, generationOptions.version);
    await mkdir(versionDirectory, { recursive: true });
    await writeFile(path.join(versionDirectory, 'catalog.json'), 'old catalog\n');
    const { catalog, report } = generatedFixture();

    await assert.rejects(
        () => writeCatalogPublication(root, catalog, report),
        /immutable catalog already exists/
    );
});

test('publication appends a category-enriched revision without modifying the original catalog', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kot-step-catalog-'));
    const { catalog, report } = generatedFixture();
    const originalCatalog = {
        ...catalog,
        steps: [
            {
                id: createStepDefinitionId('Файлы', 'Files'),
                ru: { pattern: 'Файлы', description: 'Категория шагов' },
                en: { pattern: 'Files', description: 'Steps category' }
            },
            ...catalog.steps.map(step => ({
                id: step.id,
                ...(step.ru ? { ru: step.ru } : {}),
                ...(step.en ? { en: step.en } : {})
            }))
        ]
    };
    const originalBytes = serializeStepCatalogJson(originalCatalog);
    const versionDirectory = path.join(root, generationOptions.version);
    await mkdir(versionDirectory, { recursive: true });
    await writeFile(path.join(versionDirectory, 'catalog.json'), originalBytes);
    await writeFile(path.join(versionDirectory, 'generation-report.json'), 'original report\n');
    await writeFile(path.join(root, 'index.json'), `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: originalCatalog.generatedAt,
        catalogs: {
            [generationOptions.version]: {
                path: `${generationOptions.version}/catalog.json`,
                sha256: sha256Hex(originalBytes),
                stepCount: originalCatalog.steps.length,
                sourceCommit: originalCatalog.source.commit
            }
        }
    })}\n`);

    await writeCatalogPublication(root, catalog, report);

    assert.equal(
        await readFile(path.join(versionDirectory, 'catalog.json'), 'utf8'),
        originalBytes
    );
    const index = JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8'));
    const revisionPath = index.catalogs[generationOptions.version].path as string;
    assert.match(revisionPath, /^1\.2\.043\.28\/catalog-[0-9a-f]{64}\.json$/u);
    const revision = JSON.parse(await readFile(path.join(root, revisionPath), 'utf8'));
    assert.deepEqual(revision.steps[0].categoryPath, { ru: ['Файлы'], en: ['Files'] });
    const reportPath = revisionPath.replace('/catalog-', '/generation-report-');
    assert.equal(JSON.parse(await readFile(path.join(root, reportPath), 'utf8')).stepCount, 2);
});

test('publication permits adding a missing localized category path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kot-step-catalog-'));
    const { catalog, report } = generatedFixture();
    const originalCatalog = {
        ...catalog,
        steps: catalog.steps.map((step, index) => index === 0
            ? { ...step, categoryPath: { ru: step.categoryPath!.ru } }
            : { id: step.id, ru: step.ru, ...(step.en ? { en: step.en } : {}) })
    };
    const originalBytes = serializeStepCatalogJson(originalCatalog);
    const versionDirectory = path.join(root, generationOptions.version);
    await mkdir(versionDirectory, { recursive: true });
    await writeFile(path.join(versionDirectory, 'catalog.json'), originalBytes);
    await writeFile(path.join(versionDirectory, 'generation-report.json'), 'original report\n');
    await writeFile(path.join(root, 'index.json'), `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: originalCatalog.generatedAt,
        catalogs: {
            [generationOptions.version]: {
                path: `${generationOptions.version}/catalog.json`,
                sha256: sha256Hex(originalBytes),
                stepCount: originalCatalog.steps.length,
                sourceCommit: originalCatalog.source.commit
            }
        }
    })}\n`);

    await writeCatalogPublication(root, catalog, report);

    const index = JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8'));
    const revision = JSON.parse(await readFile(
        path.join(root, index.catalogs[generationOptions.version].path),
        'utf8'
    ));
    assert.deepEqual(revision.steps[0].categoryPath, { ru: ['Файлы'], en: ['Files'] });
});

test('publication writes exact catalog bytes and a sorted digest index', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kot-step-catalog-'));
    const { catalog, report } = generatedFixture();
    await writeFile(path.join(root, 'index.json'), `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-09-23T00:00:00.000Z',
        catalogs: {
            '1.2.043.30': {
                path: '1.2.043.30/catalog.json',
                sha256: 'a'.repeat(64),
                stepCount: 1,
                sourceCommit: 'a'.repeat(40)
            }
        }
    })}\n`);

    await writeCatalogPublication(root, catalog, report);

    const catalogBytes = await readFile(path.join(root, generationOptions.version, 'catalog.json'));
    assert.equal(catalogBytes.toString('utf8'), serializeStepCatalogJson(catalog));
    const index = JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8'));
    assert.deepEqual(Object.keys(index.catalogs), [generationOptions.version, '1.2.043.30']);
    assert.equal(index.catalogs[generationOptions.version].stepCount, 2);
    assert.equal(index.catalogs[generationOptions.version].sha256, sha256Hex(catalogBytes));
});

test('publication rejects a material step-count drop from the preceding version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kot-step-catalog-'));
    const { catalog, report } = generatedFixture();
    await writeFile(path.join(root, 'index.json'), `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-09-21T00:00:00.000Z',
        catalogs: {
            '1.2.043.27': {
                path: '1.2.043.27/catalog.json',
                sha256: 'a'.repeat(64),
                stepCount: 100,
                sourceCommit: 'a'.repeat(40)
            }
        }
    })}\n`);

    await assert.rejects(
        () => writeCatalogPublication(root, catalog, report),
        /material step-count drop/
    );
    await assert.rejects(
        () => readFile(path.join(root, generationOptions.version, 'catalog.json')),
        /ENOENT/
    );
});

test('publication compares against executable preceding steps instead of category metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kot-step-catalog-'));
    const { catalog, report } = generatedFixture();
    const precedingVersion = '1.2.043.27';
    const categoryRu = 'Файлы';
    const categoryEn = 'Files';
    const precedingCatalog = {
        ...catalog,
        vanessaVersion: precedingVersion,
        source: { ...catalog.source, ref: precedingVersion },
        steps: [
            ...catalog.steps,
            {
                id: createStepDefinitionId(categoryRu, categoryEn),
                ru: { pattern: categoryRu, description: 'Категория шагов' },
                en: { pattern: categoryEn, description: 'Steps category' }
            }
        ]
    };
    const precedingDirectory = path.join(root, precedingVersion);
    await mkdir(precedingDirectory, { recursive: true });
    await writeFile(
        path.join(precedingDirectory, 'catalog.json'),
        serializeStepCatalogJson(precedingCatalog)
    );
    await writeFile(path.join(root, 'index.json'), `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-09-21T00:00:00.000Z',
        catalogs: {
            [precedingVersion]: {
                path: `${precedingVersion}/catalog.json`,
                sha256: 'a'.repeat(64),
                stepCount: 3,
                sourceCommit: 'a'.repeat(40)
            }
        }
    })}\n`);

    await writeCatalogPublication(root, catalog, report);

    const published = await readFile(path.join(root, generationOptions.version, 'catalog.json'));
    assert.equal(JSON.parse(published.toString('utf8')).steps.length, 2);
});
