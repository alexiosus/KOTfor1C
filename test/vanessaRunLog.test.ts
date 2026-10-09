import assert from 'node:assert/strict';
import test from 'node:test';
import {
    areScenarioNamesEqual,
    extractFailedStepDetails,
    extractFailedSummaryFromLogLine,
    extractFeatureLineNumberFromRunLogLine,
    extractFeaturePathFromRunLogLine,
    extractLastStepLocation,
    extractScenarioNameFromRunLogLine,
    isRunLogStepCompatibleWithFeatureLine
} from '../src/vanessaRunLog';

test('run-log metadata parser accepts Russian and English markers with Windows and Unix paths', () => {
    assert.equal(
        extractFeaturePathFromRunLogLine('  Фича: "C:\\build\\features\\sale.feature"  '),
        'C:\\build\\features\\sale.feature'
    );
    assert.equal(
        extractFeaturePathFromRunLogLine('FullPathToFeature: \'/tmp/build/sale.feature\''),
        '/tmp/build/sale.feature'
    );
    assert.equal(extractScenarioNameFromRunLogLine('ScenarioName: "Create sale"'), 'Create sale');
    assert.equal(extractScenarioNameFromRunLogLine('ordinary log line'), undefined);
    assert.equal(areScenarioNamesEqual(' "Create sale" ', 'create SALE'), true);
});

test('run-log line parser recognizes current Russian and English step location formats', () => {
    assert.equal(extractFeatureLineNumberFromRunLogLine('14/09/2026 10:20:30 (42). Шаг: И нажимаю'), 42);
    assert.equal(extractFeatureLineNumberFromRunLogLine('FeatureLineNumber: 17'), 17);
    assert.equal(extractFeatureLineNumberFromRunLogLine('(9) Given I open the application'), 9);
    assert.equal(extractFeatureLineNumberFromRunLogLine('8) Step: Then I close the application'), 8);
    assert.equal(extractFeatureLineNumberFromRunLogLine('FeatureLineNumber: 0'), undefined);
});

test('failure parser selects the latest failed-step block for the requested scenario', () => {
    const content = [
        'Сценарий: Other scenario',
        'Failed: 4',
        'Сценарий: "Target scenario"',
        '14/09/2026 10:20:30 (42). Шаг: И нажимаю кнопку',
        'Шаг (И нажимаю кнопку) не выполнен',
        '    Ошибка выполнения',
        '    Детали ошибки',
        'ErrorFileJson: /tmp/error.json',
        'Scenario: Later scenario',
        'Failed: 2'
    ].join('\n');

    assert.deepEqual(extractFailedStepDetails(content, { scenarioName: 'target SCENARIO' }), {
        failureSummary: 'Шаг (И нажимаю кнопку) не выполнен',
        failureDetails: 'Ошибка выполнения\n    Детали ошибки\nErrorFileJson: /tmp/error.json',
        failureStepDescription: 'И нажимаю кнопку'
    });
});

test('failure parser preserves a summary-only failure and supports logs without scenario markers', () => {
    assert.deepEqual(extractFailedStepDetails('Failed: 2\n', { scenarioName: 'Missing marker' }), {
        failureSummary: 'Failed: 2',
        failureDetails: undefined,
        failureStepDescription: undefined
    });
    assert.deepEqual(extractFailedSummaryFromLogLine(' Failed: 0 '), {
        failedCount: 0,
        summaryLine: 'Failed: 0'
    });
});

test('last-step parser keeps the feature belonging to the requested scenario', () => {
    const content = [
        'Feature: "C:\\features\\other.feature"',
        'Scenario: Other scenario',
        '(11). Step: Given other step',
        'ПолныйПутьКФиче: \'/tmp/features/target.feature\'',
        'ИмяСценария: Target scenario',
        '14/09/2026 10:20:30 (27). Шаг: И выполняю шаг'
    ].join('\n');

    assert.deepEqual(extractLastStepLocation(content, { scenarioName: 'Target scenario' }), {
        featurePath: '/tmp/features/target.feature',
        featureLineNumber: 27
    });
});

test('last-step parser returns the latest location when scenario markers are absent', () => {
    const content = [
        'Feature: /tmp/features/no-marker.feature',
        '(3) Given first step',
        '(5) Then last step'
    ].join('\n');

    assert.deepEqual(extractLastStepLocation(content, { scenarioName: 'Expected scenario' }), {
        featurePath: '/tmp/features/no-marker.feature',
        featureLineNumber: 5
    });
});

test('live-step parser ignores exported-scenario coordinates and counts repeated loop visits', () => {
    const featureContent = [
        'Feature: Production',
        'Scenario: 004_Production',
        '    And I prepare production data',
        '    And While "$LineNumber$ < $ItemsCount$" 1C:Enterprise script is True Then',
        '        And I save "$LineNumber$+1" in "LineNumber" variable'
    ].join('\n');
    const content = [
        'Feature: /tmp/features/004_Production.feature',
        'Scenario: 004_Production',
        '10/1/2026 2:50:03 PM (3). Step: And I prepare production data',
        '10/1/2026 2:50:04 PM (1). Step: Then "Product (create)" window is opened',
        '10/1/2026 2:50:04 PM (2). Step: And Delay "0.3"',
        '10/1/2026 2:50:05 PM (4). Step: And While "$LineNumber$ < $ItemsCount$" 1C:Enterprise script is True Then',
        '10/1/2026 2:50:06 PM (5). Step: And I save "$LineNumber$+1" in "LineNumber" variable',
        '10/1/2026 2:50:07 PM (4). Step: And While "$LineNumber$ < $ItemsCount$" 1C:Enterprise script is True Then'
    ].join('\n');

    assert.equal(
        isRunLogStepCompatibleWithFeatureLine(
            '10/1/2026 2:50:04 PM (1). Step: Then "Product (create)" window is opened',
            'Feature: Production'
        ),
        false
    );
    assert.equal(
        isRunLogStepCompatibleWithFeatureLine(
            '10/1/2026 2:50:07 PM (4). Step: And While "$LineNumber$ < $ItemsCount$" 1C:Enterprise script is True Then',
            '    And While "$LineNumber$ < $ItemsCount$" 1C:Enterprise script is True Then'
        ),
        true
    );
    assert.deepEqual(extractLastStepLocation(content, {
        scenarioName: '004_Production',
        featureContent
    }), {
        featurePath: '/tmp/features/004_Production.feature',
        featureLineNumber: 4,
        iteration: 2
    });
});
