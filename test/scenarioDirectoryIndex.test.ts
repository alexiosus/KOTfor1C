import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ScenarioDirectoryIndex } from '../src/scenarioCatalog';

test('finds all containing scenario directories without matching sibling prefixes', () => {
    const index = new ScenarioDirectoryIndex([
        { name: 'Parent', filePath: '/repo/yaml/Drive/A/scen.yaml' },
        { name: 'Nested', filePath: '/repo/yaml/Drive/A/nested/scen.yaml' },
        { name: 'Sibling', filePath: '/repo/yaml/Drive/AB/scen.yaml' }
    ], '/repo/yaml', '/repo/yaml', path.posix, false);

    assert.deepEqual(index.getRelatedScenarioNames('/repo/yaml/Drive/A/nested/test.feature'), ['Parent', 'Nested']);
    assert.deepEqual(index.getRelatedScenarioNames('/repo/yaml/Drive/A2/test.feature'), []);
    assert.deepEqual(index.getRelatedScenarioNames('/repo/yaml/Drive/AB/scen.yaml'), ['Sibling']);
});

test('recognizes Windows UNC paths, case changes, and a canonical scan-root alias', () => {
    const scanRoot = '\\\\mac\\Home\\Development\\Yaml';
    const canonicalRoot = 'C:\\Work\\Yaml';
    const index = new ScenarioDirectoryIndex([
        { name: 'Invoice', filePath: '\\\\mac\\Home\\Development\\Yaml\\Drive\\Invoice\\scen.yaml' }
    ], scanRoot, canonicalRoot, path.win32, true);

    assert.deepEqual(index.getRelatedScenarioNames('c:\\work\\yaml\\DRIVE\\invoice\\test.feature'), ['Invoice']);
    assert.deepEqual(index.getRelatedScenarioNames('\\\\MAC\\HOME\\DEVELOPMENT\\YAML\\drive\\invoice\\test.feature'), ['Invoice']);
    assert.deepEqual(index.getRelatedScenarioNames('c:\\work\\yaml\\drive\\invoice2\\test.feature'), []);
});

test('returns stable keys through raw and canonical aliases without collapsing duplicate names', () => {
    const scanRoot = '\\\\mac\\Home\\Development\\Yaml';
    const canonicalRoot = 'C:\\Work\\Yaml';
    const parentKey = 'file:///C:/Work/Yaml/Drive/Invoice/scen.yaml';
    const nestedKey = 'file:///C:/Work/Yaml/Drive/Invoice/Nested/scen.yaml';
    const index = new ScenarioDirectoryIndex([
        {
            key: parentKey,
            name: 'Duplicate',
            filePath: '\\\\mac\\Home\\Development\\Yaml\\Drive\\Invoice\\scen.yaml'
        },
        {
            key: nestedKey,
            name: 'Duplicate',
            filePath: '\\\\mac\\Home\\Development\\Yaml\\Drive\\Invoice\\Nested\\scen.yaml'
        }
    ], scanRoot, canonicalRoot, path.win32, true);

    assert.deepEqual(
        index.getRelatedScenarioKeys('C:\\WORK\\YAML\\drive\\invoice\\nested\\test.feature'),
        [parentKey, nestedKey]
    );
    assert.deepEqual(
        index.getRelatedScenarioKeys('\\\\MAC\\HOME\\DEVELOPMENT\\YAML\\drive\\invoice\\nested\\test.feature'),
        [parentKey, nestedKey]
    );
    assert.deepEqual(
        index.getRelatedScenarioNames('C:\\WORK\\YAML\\drive\\invoice\\nested\\test.feature'),
        ['Duplicate']
    );
});
