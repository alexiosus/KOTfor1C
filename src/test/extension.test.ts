import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	buildVariableReferenceText,
	buildVariableValuePreview,
	extractSavedVariableFromStepLine,
	formatVariableValueForDisplay,
	findVariableReferenceAtPosition,
	parseVariableReferenceContext
} from '../completionProvider';
import { getBlockClosingKeyword, parseBlockKeyword } from '../blockKeywordParser';
import { alignGherkinTablesInText, normalizeMultilineStepInsertText } from '../gherkinTableUtils';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('parseVariableReferenceContext detects single-dollar mode', () => {
		assert.deepStrictEqual(parseVariableReferenceContext('    И я использую $localVar'), {
			startCharacter: 18,
			typedPrefix: 'localVar',
			mode: 'all'
		});
	});

	test('parseVariableReferenceContext detects double-dollar global-only mode', () => {
		assert.deepStrictEqual(parseVariableReferenceContext('    И я использую $$globalVar'), {
			startCharacter: 18,
			typedPrefix: 'globalVar',
			mode: 'globalOnly'
		});
	});

	test('parseVariableReferenceContext rejects triple-dollar prefix', () => {
		assert.strictEqual(parseVariableReferenceContext('    И я использую $$$broken'), null);
	});

	test('buildVariableReferenceText uses double dollars for global variables', () => {
		assert.strictEqual(buildVariableReferenceText('localVar', 'saved'), '$localVar$');
		assert.strictEqual(buildVariableReferenceText('globalVar', 'global'), '$$globalVar$$');
	});

	test('findVariableReferenceAtPosition detects double-dollar variables', () => {
		assert.deepStrictEqual(findVariableReferenceAtPosition('И я использую $$globalVar$$ здесь', 18), {
			name: 'globalVar',
			source: 'global',
			startCharacter: 14,
			endCharacter: 27
		});
	});

	test('buildVariableValuePreview collapses multiline values for suggestion list', () => {
		assert.strictEqual(buildVariableValuePreview('Первая строка\nВторая строка'), 'Первая строка Вторая строка');
	});

	test('formatVariableValueForDisplay wraps global string values in quotes', () => {
		assert.strictEqual(formatVariableValueForDisplay('VALUE1', 'global'), '\'VALUE1\'');
		assert.strictEqual(formatVariableValueForDisplay('\'VALUE1\'', 'global'), '\'VALUE1\'');
		assert.strictEqual(formatVariableValueForDisplay('"VALUE1"', 'global'), '"VALUE1"');
		assert.strictEqual(formatVariableValueForDisplay('O\'Reilly', 'global'), '"O\'Reilly"');
		assert.strictEqual(
			formatVariableValueForDisplay('He said "it\'s fine"', 'global'),
			'\'He said "it\'\'s fine"\''
		);
		assert.strictEqual(formatVariableValueForDisplay('VALUE1', 'saved'), 'VALUE1');
	});

	test('extractSavedVariableFromStepLine supports broader save patterns', () => {
		const fieldValueVariable = extractSavedVariableFromStepLine('И я запоминаю значение поля "Номер" как "DocNo"');
		assert.ok(fieldValueVariable);
		assert.strictEqual(fieldValueVariable?.name, 'DocNo');
		assert.strictEqual(fieldValueVariable?.source, 'saved');
		assert.ok(fieldValueVariable?.value.includes('значение поля'));

		const globalFieldVariable = extractSavedVariableFromStepLine('And I save the value of "FieldName" field as "GlobalField" globally');
		assert.ok(globalFieldVariable);
		assert.strictEqual(globalFieldVariable?.name, 'GlobalField');
		assert.strictEqual(globalFieldVariable?.source, 'global');

		const generatedVariable = extractSavedVariableFromStepLine('И я генерирую SSCC честного знака для GS1 "04670003110011" уровня "1" в переменную "GeneratedSscc" (расширение)');
		assert.ok(generatedVariable);
		assert.strictEqual(generatedVariable?.name, 'GeneratedSscc');

		const createdObjectVariable = extractSavedVariableFromStepLine('И я создаю объект встроенного языка "СистемнаяИнформация" как "SystemInfo"');
		assert.ok(createdObjectVariable);
		assert.strictEqual(createdObjectVariable?.name, 'SystemInfo');

		const copiedVariable = extractSavedVariableFromStepLine('And I copy the variable "SourceVar" to "CopiedVar"');
		assert.ok(copiedVariable);
		assert.strictEqual(copiedVariable?.name, 'CopiedVar');
		assert.strictEqual(copiedVariable?.value, 'SourceVar');

		const foundOrCreatedVariable = extractSavedVariableFromStepLine('And I find or create "Documents.GoodsReceipt" object named "ReceiptDoc" with initial filling');
		assert.ok(foundOrCreatedVariable);
		assert.strictEqual(foundOrCreatedVariable?.name, 'ReceiptDoc');
		assert.ok(foundOrCreatedVariable?.value.includes('Documents.GoodsReceipt'));

		const generatedMarkingCode = extractSavedVariableFromStepLine('And I generate Chestny Znak marking code for GTIN "123" of type "5"to "MarkingCode" variable (extension)');
		assert.ok(generatedMarkingCode);
		assert.strictEqual(generatedMarkingCode?.name, 'MarkingCode');

		const putToVariable = extractSavedVariableFromStepLine('И я выполняю код и вставляю в переменную "1 + 1" "CalcResult"');
		assert.ok(putToVariable);
		assert.strictEqual(putToVariable?.name, 'CalcResult');
		assert.strictEqual(putToVariable?.value, '1 + 1');

		assert.strictEqual(
			extractSavedVariableFromStepLine('And I save the navigation link of the current window to delete (extension)'),
			null
		);
		assert.strictEqual(
			extractSavedVariableFromStepLine('And I save the value of "FieldName" field with "DocumentNumber" key'),
			null
		);
	});

	test('parseBlockKeyword supports localized control blocks and loop step forms', () => {
		assert.strictEqual(parseBlockKeyword('If "Condition" Then'), 'If');
		assert.strictEqual(parseBlockKeyword('If "Condition" Then:\n | "Value1" |'), 'If');
		assert.strictEqual(parseBlockKeyword('Если "Условие" Тогда'), 'If');
		assert.strictEqual(parseBlockKeyword('Если "Условие" Тогда:\n | "Значение1" |'), 'If');
		assert.strictEqual(parseBlockKeyword('#Если Сервер Тогда'), 'If');
		assert.strictEqual(parseBlockKeyword('ElseIf "Condition" Then'), 'ElseIf');
		assert.strictEqual(parseBlockKeyword('ИначеЕсли "Условие" Тогда'), 'ElseIf');
		assert.strictEqual(parseBlockKeyword('Else'), 'Else');
		assert.strictEqual(parseBlockKeyword('Иначе'), 'Else');
		assert.strictEqual(parseBlockKeyword('EndIf'), 'EndIf');
		assert.strictEqual(parseBlockKeyword('КонецЕсли'), 'EndIf');

		assert.strictEqual(parseBlockKeyword('Do'), 'Do');
		assert.strictEqual(parseBlockKeyword('Цикл'), 'Do');
		assert.strictEqual(parseBlockKeyword('And While "Context.ServiceVariable < 2" 1C:Enterprise script is True I do'), 'Do');
		assert.strictEqual(parseBlockKeyword('And While "Context.ServiceVariable < 2" 1C:Enterprise script is True Then'), 'Do');
		assert.strictEqual(parseBlockKeyword('И пока выражение встроенного языка \'Условие\' истинно я выполняю'), 'Do');
		assert.strictEqual(parseBlockKeyword('И пока выражение встроенного языка \'Условие\' истинно тогда'), 'Do');
		assert.strictEqual(parseBlockKeyword('And for each line of "Table" table I do in reverse order'), 'Do');
		assert.strictEqual(parseBlockKeyword('And for each "Table" table line I execute using column "N"'), 'Do');
		assert.strictEqual(parseBlockKeyword('And for each "CurrentFile" file from "Directory" directory'), 'Do');
		assert.strictEqual(parseBlockKeyword('And for each "ValueFromArray" value from "ArrayWithSemicolonDelimiter" array'), 'Do');
		assert.strictEqual(parseBlockKeyword('And I repeat "10" times'), 'Do');
		assert.strictEqual(parseBlockKeyword('And I open required list form for each line of "MetadataObjectsTable" table'), 'Do');
		assert.strictEqual(parseBlockKeyword('И для каждой строки таблицы "Таблица" я выполняю используя колонку "N"'), 'Do');
		assert.strictEqual(parseBlockKeyword('И для каждого файла "ТекущийФайл" из каталога "ИмяКаталога"'), 'Do');
		assert.strictEqual(parseBlockKeyword('И для каждого значения "ЗначениеИзМассива" из массива "Коллекция"'), 'Do');
		assert.strictEqual(parseBlockKeyword('И я делаю "10" раз'), 'Do');
		assert.strictEqual(parseBlockKeyword('EndDo'), 'EndDo');
		assert.strictEqual(parseBlockKeyword('КонецЦикла'), 'EndDo');

		assert.strictEqual(parseBlockKeyword('Try'), 'Try');
		assert.strictEqual(parseBlockKeyword('Попытка'), 'Try');
		assert.strictEqual(parseBlockKeyword('Except'), 'Except');
		assert.strictEqual(parseBlockKeyword('Исключение'), 'Except');
		assert.strictEqual(parseBlockKeyword('EndTry'), 'EndTry');
		assert.strictEqual(parseBlockKeyword('КонецПопытки'), 'EndTry');

		assert.strictEqual(parseBlockKeyword('Then If dialog box is visible I click "OK" button'), null);
		assert.strictEqual(parseBlockKeyword('Тогда я прерываю цикл'), null);
	});

	test('getBlockClosingKeyword maps opening blocks to localized closing keywords', () => {
		assert.strictEqual(getBlockClosingKeyword(parseBlockKeyword('If "Condition" Then'), 'en'), 'EndIf');
		assert.strictEqual(getBlockClosingKeyword(parseBlockKeyword('Если "Условие" Тогда'), 'ru'), 'КонецЕсли');
		assert.strictEqual(
			getBlockClosingKeyword(parseBlockKeyword('And While "Context.ServiceVariable < 2" 1C:Enterprise script is True I do'), 'en'),
			'EndDo'
		);
		assert.strictEqual(
			getBlockClosingKeyword(parseBlockKeyword('И для каждой строки таблицы "Таблица" я выполняю'), 'ru'),
			'КонецЦикла'
		);
		assert.strictEqual(getBlockClosingKeyword(parseBlockKeyword('Try'), 'en'), 'EndTry');
		assert.strictEqual(getBlockClosingKeyword(parseBlockKeyword('Попытка'), 'ru'), 'КонецПопытки');
		assert.strictEqual(getBlockClosingKeyword(parseBlockKeyword('Else'), 'en'), null);
	});

	test('normalizeMultilineStepInsertText rebases gherkin table rows under the step line', () => {
		assert.strictEqual(
			normalizeMultilineStepInsertText('Если в таблице "%1 ИмяТаблицы" нет строк Тогда\n\t| \'Имя колонки\' |\n\t| \'Значение\' |'),
			'Если в таблице "%1 ИмяТаблицы" нет строк Тогда\n    | \'Имя колонки\' |\n    | \'Значение\' |'
		);
	});

	test('alignGherkinTablesInText aligns tables relative to the preceding step line', () => {
		const scriptText = [
			'        И таблица "Таблица" содержит строки:',
			'| Значение1 | Значение2 |',
			'  | ДлинноеЗначение | X |'
		].join('\n');

		assert.strictEqual(
			alignGherkinTablesInText(scriptText, '\n'),
			[
				'        И таблица "Таблица" содержит строки:',
				'            | Значение1       | Значение2 |',
				'            | ДлинноеЗначение | X         |'
			].join('\n')
		);
	});
});
