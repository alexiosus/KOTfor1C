import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function projectFile(relativePath: string): string {
    return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

test('catalog workflow is append-only, serialized, and uses noreply commit identity', () => {
    const source = projectFile('.github/workflows/publish-step-catalogs.yml');

    assert.match(source, /runs-on: ubuntu-24\.04/);
    assert.match(source, /uses: actions\/checkout@v7/);
    assert.match(source, /uses: actions\/setup-node@v7/);
    assert.match(source, /permissions:\s*\n\s*contents: write/);
    assert.match(source, /concurrency:/);
    assert.match(source, /cancel-in-progress: false/);
    assert.match(source, /step-catalogs/);
    assert.match(source, /48015759\+alexiosus@users\.noreply\.github\.com/);
    assert.match(source, /npm run generate:step-catalog/);
    assert.doesNotMatch(source, /--force|push --force/);
});

test('catalog workflow validates generated output before publishing only catalog artifacts', () => {
    const source = projectFile('.github/workflows/publish-step-catalogs.yml');

    assert.match(source, /node --test out\/test\/stepCatalogGenerator\.test\.js/);
    assert.match(source, /index\.json/);
    assert.match(source, /generation-report\.json/);
    assert.match(source, /catalog\.json/);
    assert.match(source, /diff --cached --quiet/);
});

test('versioned catalog settings are folder scoped and legacy HTML is opt-in', () => {
    const packageJson = JSON.parse(projectFile('package.json'));
    const diagnostics = packageJson.contributes.configuration.find(
        (section: { title: string }) => section.title === '%config.diagnosticsSettings.title%'
    );
    const properties = diagnostics.properties;

    assert.deepEqual(properties['kotTestToolkit.steps.vanessaVersion'], {
        type: 'string',
        default: '',
        scope: 'resource',
        pattern: '^(|v?\\d+\\.\\d+\\.\\d+\\.\\d+)$',
        description: '%config.stepsVanessaVersion.description%',
        order: 1
    });
    assert.equal(
        properties['kotTestToolkit.steps.catalogIndexUrl'].default,
        'https://raw.githubusercontent.com/alexiosus/KOTfor1C/step-catalogs/index.json'
    );
    assert.equal(properties['kotTestToolkit.steps.catalogIndexUrl'].scope, 'resource');
    assert.equal(properties['kotTestToolkit.steps.externalUrl'].default, '');
    assert.equal(properties['kotTestToolkit.steps.externalUrl'].order, 3);
});

test('generator build output and development inputs are excluded from the VSIX', () => {
    const ignore = projectFile('.vscodeignore');

    assert.match(ignore, /^out\/tools\/\*\*$/m);
    assert.match(ignore, /^tools\/step-catalog\/\*\*$/m);
    assert.match(ignore, /^test\/fixtures\/step-catalog\/\*\*$/m);
});
