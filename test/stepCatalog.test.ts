import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createStepDefinitionId,
    parseBuiltInStepCatalog,
    parseStepCatalogIndex
} from '../src/stepCatalog';

const validCatalog = {
    schemaVersion: 1,
    vanessaVersion: '1.2.043.28',
    generatedAt: '2026-09-22T00:00:00.000Z',
    source: {
        repository: 'Pr-Mex/vanessa-automation',
        ref: '1.2.043.28',
        commit: '0123456789abcdef0123456789abcdef01234567'
    },
    steps: [{
        id: createStepDefinitionId('И пауза 1', 'And 1 second pause'),
        ru: { pattern: 'И пауза 1', description: 'Пауза' },
        en: { pattern: 'And 1 second pause', description: 'Pause' }
    }]
};

test('catalog parser accepts a valid exact-version catalog', () => {
    const catalog = parseBuiltInStepCatalog(validCatalog, '1.2.043.28');
    assert.equal(catalog.steps.length, 1);
    assert.equal(catalog.steps[0].ru?.pattern, 'И пауза 1');
});

test('catalog parser rejects a requested-version mismatch', () => {
    assert.throws(
        () => parseBuiltInStepCatalog(validCatalog, '1.2.043.27'),
        /expected 1\.2\.043\.27/
    );
});

test('catalog parser permits duplicate language patterns when paired definitions have unique ids', () => {
    const duplicateRussianStep = {
        id: createStepDefinitionId('И пауза 1', 'And 2 second pause'),
        ru: { pattern: 'И пауза 1', description: 'Другая пауза' },
        en: { pattern: 'And 2 second pause', description: 'Different pause' }
    };
    const catalog = parseBuiltInStepCatalog({
        ...validCatalog,
        steps: [...validCatalog.steps, duplicateRussianStep]
    });
    assert.equal(catalog.steps.length, 2);
});

test('catalog parser rejects a definition whose id does not match its variants', () => {
    assert.throws(
        () => parseBuiltInStepCatalog({
            ...validCatalog,
            steps: [{ ...validCatalog.steps[0], id: '0'.repeat(64) }]
        }),
        /step id/
    );
});

test('index parser accepts a valid exact catalog entry', () => {
    const index = parseStepCatalogIndex({
        schemaVersion: 1,
        generatedAt: validCatalog.generatedAt,
        catalogs: {
            '1.2.043.28': {
                path: '1.2.043.28/catalog.json',
                sha256: 'a'.repeat(64),
                stepCount: 1,
                sourceCommit: validCatalog.source.commit
            }
        }
    });
    assert.equal(index.catalogs['1.2.043.28'].stepCount, 1);
});

test('index parser accepts only safe relative catalog paths', () => {
    assert.throws(() => parseStepCatalogIndex({
        schemaVersion: 1,
        generatedAt: validCatalog.generatedAt,
        catalogs: {
            '1.2.043.28': {
                path: '../catalog.json',
                sha256: 'a'.repeat(64),
                stepCount: 1,
                sourceCommit: validCatalog.source.commit
            }
        }
    }), /relative path/);
});

test('index parser rejects non-version catalog keys', () => {
    assert.throws(() => parseStepCatalogIndex({
        schemaVersion: 1,
        generatedAt: validCatalog.generatedAt,
        catalogs: {
            latest: {
                path: 'latest/catalog.json',
                sha256: 'a'.repeat(64),
                stepCount: 1,
                sourceCommit: validCatalog.source.commit
            }
        }
    }), /Vanessa version/);
});
