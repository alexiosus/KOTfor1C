import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parseCompilerJUnit } from '../src/compilerArtifacts';
import { aggregateCompilerJUnit, compilerReportLinkTarget, upgradeCompilerReportFileLinks, writeCompilerBuildReport } from '../src/compilerBuildReport';
import type { CompilerBuildJob } from '../src/compilerBuildRuntime';
import { resolveCompilerBuildErrorLocation } from '../src/compilerBuildErrorLocation';

const MarkdownIt = require('markdown-it') as new (options?: { html: boolean }) => { render(source: string): string };

function job(root: string, index: number): CompilerBuildJob {
    const directory = path.join(root, String(index));
    return {
        index, total: 2, directory, outputPath: path.join(directory, 'features'),
        parametersPath: path.join(directory, 'parameters.json'), resultPath: path.join(directory, 'result.txt'),
        logPath: path.join(directory, 'log.txt'), errorPath: path.join(directory, 'errors'),
        inventoryPath: path.join(directory, 'compile.txt'), junitPath: path.join(directory, 'junit.xml'), parameters: []
    };
}

const failedJunit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="1" failures="1" errors="0" time="0.5">
 <testsuite name="Compile sale" tests="1" failures="1" time="0.5">
  <properties><property name="uid_scenario" value="sale-uid"/><property name="scenario" value="SALE"/></properties>
  <testcase name="sale-settings" time="0.5"><failure message="Missing &quot;item&quot;">Step not found</failure></testcase>
 </testsuite>
</testsuites>`;

test('aggregate Markdown report exposes every worker result, inventory and JUnit source failure', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compile-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = job(root, 1);
    const second = job(root, 2);
    await fs.mkdir(first.directory, { recursive: true });
    await fs.mkdir(second.directory, { recursive: true });
    await fs.writeFile(first.resultPath, '0');
    await fs.writeFile(first.inventoryPath, '{"scenario_tests":["sale-settings"],"process_tests":["checkout-settings"]}');
    await fs.writeFile(first.junitPath, failedJunit);
    await fs.writeFile(second.resultPath, '1');
    await fs.writeFile(second.logPath, 'Compiler could not start: test failure');
    const target = path.join(root, 'report', 'build.md');
    const sourcePath = path.join(root, 'Sale scenario.yaml');
    await writeCompilerBuildReport([first, second], target, [{ uid: 'sale-uid', code: 'SALE', name: 'Продажа', path: sourcePath }]);
    const report = await fs.readFile(target, 'utf8');
    assert.match(report, /Part 1\/2/u);
    assert.match(report, /Part 2\/2/u);
    assert.match(report, /Result code: 0/u);
    assert.match(report, /Result code: 1/u);
    assert.match(report, /sale-settings/u);
    assert.match(report, /checkout-settings/u);
    assert.match(report, /failed/u);
    assert.match(report, /Missing "item"/u);
    assert.match(report, /Step not found/u);
    assert.match(report, /Compiler could not start: test failure/u);
    assert.ok(report.includes(compilerReportLinkTarget(sourcePath, target)));
    assert.ok(report.includes(compilerReportLinkTarget(second.logPath, target)));
    const html = new MarkdownIt().render(report);
    assert.equal((html.match(/<a href=/gu) ?? []).length, (report.match(/\]\(</gu) ?? []).length,
        'every result, log, inventory, JUnit and source destination must render as an actual link');
});

test('SPPR reports are collected recursively and link unique scenario or process source codes', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compile-errors-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = job(root, 1);
    const nested = path.join(first.errorPath, 'nested');
    await fs.mkdir(nested, { recursive: true });
    const errorPath = path.join(nested, 'Compile_Error_1.xml');
    await fs.writeFile(errorPath, '<Structure><Property name="ТипОшибки"><Value>Ошибка процесса</Value></Property><Property name="ИсходнаяИнформация"><Value>Missing process step</Value></Property><Property name="КодПроцесса"><Value>CHECKOUT</Value></Property></Structure>');
    const sourcePath = path.join(root, 'checkout.yaml');
    const target = path.join(root, 'build.md');
    await writeCompilerBuildReport([first], target, [{ code: 'CHECKOUT', name: 'Checkout', path: sourcePath }]);
    const report = await fs.readFile(target, 'utf8');
    assert.match(report, /Ошибка процесса/u);
    assert.match(report, /Missing process step/u);
    assert.ok(report.includes(compilerReportLinkTarget(errorPath, target)));
    assert.ok(report.includes(compilerReportLinkTarget(sourcePath, target)));
    assert.match(report, /Result code: unavailable/u);
});

test('missing and malformed optional reports preserve failure logs and never claim passing tests', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compile-malformed-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = job(root, 1);
    await fs.mkdir(first.errorPath, { recursive: true });
    await fs.writeFile(first.logPath, 'Compilation failed before writing results');
    await fs.writeFile(first.inventoryPath, '{bad');
    await fs.writeFile(first.junitPath, '<testsuites>');
    await fs.writeFile(path.join(first.errorPath, 'broken.xml'), '<Structure>');
    const target = path.join(root, 'build.md');
    await writeCompilerBuildReport([first], target);
    const report = await fs.readFile(target, 'utf8');
    assert.match(report, /Compilation failed before writing results/u);
    assert.match(report, /unavailable/u);
    assert.match(report, /malformed/iu);
    assert.doesNotMatch(report, /\bpassed\b/u);
});

test('ambiguous source codes do not attach a failure to an arbitrary YAML', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compile-ambiguous-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = job(root, 1);
    await fs.mkdir(first.directory, { recursive: true });
    await fs.writeFile(first.junitPath, failedJunit.replace('sale-uid', 'unknown-uid'));
    const target = path.join(root, 'build.md');
    await writeCompilerBuildReport([first], target, [
        { code: 'SALE', name: 'First', path: path.join(root, 'first.yaml') },
        { code: 'SALE', name: 'Second', path: path.join(root, 'second.yaml') }
    ]);
    const report = await fs.readFile(target, 'utf8');
    assert.doesNotMatch(report, /first\.yaml|second\.yaml/u);
});

test('JUnit aggregation preserves original suites and diagnostic XML without inventing absent workers', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compile-junit-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const jobs = [job(root, 1), job(root, 2), job(root, 3)];
    for (const part of jobs) { await fs.mkdir(part.directory, { recursive: true }); }
    await fs.writeFile(jobs[0].junitPath, failedJunit);
    const secondSuite = '<testsuite name="Compile &gt; process" tests="1" errors="1"><testcase name="startup"><error><![CDATA[Cannot open <compiler>]]></error></testcase></testsuite>';
    await fs.writeFile(jobs[1].junitPath, `<?xml version="1.0"?>${secondSuite}`);
    await fs.writeFile(jobs[2].junitPath, '<testsuites>');
    const target = path.join(root, 'report', 'junit.xml');
    assert.equal(await aggregateCompilerJUnit(jobs, target), true);
    const xml = await fs.readFile(target, 'utf8');
    const report = parseCompilerJUnit(xml);
    assert.ok(report);
    assert.equal(report.summary.tests, 2);
    assert.equal(report.summary.failures, 1);
    assert.equal(report.summary.errors, 1);
    assert.ok(xml.includes(secondSuite));
    assert.ok(xml.includes('Missing &quot;item&quot;'));
    assert.equal((xml.match(/<\?xml/gu) ?? []).length, 1);
});

test('no aggregate JUnit file is written when every worker report is unavailable', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compile-junit-missing-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = path.join(root, 'junit.xml');
    assert.equal(await aggregateCompilerJUnit([job(root, 1)], target), false);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('an unavailable current build removes a stale aggregate from an earlier build', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compile-junit-stale-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = path.join(root, 'junit.xml');
    await fs.writeFile(target, '<testsuites tests="1"><testsuite><testcase name="old success"/></testsuite></testsuites>');
    assert.equal(await aggregateCompilerJUnit([job(root, 1)], target), false);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('JUnit aggregation carries root namespace declarations onto the preserved suites', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compile-junit-namespaces-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = job(root, 1);
    await fs.mkdir(first.directory, { recursive: true });
    await fs.writeFile(first.junitPath, '<j:testsuites xmlns:j="urn:junit" xmlns:extra="urn:extra"><j:testsuite name="namespaced"><j:testcase name="case"><j:failure extra:note="original">Broken</j:failure></j:testcase></j:testsuite></j:testsuites>');
    const target = path.join(root, 'aggregate.xml');
    assert.equal(await aggregateCompilerJUnit([first], target), true);
    const xml = await fs.readFile(target, 'utf8');
    assert.match(xml, /<j:testsuite xmlns:j="urn:junit" xmlns:extra="urn:extra"/u);
    assert.equal(parseCompilerJUnit(xml)?.entries[0].status, 'failed');
});

test('parameter binding failures link to the exact YAML body line rather than a BSL module line', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-report-line-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = job(root, 1); await fs.mkdir(first.directory, { recursive: true });
    const sourcePath = path.join(root, 'Scenario #1.yaml');
    await fs.writeFile(sourcePath, 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "sale-uid"\nТекстСценария: |\n    And Child\n        LOL = "value"\n');
    await fs.writeFile(first.junitPath, failedJunit.replace('Missing &quot;item&quot;', '{ObjectModule(5609)}: В подсценарии &lt;And Child&gt; нет параметра с именем &lt;LOL&gt;.'));
    const target = path.join(root, 'report.md');
    await writeCompilerBuildReport([first], target, [{ uid: 'sale-uid', code: 'SALE', name: 'Sale', path: sourcePath }]);
    const report = await fs.readFile(target, 'utf8');
    assert.match(report, /Scenario%20%231\.yaml#L6/u);
    assert.doesNotMatch(report, /#L5609/u);
    assert.match(new MarkdownIt().render(report), /<a href="Scenario%20%231\.yaml#L6">Sale:6<\/a>/u);
});

test('report links are relative to the report and identical across Windows, macOS and UNC checkouts', () => {
    const expected = '../../tests/Parent%20scenarios/A_%231/scen.yaml#L170';
    assert.equal(compilerReportLinkTarget('C:\\checkout\\tests\\Parent scenarios\\A_#1\\scen.yaml', 'C:\\checkout\\.vscode\\kot-runtime\\compiler-build-report.md', 170), expected);
    assert.equal(compilerReportLinkTarget('/Users/qa/checkout/tests/Parent scenarios/A_#1/scen.yaml', '/Users/qa/checkout/.vscode/kot-runtime/compiler-build-report.md', 170), expected);
    assert.equal(compilerReportLinkTarget('\\\\server\\share\\checkout\\tests\\Parent scenarios\\A_#1\\scen.yaml', '\\\\server\\share\\checkout\\.vscode\\kot-runtime\\compiler-build-report.md', 170), expected);
    assert.equal(compilerReportLinkTarget('/tests/a (b) #1.yaml', '/tests/report.md', 2), 'a%20(b)%20%231.yaml#L2');
    const renderer = new MarkdownIt();
    assert.match(renderer.render(`[Test:170](<${expected}>)`), /<a href="\.\.\/\.\.\/tests\/Parent%20scenarios\/A_%231\/scen.yaml#L170">Test:170<\/a>/u);
});

test('opening old reports converts native paths, file URLs and VS Code URLs to report-relative Markdown links', () => {
    const reportPath = 'C:\\Mac\\Home\\.vscode\\kot-runtime\\compiler-build-report.md';
    const legacy = 'Source: [Test:170](<C:\\Mac\\Home\\Parent scenarios\\A_%231\\scen.yaml#L170>)';
    const fileUrl = 'Source: [Test:170](<file:///C:/Mac/Home/Parent%20scenarios/A_%231/scen.yaml#L170>)';
    const vscodeUrl = 'Source: [Test:170](<vscode://file/C:/Mac/Home/Parent%20scenarios/A_%231/scen.yaml:170:1>)';
    const updated = 'Source: [Test:170](<../../Parent%20scenarios/A_%231/scen.yaml#L170>)';
    for (const previous of [legacy, fileUrl, vscodeUrl, updated]) {
        assert.equal(upgradeCompilerReportFileLinks(previous, reportPath), updated);
    }
});

test('a Windows report resolves to the current macOS checkout using its worker-artifact location', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-portable-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const reportPath = path.join(root, '.vscode/kot-runtime/compiler-build-report.md');
    const sourcePath = path.join(root, 'tests/Parent scenarios/scen.yaml');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true }); await fs.writeFile(sourcePath, 'Current checkout');
    const old = 'Log: [compiler log](<vscode://file/c:/Mac/Home/checkout/.vscode/kot-runtime/compiler-parts/1/yaml_build_log.txt>)\n\n'
        + 'Source: [Test:163](<vscode://file/c:/Mac/Home/checkout/tests/Parent%20scenarios/scen.yaml:163:1>)';
    const updated = upgradeCompilerReportFileLinks(old, reportPath);
    const html = new MarkdownIt().render(updated);
    const href = /<a href="([^"]+)">Test:163<\/a>/u.exec(html)?.[1];
    assert.equal(href, '../../tests/Parent%20scenarios/scen.yaml#L163');
    const resolved = new URL(href!, pathToFileURL(reportPath));
    assert.equal(fileURLToPath(resolved), sourcePath);
    assert.equal(resolved.hash, '#L163');
    assert.equal(await fs.readFile(fileURLToPath(resolved), 'utf8'), 'Current checkout');
    assert.match(updated, /\[compiler log\]\(<compiler-parts\/1\/yaml_build_log\.txt>\)/u);
    assert.doesNotMatch(updated, /vscode:|file:|c:\//iu);
});

test('preflight reports include each affected YAML line with the compiler restriction', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-preflight-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = path.join(root, 'report.md');
    await writeCompilerBuildReport([], target, [], [{ code: 'compilerFormat', severity: 'warning', uri: 'file:///repo/scen.yaml', message: 'Format issues',
        formatIssues: [{ kind: 'scalar', line: 18, startCharacter: 0, endCharacter: 1 }, { kind: 'indentation', line: 19, startCharacter: 0, endCharacter: 2 }] }]);
    const report = await fs.readFile(target, 'utf8');
    assert.match(report, /scen\.yaml#L19/); assert.match(report, /scen\.yaml#L20/);
    assert.match(report, /Quote scalar/); assert.match(report, /four spaces/);
});

test('nested stack frames with equal line numbers resolve to the child YAML, not the root settings source', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-nested-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = job(root, 1); await fs.mkdir(first.directory, { recursive: true });
    const parent = path.join(root, 'Parent.yaml'); const child = path.join(root, 'Child.yaml');
    await fs.writeFile(parent, 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "sale-uid"\nВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: "child-uid"\n        ИмяСценария: "Child"\nТекстСценария: |\n    And Child\n');
    await fs.writeFile(child, 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "child-uid"\nТекстСценария: |\n    And Unknown\n');
    await fs.writeFile(first.junitPath, failedJunit.replace('Step not found', 'Строка №1. And Child\n    Строка №1. &lt;And Unknown&gt;'));
    const target = path.join(root, 'report.md');
    await writeCompilerBuildReport([first], target, [{ uid: 'sale-uid', code: 'SALE', name: 'Parent', path: parent }, { uid: 'child-uid', name: 'Child', path: child }]);
    const report = await fs.readFile(target, 'utf8');
    assert.match(report, /Child\.yaml#L5/u);
    assert.doesNotMatch(report, /Parent\.yaml#L/u);
    const sources = [{ uid: 'sale-uid', name: 'Parent', path: parent }, { uid: 'child-uid', name: 'Child', path: child }];
    const stack = 'Строка №1. And Child\n    Строка №1. <And Unknown>';
    assert.deepEqual(await resolveCompilerBuildErrorLocation(sources, sources[0], `${stack}\nError details:\n${stack}`), { source: sources[1], line: 5 });
    assert.equal(await resolveCompilerBuildErrorLocation(sources, sources[0], '    Строка №1. <And Child>'), null, 'a detached child frame is not a root stack');
});

test('a parameter error in a nested source resolves its binding even when the compiler identifies the root', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-nested-binding-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const parent = { uid: 'parent', name: 'Parent', path: path.join(root, 'Parent.yaml') };
    const child = { uid: 'child', name: 'Child', path: path.join(root, 'Child.yaml') };
    await fs.writeFile(parent.path, 'ВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: "child"\n        ИмяСценария: "Child"\nТекстСценария: |\n    And Child\n');
    await fs.writeFile(child.path, 'ТекстСценария: |\n    And Grandchild\n        Missing = "value"\n');
    const error = 'В подсценарии <And Grandchild> нет параметра с именем <Missing>.';
    assert.deepEqual(await resolveCompilerBuildErrorLocation([parent, child], parent, error), { source: child, line: 3 });
    await fs.writeFile(parent.path, 'ВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: "child"\n        ИмяСценария: "Child"\nТекстСценария: |\n    And Child\n    And Grandchild\n        Missing = "value"\n');
    assert.equal(await resolveCompilerBuildErrorLocation([parent, child], parent, error), null, 'multiple matching bindings must not select an arbitrary source');
});

test('an unresolved nested declaration never turns a child stack frame into a root line link', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-unresolved-stack-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const parent = { uid: 'parent', name: 'Parent', path: path.join(root, 'Parent.yaml') };
    await fs.writeFile(parent.path, 'ВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: "unavailable"\n        ИмяСценария: "Child"\nТекстСценария: |\n    And Child\n    And Unknown\n');
    assert.equal(await resolveCompilerBuildErrorLocation([parent], parent, 'Строка №1. And Child\n    Строка №2. And Unknown'), null);
});

test('native SPPR compilation failures link to the exact feature line in JUnit and SPPR reports', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-native-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const [reporter, eol] of [['junit', '\r\n'], ['sppr', '\n']]) {
        await t.test(reporter, async () => {
            const directory = path.join(root, reporter); await fs.mkdir(directory);
            const metadata = path.join(directory, 'meta.yaml');
            await fs.writeFile(metadata, ['ТипФайла: "Сценарий"', 'ДанныеСценария:', '    UID: "sale-uid"', ''].join(eol));
            await fs.writeFile(path.join(directory, 'scen.feature'), ['#language: en', '', 'And Unknown', ''].join(eol));
            const first = job(directory, 1); await fs.mkdir(first.errorPath, { recursive: true });
            const message = 'Строка №3. &lt;And Unknown&gt;';
            if (reporter === 'junit') {
                await fs.writeFile(first.junitPath, failedJunit.replace('Step not found', message));
            } else {
                await fs.writeFile(path.join(first.errorPath, 'error.xml'), '<Structure><Property name="ИсходнаяИнформация"><Value>'
                    + message + '</Value></Property><Property name="КодСценария"><Value>SALE</Value></Property></Structure>');
            }
            const target = path.join(directory, 'report.md');
            await writeCompilerBuildReport([first], target, [{ uid: 'sale-uid', code: 'SALE', name: 'Sale', path: metadata }]);
            const report = await fs.readFile(target, 'utf8');
            assert.match(report, /Source: \[Sale:3\]\(<scen\.feature#L3>\)/u);
            assert.match(new MarkdownIt().render(report), /<a href="scen\.feature#L3">Sale:3<\/a>/u);
            assert.doesNotMatch(report, /\]\(<meta\.yaml/u);
        });
    }
});

test('native SPPR parameter binding failures use feature coordinates without the metadata offset', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-native-binding-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = { uid: 'sale-uid', name: 'Sale', path: path.join(root, 'meta.yaml') };
    await fs.writeFile(source.path, 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "sale-uid"\n');
    const script = path.join(root, 'scen.feature');
    await fs.writeFile(script, '#language: en\n\nAnd Child\n    Missing = "value"\n');
    assert.deepEqual(await resolveCompilerBuildErrorLocation([source], source,
        '{ObjectModule(5609)}: В подсценарии <And Child> нет параметра с именем <Missing>.'),
    { source: { ...source, path: script }, line: 4 });
});

test('a compiler body line number without a stack resolves to the native script', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-native-body-line-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = { uid: 'sale-uid', name: 'Sale', path: path.join(root, 'meta.yaml') };
    await fs.writeFile(source.path, 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "sale-uid"');
    const script = path.join(root, 'scen.feature');
    await fs.writeFile(script, '#language: en\n\nAnd Unknown\n');
    assert.deepEqual(await resolveCompilerBuildErrorLocation([source], source, 'Unknown step at line 3:'),
        { source: { ...source, path: script }, line: 3 });
});

test('compiler error stacks follow nested declarations across native and legacy SPPR sources', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-native-nested-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const nativeParent of [true, false]) {
        await t.test(nativeParent ? 'native parent' : 'native child', async () => {
            const directory = path.join(root, String(nativeParent));
            const parentDirectory = path.join(directory, 'Parent'); const childDirectory = path.join(directory, 'Child');
            await fs.mkdir(parentDirectory, { recursive: true }); await fs.mkdir(childDirectory);
            const parent = { uid: 'parent', name: 'Parent', path: path.join(parentDirectory, nativeParent ? 'meta.yaml' : 'scen.yaml') };
            const child = { uid: 'child', name: 'Child', path: path.join(childDirectory, nativeParent ? 'scen.yaml' : 'meta.yaml') };
            const parentMetadata = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "parent"\nВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: "child"\n        ИмяСценария: "Child"\n';
            const childMetadata = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "child"\n';
            await fs.writeFile(parent.path, parentMetadata + (nativeParent ? '' : 'ТекстСценария: |\n    And Child\n'));
            await fs.writeFile(child.path, childMetadata + (nativeParent ? 'ТекстСценария: |\n    And Unknown\n' : ''));
            await fs.writeFile(path.join(nativeParent ? parentDirectory : childDirectory, 'scen.feature'),
                nativeParent ? '#language: en\n\nAnd Child\n' : '#language: en\n\nAnd Unknown\n');
            assert.deepEqual(await resolveCompilerBuildErrorLocation([parent, child], parent,
                `Строка №${nativeParent ? 3 : 1}. And Child\n    Строка №${nativeParent ? 1 : 3}. <And Unknown>`),
            { source: nativeParent ? child : { ...child, path: path.join(childDirectory, 'scen.feature') }, line: nativeParent ? 5 : 3 });
        });
    }
});

test('a missing native script keeps the metadata fallback rather than inventing an error line', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-native-missing-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = { uid: 'sale-uid', name: 'Sale', path: path.join(root, 'meta.yaml') };
    await fs.writeFile(source.path, 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "sale-uid"\n');
    assert.equal(await resolveCompilerBuildErrorLocation([source], source, 'Строка №3. And Unknown'), null);
    const first = job(root, 1); await fs.mkdir(first.directory);
    await fs.writeFile(first.junitPath, failedJunit.replace('Step not found', 'Строка №3. And Unknown'));
    const target = path.join(root, 'report.md');
    await writeCompilerBuildReport([first], target, [source]);
    assert.match(await fs.readFile(target, 'utf8'), /Source: \[Sale\]\(<meta\.yaml>\)/u);
});

test('SPPR missing-keyword diagnostics link their quoted source line, including a source with nested declarations', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-missing-keyword-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const metadata = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "sale-uid"\nВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: "child"\n        ИмяСценария: "I prepare workshop customer"\n';
    const script = '#language: en\n# SPPR script fragment\n\nAnd I prepare workshop customer\n    Customer = [Customer]\nAnd I remember workshop message "Native source is ready"\n\nWrong line\n';
    const diagnostic = 'Строка №8. Не найдено ключевое слово в начале строки. &lt;Wrong line&gt;';
    for (const native of [true, false]) {
        await t.test(native ? 'feature + meta' : 'embedded YAML', async () => {
            const directory = path.join(root, String(native)); await fs.mkdir(directory);
            const source = { uid: 'sale-uid', code: 'SALE', name: 'Sale', path: path.join(directory, native ? 'meta.yaml' : 'scen.yaml') };
            await fs.writeFile(source.path, metadata + (native ? '' : 'ТекстСценария: |\n' + script.replace(/[^\r\n]+/gu, line => '    ' + line)));
            if (native) { await fs.writeFile(path.join(directory, 'scen.feature'), script); }
            const first = job(directory, 1); await fs.mkdir(first.errorPath, { recursive: true });
            await fs.writeFile(first.junitPath, failedJunit.replace('Step not found', diagnostic));
            await fs.writeFile(path.join(first.errorPath, 'error.xml'), '<Structure><Property name="КодСценария"><Value>SALE</Value></Property>'
                + '<Property name="ИсходнаяИнформация"><Value>' + diagnostic + '</Value></Property>'
                + '<Property name="ОбъектыМетаданных"><Value><Value><Property name="УточнениеРасположения"><Value>{ObjectModule(4568)}: '
                + diagnostic + '</Value></Property></Value></Value></Property></Structure>');
            const target = path.join(directory, 'report.md');
            await writeCompilerBuildReport([first], target, [source]);
            const report = await fs.readFile(target, 'utf8');
            const expected = native ? 'Source: [Sale:8](<scen.feature#L8>)' : 'Source: [Sale:16](<scen.yaml#L16>)';
            assert.equal(report.split(expected).length - 1, 1, 'JUnit and SPPR diagnostics must share one source link');
            assert.doesNotMatch(report, /\]\(<meta\.yaml/u);
            assert.equal(await resolveCompilerBuildErrorLocation([source], source,
                'Строка №8. Не найдено ключевое слово в начале строки. <A different line>'), null,
            'a diagnostic that disagrees with saved source must not produce a line link');
        });
    }
});

test('build report leads with actionable errors, merges duplicate diagnostics and folds technical details', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-readable-build-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = job(root, 1); await fs.mkdir(first.errorPath, { recursive: true });
    await fs.writeFile(first.resultPath, '0');
    const source = { uid: 'sale-uid', code: 'SALE', name: 'Sale', path: path.join(root, 'meta.yaml') };
    await fs.writeFile(source.path, 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "sale-uid"\n');
    await fs.writeFile(path.join(root, 'scen.feature'), '#language: en\n\nWrong line\n');
    const diagnostic = 'Строка №3. Не найдено ключевое слово в начале строки. &lt;Wrong line&gt;';
    const details = diagnostic + '\n{ObjectModule(4568)}:InternalCompilerCall();';
    await fs.writeFile(first.junitPath, failedJunit.replace('Step not found', details)
        .replace('</testsuite>', '<testcase name="ready-settings"/></testsuite>').replace('tests="1"', 'tests="2"'));
    await fs.writeFile(path.join(first.errorPath, 'error.xml'), '<Structure><Property name="КодСценария"><Value>SALE</Value></Property>'
        + '<Property name="ИсходнаяИнформация"><Value>' + details + '</Value></Property></Structure>');
    const target = path.join(root, 'report.md');
    await writeCompilerBuildReport([first], target, [source]);
    const report = await fs.readFile(target, 'utf8');
    assert.match(report, /^# Build report\n/u);
    assert.match(report, /Compiled: 1 · With errors: 1 · Skipped: 0/u);
    assert.ok(report.indexOf('## Errors to fix') < report.indexOf('## Compilation results'));
    assert.ok(report.indexOf('scen.feature#L3') < report.indexOf('<details>'));
    assert.equal((report.match(/^### .*Sale/gmu) ?? []).length, 1, 'JUnit and SPPR must produce one actionable error');
    assert.ok(report.indexOf('InternalCompilerCall') > report.indexOf('<summary>Technical details</summary>'));
    assert.match(report, /\| Test \| Compilation \| Source \|/u);
    const html = new MarkdownIt({ html: true }).render(report);
    assert.match(html, /<details>\s*<summary>Technical details<\/summary>/u);
    assert.match(html, /<a href="scen\.feature#L3">/u);
    assert.doesNotMatch(report.slice(0, report.indexOf('## Compilation results')), /\]\(<meta\.yaml/u);
});

test('build report distinguishes complete compilation from unavailable worker results', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-incomplete-build-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = job(root, 1); await fs.mkdir(first.directory);
    await fs.writeFile(first.resultPath, '0');
    await fs.writeFile(first.junitPath, '<testsuite tests="1"><testcase name="Ready"/></testsuite>');
    const target = path.join(root, 'report.md');
    await writeCompilerBuildReport([first, job(root, 2)], target);
    const report = await fs.readFile(target, 'utf8');
    assert.match(report, /Build results are incomplete/u);
    assert.match(report, /Compiled: 1 · With errors: 0 · Skipped: 0/u);
    assert.doesNotMatch(report, /✅ Compilation completed/u);
});

test('report presentation uses the supplied interface translations while preserving compiler diagnostics', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-localized-build-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = job(root, 1); await fs.mkdir(first.directory);
    await fs.writeFile(first.resultPath, '0'); await fs.writeFile(first.junitPath, failedJunit);
    const translations = JSON.parse(await fs.readFile(path.resolve('l10n/bundle.l10n.ru.json'), 'utf8')) as Record<string, string>;
    const translate = (message: string, ...args: string[]) => (translations[message] ?? message)
        .replace(/\{(\d+)\}/gu, (_, index: string) => args[Number(index)] ?? '');
    const target = path.join(root, 'report.md');
    await writeCompilerBuildReport([first], target, [], [], translate);
    const report = await fs.readFile(target, 'utf8');
    assert.match(report, /^# Отчёт о сборке\n/u);
    assert.match(report, /## Ошибки сборки/u);
    assert.match(report, /## Результаты компиляции/u);
    assert.match(report, /<summary>Технические детали<\/summary>/u);
    assert.match(report, /Step not found/u);
});

test('readable report preserves skipped reasons and keeps names with pipes inside one table cell', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-skipped-build-report-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = job(root, 1); await fs.mkdir(first.directory);
    await fs.writeFile(first.resultPath, '0');
    await fs.writeFile(first.junitPath, '<testsuite tests="1" skipped="1"><testcase name="Optional | variant">'
        + '<skipped message="Disabled in configuration">The required condition is absent.</skipped></testcase></testsuite>');
    const target = path.join(root, 'report.md');
    await writeCompilerBuildReport([first], target);
    const report = await fs.readFile(target, 'utf8');
    assert.match(report, /Compiled: 0 · With errors: 0 · Skipped: 1/u);
    assert.match(report, /Disabled in configuration/u);
    assert.match(report, /The required condition is absent\./u);
    const html = new MarkdownIt({ html: true }).render(report);
    assert.match(html, /<td>Optional \| variant<\/td>/u);
    assert.doesNotMatch(report, /## Errors to fix/u);
});
