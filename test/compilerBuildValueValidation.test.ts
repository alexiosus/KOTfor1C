import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCompilerBuildValueIssues, getCompilerBuildValueHint } from '../src/compilerBuildValueValidation';
import type { CompilerBuildParameter } from '../src/compilerBuildParameters';

const rows = (key: string, value: string): CompilerBuildParameter[] => [{ key, value }];

test('compiler Boolean values accept the documented English and Russian spellings', () => {
    for (const key of ['AuthCompile', 'CreateJson', 'CreateJUnit', 'DebugMode', 'CaptureScreen', 'SplitFeatureFiles', 'ScenarioFilterHasPriority']) {
        for (const value of ['True', 'false', ' Истина ', 'ЛОЖЬ']) { assert.deepEqual(collectCompilerBuildValueIssues(rows(key, value)), []); }
        for (const value of ['yes', '1', '0']) { assert.equal(collectCompilerBuildValueIssues(rows(key, value))[0]?.code, 'invalidBoolean', `${key}=${value}`); }
    }
});

test('blank Boolean values are allowed only when the compiler keeps a default or explicitly disables auth', () => {
    for (const key of ['AuthCompile', 'CaptureScreen', 'UseScreenshotComponent', 'UseExternalComponent', 'PidInformation', 'AllureReport', 'SafeStepsExecution', 'JUnitReport', 'CucumberReport', 'SpprReport']) {
        assert.deepEqual(collectCompilerBuildValueIssues(rows(key, '')), [], key);
    }
    for (const key of ['CreateJson', 'CreateJUnit', 'ExternalMode', 'CreateModellingXml', 'DebugMode', 'SeveralScenariosInOneFile', 'ScenarioFilterHasPriority', 'SplitFeatureFiles']) {
        assert.equal(collectCompilerBuildValueIssues(rows(key, ''))[0]?.code, 'invalidBoolean', key);
    }
    assert.deepEqual(collectCompilerBuildValueIssues([]), []);
});

test('TestClient ports accept the default blank and integers from 1 through 65535', () => {
    for (const value of ['', '1', '48000', '65535']) { assert.deepEqual(collectCompilerBuildValueIssues(rows('TestClientPort', value)), []); }
    for (const value of ['0', '-1', '65536', '1.5', 'Infinity', '0x80', 'bad']) { assert.equal(collectCompilerBuildValueIssues(rows('TestClientPort', value))[0]?.code, 'invalidPort', value); }
});

test('timeouts allow finite nonnegative numbers and attempts require positive safe integers', () => {
    for (const key of ['PauseOnWindowsOpening', 'WaitWindowTime', 'TimeoutForAsyncSteps', 'TimeoutTestClientStart']) {
        for (const value of ['', '0', '0.5', '120']) { assert.deepEqual(collectCompilerBuildValueIssues(rows(key, value)), []); }
        for (const value of ['-0.5', 'NaN', 'Infinity', '1e999', 'bad']) { assert.equal(collectCompilerBuildValueIssues(rows(key, value))[0]?.code, 'invalidNonnegativeNumber'); }
    }
    for (const value of ['', '1', '5']) { assert.deepEqual(collectCompilerBuildValueIssues(rows('NumberOfAttempts', value)), []); }
    for (const value of ['0', '-1', '1.5', '9007199254740992']) { assert.equal(collectCompilerBuildValueIssues(rows('NumberOfAttempts', value))[0]?.code, 'invalidPositiveInteger'); }
});

test('effective partition aliases match runtime precedence and integer clamp policy', () => {
    assert.deepEqual(collectCompilerBuildValueIssues([
        { key: 'ThreadsCount', value: 'bad' }, { key: 'ThreadTotal', value: '2' },
        { key: 'ThreadNumber', value: 'bad' }, { key: 'ThreadIndex', value: '1' }
    ]), []);
    assert.deepEqual(collectCompilerBuildValueIssues([{ key: 'ThreadsCount', value: '2' }, { key: 'ThreadTotal', value: '' }, { key: 'ThreadIndex', value: '' }, { key: 'ThreadNumber', value: '0' }]), []);
    for (const value of ['0', '-1', '1.5', '9007199254740992', 'Infinity']) { assert.equal(collectCompilerBuildValueIssues(rows('ThreadTotal', value))[0]?.code, 'invalidPartitionCount'); }
    for (const value of ['-99', '0', '99']) { assert.deepEqual(collectCompilerBuildValueIssues(rows('ThreadIndex', value)), []); }
    for (const key of ['ThreadIndex', 'ThreadNumber']) { assert.equal(collectCompilerBuildValueIssues(rows(key, '1.5'))[0]?.code, 'invalidPartitionIndex'); }
});

test('DetectionTime accepts complete XML dateTimes with real calendars and optional timezones', () => {
    for (const value of ['', '0001-01-01T00:00:00', '2024-02-29T12:30:00Z', '2000-02-29T12:30:00.123+14:00', '2026-10-15T12:30:00-05:30', '2026-12-31T24:00:00']) {
        assert.deepEqual(collectCompilerBuildValueIssues(rows('DetectionTime', value)), [], value);
    }
    for (const value of ['2026-02-29T12:30:00', '1900-02-29T00:00:00', '2026-04-31T00:00:00', '2026-13-01T00:00:00', '0000-01-01T00:00:00', '2026-10-15', '2026-10-15T12:30', '2026-10-15 12:30:00', '2026-10-15T24:00:01', '2026-10-15T12:60:00', '2026-10-15T12:30:60', '2026-10-15T12:30:00+14:01', '2026-10-15T12:30:00+15:00']) {
        assert.equal(collectCompilerBuildValueIssues(rows('DetectionTime', value))[0]?.code, 'invalidXmlDateTime', value);
    }
});

test('last normalized duplicate wins and custom values are preserved without appearing in errors', () => {
    const parameters = Object.freeze([
        Object.freeze({ key: 'Test_Client-Port', value: 'bad' }), Object.freeze({ key: 'testclientport', value: '48000' }),
        Object.freeze({ key: 'Custom', value: 'opaque-password=synthetic-secret' }), Object.freeze({ key: 'DetectionTime', value: 'opaque-password=synthetic-secret' })
    ]);
    const issues = collectCompilerBuildValueIssues(parameters);
    assert.equal(issues.length, 1); assert.equal(issues[0].parameter, 'DetectionTime');
    assert.doesNotMatch(issues[0].message, /synthetic-secret|opaque-password/);
    assert.equal(parameters[0].value, 'bad'); assert.equal(parameters[2].value, 'opaque-password=synthetic-secret');
});

test('typed metadata exposes native numeric bounds without treating custom values as typed', () => {
    assert.deepEqual(getCompilerBuildValueHint('Test_Client_Port'), { valueKind: 'number', min: 1, max: 65535, step: 1, allowBlank: true });
    assert.equal(getCompilerBuildValueHint('DebugMode')?.valueKind, 'boolean');
    assert.equal(getCompilerBuildValueHint('DetectionTime')?.valueKind, 'xmlDateTime');
    assert.equal(getCompilerBuildValueHint('WaitWindowTime')?.step, 'any');
    assert.equal(getCompilerBuildValueHint('Custom'), undefined);
});
