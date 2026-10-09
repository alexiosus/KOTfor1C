import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
    extractTopLevelKotMetadataBlock,
    migrateLegacyPhaseSwitcherMetadata,
    parsePhaseSwitcherMetadata
} from '../src/phaseSwitcherMetadata';

test('Default metadata is semantically ignored and absent from the new main scenario template', () => {
    const oldMetadata = parsePhaseSwitcherMetadata([
        'KOTМетаданные:',
        '    PhaseSwitcher:',
        '        Tab: "Smoke"',
        '        Default: true',
        '        OrderOnTab: 10'
    ].join('\n')) as unknown as Record<string, unknown>;
    const mainTemplate = fs.readFileSync(path.join(process.cwd(), 'res', 'main.yaml'), 'utf8');
    const templateMetadata = parsePhaseSwitcherMetadata(mainTemplate) as unknown as Record<string, unknown>;

    assert.deepEqual(oldMetadata, {
        tabName: 'Smoke',
        order: 10,
        hasTab: true,
        hasOrder: true,
        hasAny: true,
        source: 'kot'
    });
    assert.equal(Object.hasOwn(templateMetadata, 'defaultState'), false);
    assert.equal(Object.hasOwn(templateMetadata, 'hasDefault'), false);
});

test('metadata migration leaves an obsolete Default field untouched', () => {
    const source = [
        'ТипФайла: "Сценарий"',
        'ДанныеСценария:',
        '    Имя: "Старый сценарий"',
        'KOTМетаданные:',
        '    Описание: |',
        '        Existing description',
        '    PhaseSwitcher:',
        '        Tab: "Smoke"',
        '        Default: true',
        '        OrderOnTab: 10',
        'ТекстСценария: |',
        '    И выполняется шаг',
        ''
    ].join('\n');

    const result = migrateLegacyPhaseSwitcherMetadata(source, {
        migrateLegacyPhaseSwitcherTags: false
    });

    assert.equal(
        result.content.split(/\r\n|\r|\n/u).filter(line => line === '        Default: true').length,
        1
    );
    assert.equal(
        Object.hasOwn(
            parsePhaseSwitcherMetadata(result.content) as unknown as Record<string, unknown>,
            'defaultState'
        ),
        false
    );
});

test('new KOT metadata uses an empty description without a dash marker', () => {
    const source = [
        '﻿ТипФайла: "Сценарий"',
        'ДанныеСценария:',
        '    Имя: "Новый сценарий"',
        'ТекстСценария: |',
        '    И выполняется шаг',
        ''
    ].join('\n');

    const result = migrateLegacyPhaseSwitcherMetadata(source, {
        migrateLegacyPhaseSwitcherTags: false
    });

    assert.equal(extractTopLevelKotMetadataBlock(result.content), [
        'KOTМетаданные:',
        '    Описание: |',
        '        '
    ].join('\n'));
});

test('a missing KOT description is added without a dash marker', () => {
    const source = [
        'ТипФайла: "Сценарий"',
        'ДанныеСценария:',
        '    Имя: "Сценарий без описания"',
        'KOTМетаданные:',
        '    PhaseSwitcher:',
        '        Tab: "Регресс"',
        'ТекстСценария: |',
        '    И выполняется шаг',
        ''
    ].join('\n');

    const result = migrateLegacyPhaseSwitcherMetadata(source, {
        migrateLegacyPhaseSwitcherTags: false
    });

    assert.equal(extractTopLevelKotMetadataBlock(result.content), [
        'KOTМетаданные:',
        '    Описание: |',
        '        ',
        '    PhaseSwitcher:',
        '        Tab: "Регресс"'
    ].join('\n'));
});
