import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseUserStepSource } from '../src/bslStepSourceParser';
import {
    createNewUserStepLibrarySource,
    planUserStepSourceEdit,
    resolveVanessaTemplateRoot,
    type UserStepSourceEditPlan
} from '../src/userStepCreator';

const parseContext = {
    sourceUri: 'file:///workspace/libraries/step_definitions-src/Custom/Обработка/Forms/Форма/Ext/Form/Module.bsl',
    workspaceFolderUri: 'file:///workspace',
    profileId: 'active',
    libraryRootUri: 'file:///workspace/libraries',
    sourceLabel: 'Custom user steps'
};

function request(source: string) {
    return {
        source,
        documentVersion: 3,
        expectedVersion: 3,
        template: 'И я открываю "Заказ" для "Администратор"',
        parameterNames: ['Объект', 'Роль'],
        implementationName: 'ОткрытьКарточку',
        implementationKind: 'procedure' as const,
        description: 'Открывает карточку объекта.',
        category: 'UI'
    };
}

function applyPlan(source: string, plan: UserStepSourceEditPlan): string {
    return [...plan.edits]
        .sort((left, right) => right.startOffset - left.startOffset)
        .reduce((text, edit) => text.slice(0, edit.startOffset) + edit.newText + text.slice(edit.endOffset), source);
}

test('resolves Vanessa TemplateEpfUF from active-profile aliases and EPF fallback', () => {
    assert.equal(resolveVanessaTemplateRoot({
        workspaceFolderPath: '/repo',
        buildParameters: [{ key: 'VanessaFolder', value: 'tools/vanessa' }]
    }), path.join('/repo', 'tools/vanessa', 'lib', 'TemplateEpfUF'));
    assert.equal(resolveVanessaTemplateRoot({
        workspaceFolderPath: '/repo',
        buildParameters: [{ key: 'VanessaPath', value: '/opt/vanessa/vanessa-automation.epf' }]
    }), path.join('/opt/vanessa', 'lib', 'TemplateEpfUF'));
    assert.equal(resolveVanessaTemplateRoot({
        workspaceFolderPath: '/repo',
        buildParameters: [],
        configuredVanessaEpfPath: 'vendor/vanessa/vanessa-automation.epf'
    }), path.join('/repo', 'vendor/vanessa', 'lib', 'TemplateEpfUF'));
});

test('creates a source-first library from Vanessa metadata without requiring a 1C platform', async t => {
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kot-user-step-'));
    t.after(() => fs.promises.rm(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'libraries');
    const templateRoot = path.join(temporary, 'vanessa', 'lib', 'TemplateEpfUF');
    const templateFiles = [
        ['Обработка.xml', '<processor/>'],
        ['Обработка/Forms/Форма.xml', '<form/>'],
        ['Обработка/Forms/Форма/Ext/Form.xml', '<form-content/>'],
        ['Обработка/Forms/Форма/Ext/Form/Module.bsl', '\uFEFF']
    ] as const;
    for (const [relativePath, content] of templateFiles) {
        const target = path.join(templateRoot, relativePath);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, content, 'utf8');
    }

    const result = await createNewUserStepLibrarySource({
        libraryRootPath: root,
        libraryName: 'CustomSteps',
        templateRoot,
        step: request('')
    });

    assert.equal(result.sourceDirectory, path.join(root, 'step_definitions-src', 'CustomSteps'));
    assert.equal(result.rootXmlPath, path.join(result.sourceDirectory, 'Обработка.xml'));
    assert.equal(result.modulePath, path.join(
        result.sourceDirectory,
        'Обработка', 'Forms', 'Форма', 'Ext', 'Form', 'Module.bsl'
    ));
    assert.equal(result.targetEpfPath, path.join(root, 'step_definitions', 'CustomSteps.epf'));
    assert.equal(await fs.promises.readFile(result.rootXmlPath, 'utf8'), '<processor/>');
    assert.equal(await fs.promises.readFile(path.join(
        result.sourceDirectory,
        'Обработка', 'Forms', 'Форма', 'Ext', 'Form.xml'
    ), 'utf8'), '<form-content/>');

    const module = await fs.promises.readFile(result.modulePath, 'utf8');
    assert.match(module, /Функция ПолучитьСписокТестов\(КонтекстФреймворкаBDD\) Экспорт/u);
    const parsed = parseUserStepSource(module, parseContext);
    assert.deepEqual(parsed.definitions.map(item => item.template), ['И я открываю "Объект" для "Роль"']);
    assert.equal(parsed.declarations.some(item => item.name === 'ОткрытьКарточку'), true);
});

test('plans parser-proven registration and implementation insertions in an existing module', () => {
    const source = [
        'Функция ПолучитьСписокТестов(КонтекстФреймворкаBDD) Экспорт',
        '    Ванесса = КонтекстФреймворкаBDD;',
        '    ВсеТесты = Новый Массив;',
        '    Возврат ВсеТесты;',
        'КонецФункции',
        ''
    ].join('\r\n');
    const parsed = parseUserStepSource(source, parseContext);
    const plan = planUserStepSourceEdit(parsed, request(source));
    const result = applyPlan(source, plan);
    const reparsed = parseUserStepSource(result, parseContext);

    assert.equal(plan.documentVersion, 3);
    assert.equal(result.replace(/\r\n/gu, '').includes('\n'), false);
    assert.deepEqual(reparsed.definitions.map(item => item.template), ['И я открываю "Объект" для "Роль"']);
    assert.deepEqual(reparsed.definitions[0].parameters.map(item => item.name), ['Объект', 'Роль']);
    assert.equal(reparsed.declarations.some(item => item.name === 'ОткрытьКарточку'), true);
});

test('refuses duplicate implementation names and unsafe parser insertion metadata', () => {
    const duplicateSource = [
        'Функция ПолучитьСписокТестов() Экспорт',
        '    ВсеТесты = Новый Массив;',
        '    Возврат ВсеТесты;',
        'КонецФункции',
        'Процедура ОткрытьКарточку() Экспорт',
        'КонецПроцедуры'
    ].join('\n');
    assert.throws(
        () => planUserStepSourceEdit(
            parseUserStepSource(duplicateSource, parseContext),
            request(duplicateSource)
        ),
        /implementation.*already exists/iu
    );

    const unsafeSource = [
        'Функция ПолучитьСписокТестов() Экспорт',
        'КонецФункции',
        'Функция ПолучитьСписокТестов() Экспорт',
        'КонецФункции',
        'Процедура НеЗакрыта()'
    ].join('\n');
    assert.throws(
        () => planUserStepSourceEdit(
            parseUserStepSource(unsafeSource, parseContext),
            { ...request(unsafeSource), implementationName: 'НовыйШаг' }
        ),
        /safe insertion/iu
    );
});

test('rejects duplicate parameter names and concurrent document changes', () => {
    const source = [
        'Функция ПолучитьСписокТестов() Экспорт',
        '    ВсеТесты = Новый Массив;',
        '    Возврат ВсеТесты;',
        'КонецФункции'
    ].join('\n');
    const parsed = parseUserStepSource(source, parseContext);
    assert.throws(
        () => planUserStepSourceEdit(parsed, {
            ...request(source),
            parameterNames: ['Значение', ' значение ']
        }),
        /duplicate parameter/iu
    );
    assert.throws(
        () => planUserStepSourceEdit(parsed, {
            ...request(source),
            expectedVersion: 2
        }),
        /document changed/iu
    );
});
