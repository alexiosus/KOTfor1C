import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCompilerBuildErrorLocation } from './compilerBuildErrorLocation';
import type { CompilerBuildPreflightIssue } from './compilerBuildPreflight';
import {
    extractCompilerJUnitSuitesXml,
    parseCompileInventory,
    parseCompilerErrorXml,
    parseCompilerJUnit
} from './compilerArtifacts';
import type { CompilerBuildJob } from './compilerBuildRuntime';

export interface CompilerBuildReportSource {
    readonly uid?: string;
    readonly code?: string;
    readonly name: string;
    readonly path: string;
}

async function readOptional(file: string): Promise<string | undefined> {
    try { return await fs.readFile(file, 'utf8'); }
    catch { return undefined; }
}

function markdown(value: string): string {
    return value.replace(/[\\`*_\[\]<>|]/gu, character => `\\${character}`);
}

function pathApi(file: string): typeof path.posix {
    return /^(?:[a-z]:[\\/]|\\\\)/iu.test(file) ? path.win32 : path.posix;
}

export function compilerReportLinkTarget(file: string, reportPath: string, line?: number): string {
    const api = pathApi(reportPath);
    if (api === pathApi(file)) {
        const relative = api.relative(api.dirname(api.resolve(reportPath)), api.resolve(file));
        if (!api.isAbsolute(relative)) {
            const encoded = relative.split(api.sep).map(segment => encodeURIComponent(segment)).join('/');
            return `${encoded}${line ? `#L${line}` : ''}`;
        }
    }
    // Different Windows volumes have no relative path. Keep the local opening fallback for those files.
    const windows = pathApi(file) === path.win32;
    const target = pathToFileURL(pathApi(file).resolve(file), { windows });
    return `vscode://file${target.hostname ? `//${target.hostname}` : ''}${target.pathname}${line ? `:${line}:1` : ''}`;
}

function absoluteReportLink(target: string): { file: string; line?: number } | undefined {
    try {
        const suffix = /#L([1-9]\d*)$/u.exec(target);
        const file = suffix ? target.slice(0, suffix.index) : target;
        let local: string; let line = suffix ? Number(suffix[1]) : undefined;
        if (/^file:/iu.test(file)) {
            const uri = new URL(file);
            local = fileURLToPath(uri, { windows: /^\/[a-z]:\//iu.test(uri.pathname) || !!uri.hostname });
        } else if (/^vscode(?:-insiders)?:/iu.test(file)) {
            const uri = new URL(file);
            if (uri.hostname !== 'file') { return undefined; }
            const position = /:([1-9]\d*)(?::[1-9]\d*)?$/u.exec(uri.pathname);
            if (position) { uri.pathname = uri.pathname.slice(0, position.index); line = Number(position[1]); }
            local = decodeURIComponent(uri.pathname);
            if (/^\/[a-z]:\//iu.test(local)) { local = local.slice(1); }
            else if (local.startsWith('//')) { local = path.win32.normalize(local); }
        } else {
            if (!/^(?:[a-z]:[\\/]|\/|\\\\)/iu.test(file)) { return undefined; }
            local = decodeURIComponent(file);
        }
        return { file: local, ...(line ? { line } : {}) };
    } catch { return undefined; }
}

/** Derive the generating report directory from its managed worker files, even after moving the checkout. */
export function upgradeCompilerReportFileLinks(report: string, reportPath: string): string {
    const links = [...report.matchAll(/\]\(<([^<>\r\n]+)>\)/gu)].map(match => ({ target: match[1], location: absoluteReportLink(match[1]) }));
    const origins = new Map<string, string>();
    for (const { location } of links) {
        const root = location && /^(.*)[\\/]compiler-parts[\\/][1-9]\d*[\\/](?:yaml_build_result\.txt|yaml_build_log\.txt|compile\.txt|junit_compile\.xml)$/iu.exec(location.file)?.[1];
        if (root) { origins.set(pathApi(root) === path.win32 ? root.toLowerCase() : root, root); }
    }
    const origin = origins.size === 1 ? [...origins.values()][0] : undefined;
    const base = origin ? pathApi(origin).join(origin, 'compiler-build-report.md') : reportPath;
    const replacements = new Map(links.flatMap(({ target, location }) => location && pathApi(location.file) === pathApi(base)
        ? [[target, compilerReportLinkTarget(location.file, base, location.line)]] : []));
    return report.replace(/\]\(<([^<>\r\n]+)>\)/gu, (match, target: string) => {
        const replacement = replacements.get(target);
        return replacement ? `](<${replacement}>)` : match;
    });
}

function reportLink(label: string, file: string, reportPath: string, line?: number): string {
    return `[${markdown(label)}](<${compilerReportLinkTarget(file, reportPath, line)}>)`;
}

function quote(value: string): string {
    return value.split(/\r\n|\r|\n/u).map(line => `> ${markdown(line)}`).join('\n');
}

interface ReportSourceLocation { readonly source: CompilerBuildReportSource; readonly line?: number }
type ReportTranslate = (message: string, ...args: string[]) => string;

async function sourceLocation(sources: readonly CompilerBuildReportSource[], uid?: string, code?: string, message = ''): Promise<ReportSourceLocation | undefined> {
    uid ||= /UIDСценария:\s*([\w-]+)/iu.exec(message)?.[1];
    const byUid = uid ? sources.filter(source => source.uid?.toLocaleLowerCase() === uid.toLocaleLowerCase()) : [];
    const matches = byUid.length ? byUid : code ? sources.filter(source => source.code === code) : [];
    if (matches.length !== 1) { return undefined; }
    const location = await resolveCompilerBuildErrorLocation(sources, matches[0], message);
    const source = location?.source ?? matches[0]; const line = location?.line;
    return { source, line };
}

function diagnosticSummary(diagnostics: readonly string[]): string {
    const lines = diagnostics.flatMap(value => value.split(/\r\n|\r|\n/u)).map(line => line.trim()).filter(Boolean);
    const coordinate = [...lines].reverse().find(line => /^(?:---)*Строка\s*№\s*\d+\./iu.test(line));
    return coordinate || lines.map(line => line.replace(/^\{[^}]+\}:[ \t]*/u, ''))[0] || '';
}

async function errorFiles(directory: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const results = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) { return errorFiles(file); }
            return entry.isFile() && /\.xml$/iu.test(entry.name) ? [file] : [];
        }));
        return results.flat();
    } catch { return []; }
}

/** Optional compiler reports enrich the result marker and log; unreadable reports are explicit. */
export async function writeCompilerBuildReport(
    jobs: readonly CompilerBuildJob[], targetPath: string, sources: readonly CompilerBuildReportSource[] = [],
    preflight: readonly CompilerBuildPreflightIssue[] = [],
    t: ReportTranslate = (message, ...args) => message.replace(/\{(\d+)\}/gu, (_, index: string) => args[Number(index)] ?? '')
): Promise<void> {
    const link = (label: string, file: string, line?: number) => reportLink(label, file, targetPath, line);
    const parts = await Promise.all(jobs.map(async job => {
        const [result, log, inventoryContent, junitContent, xmlFiles] = await Promise.all([
            readOptional(job.resultPath), readOptional(job.logPath), readOptional(job.inventoryPath),
            readOptional(job.junitPath), errorFiles(job.errorPath)
        ]);
        const errors = await Promise.all(xmlFiles.map(async file => ({ file, report: parseCompilerErrorXml(await readOptional(file)) })));
        return { job, log, inventoryContent, junitContent, errors, inventory: parseCompileInventory(inventoryContent),
            junit: parseCompilerJUnit(junitContent), resultCode: result?.replace(/^\uFEFF/u, '').trim() };
    }));
    const states = { passed: t('Compiled'), failed: t('Compilation failed'), error: t('Compilation failed'), skipped: t('Skipped') };
    const issues = new Map<string, { title: string; summary: string; location?: ReportSourceLocation; diagnostics: Set<string>; files: Map<string, string> }>();
    const rows: string[] = [];
    const addIssue = (title: string, location: ReportSourceLocation | undefined, diagnostics: string[], file: string, fileLabel: string) => {
        const summary = diagnosticSummary(diagnostics) || t('The compiler did not provide an error description.');
        const key = `${location ? `${location.source.path}:${location.line ?? ''}` : file}:${summary.replace(/\s+/gu, ' ')}`;
        let issue = issues.get(key);
        if (!issue) {
            issue = { title: location?.source.name || title, summary, location, diagnostics: new Set(), files: new Map() };
            issues.set(key, issue);
        }
        diagnostics.filter(value => value.trim()).forEach(value => issue.diagnostics.add(value));
        issue.files.set(file, fileLabel);
    };
    for (const part of parts) {
        for (const entry of part.junit?.entries ?? []) {
            const diagnostics = [entry.message, entry.details, entry.properties.description, entry.properties.how_to].filter(Boolean);
            const location = await sourceLocation(sources, entry.properties.uid_scenario, entry.properties.scenario || entry.properties.process, diagnostics.join('\n'));
            const name = entry.properties.scenario_setting_name || entry.name || entry.suiteName;
            const source = location ? link(`${path.basename(location.source.path)}${location.line ? `:${location.line}` : ''}`, location.source.path, location.line) : '—';
            rows.push(`| ${markdown(name).replace(/\r\n|\r|\n/gu, ' ')} | ${states[entry.status]} | ${source} |`);
            if (entry.status === 'failed' || entry.status === 'error') {
                addIssue(name, location, diagnostics, part.job.junitPath, t('Compiler JUnit'));
            }
        }
        for (const error of part.errors) {
            if (!error.report) { continue; }
            const diagnostics = [error.report.details, error.report.message, error.report.reproductionSteps].filter(Boolean);
            const location = await sourceLocation(sources, undefined, error.report.scenarioCode || error.report.processCode, diagnostics.join('\n'));
            addIssue(error.report.scenarioCode || error.report.processCode || t('Compiler failure'), location, diagnostics, error.file, t('SPPR error report'));
        }
        if (part.resultCode && part.resultCode !== '0' && !part.errors.some(error => error.report)
            && !part.junit?.entries.some(entry => entry.status === 'failed' || entry.status === 'error')) {
            addIssue(t('Build part {0}', String(part.job.index)), undefined, [part.log || t('Compiler exit code: {0}', part.resultCode)], part.job.logPath, t('Compiler log'));
        }
    }
    const failed = issues.size > 0 || preflight.some(issue => issue.severity === 'error')
        || parts.some(part => part.junit?.summary.failures || part.junit?.summary.errors);
    const incomplete = parts.some(part => part.resultCode !== '0' || !part.junit || part.errors.some(error => !error.report));
    const heading = !parts.length ? `⚠️ ${t('Compilation was not started')}`
        : failed ? `❌ ${t('Compilation finished with errors')}`
        : incomplete ? `⚠️ ${t('Build results are incomplete')}` : `✅ ${t('Compilation completed')}`;
    const passed = parts.reduce((sum, part) => sum + (part.junit?.entries.filter(entry => entry.status === 'passed').length ?? 0), 0);
    const errors = parts.reduce((sum, part) => sum + (part.junit ? part.junit.summary.failures + part.junit.summary.errors : 0), 0);
    const skipped = parts.reduce((sum, part) => sum + (part.junit?.summary.skipped ?? 0), 0);
    const lines = [`# ${t('Build report')}`, '', `**${heading}**`, '', t('Compilation results; scenarios have not been executed.'), ''];
    if (parts.some(part => part.junit)) {
        lines.push(t('Compiled: {0} · With errors: {1} · Skipped: {2}', String(passed), String(errors), String(skipped)), '');
    }
    if (issues.size) {
        lines.push(`## ${t('Errors to fix')}`, '');
        for (const issue of issues.values()) {
            lines.push(`### ${markdown(issue.title)}`, '', quote(issue.summary), '');
            if (issue.location) {
                const { source, line } = issue.location;
                lines.push(`${t('Source')}: ${link(`${source.name}${line ? `:${line}` : ''}`, source.path, line)}`, '');
            }
            lines.push('<details>', `<summary>${t('Technical details')}</summary>`, '');
            for (const diagnostic of issue.diagnostics) { lines.push(quote(diagnostic), ''); }
            for (const [file, label] of issue.files) { lines.push(`- ${link(label, file)}`); }
            lines.push('', '</details>', '');
        }
    }
    if (preflight.length) {
        lines.push(`## ${t('Source checks')}`, '');
        const reasons = { scalar: t('Quote scalar values; SPPR removes their outer characters.'), indentation: t('Use indentation in multiples of four spaces.'),
            blockScalar: t('SPPR supports the exact literal marker |.'), comment: t('The SPPR reader does not support this YAML comment.'), extension: t('The SPPR reader expects .yaml files.') };
        for (const issue of preflight) {
            const message = t(issue.message, ...(issue.messageArgs ?? []).map(String));
            lines.push(`- ${issue.severity === 'error' ? t('Error') : t('Warning')}: ${markdown(message)}`, '');
            if (issue.uri?.startsWith('file:')) {
                const file = fileURLToPath(issue.uri);
                for (const detail of issue.formatIssues ?? []) { lines.push(`  - ${link(t('Line {0}', String(detail.line + 1)), file, detail.line + 1)}: ${reasons[detail.kind]}`, ''); }
                if (!issue.formatIssues?.length) { lines.push(link(path.basename(file), file), ''); }
            }
        }
    }
    lines.push(`## ${t('Compilation results')}`, '');
    if (rows.length) { lines.push(`| ${t('Test')} | ${t('Compilation')} | ${t('Source')} |`, '|---|---|---|', ...rows, ''); }
    else { lines.push(t('No compilation results are available.'), ''); }
    lines.push(`## ${t('Compiler files')}`, '');
    for (const { job, log, inventory, inventoryContent, junit, junitContent, errors, resultCode } of parts) {
        const hasErrors = Boolean(junit?.summary.failures || junit?.summary.errors || errors.some(error => error.report));
        const status = hasErrors || (resultCode && resultCode !== '0') ? 'failed'
            : resultCode === '0' ? 'compiler completed' : 'unavailable';
        const statusLabel = status === 'failed' ? t('failed') : status === 'compiler completed' ? t('compiler completed') : t('unavailable');
        lines.push('<details>', `<summary>${t('Part {0}/{1}', String(job.index), String(job.total))} · ${t('Compiler files')}</summary>`, '',
            t('Status: {0}', statusLabel), '',
            `${t('Result code: {0}', markdown(resultCode || t('unavailable')))} (${link(t('Result file'), job.resultPath)})`, '',
            `${t('Compiler log')}: ${link(t('Compiler log'), job.logPath)}${log === undefined ? ` (${t('unavailable')})` : ''}`, '');
        if (log?.trim()) {
            const excerpt = log.length > 12000 ? log.slice(-12000) : log;
            if (log.length > excerpt.length) { lines.push(t('Final 12000 characters of the compiler log:'), ''); }
            lines.push(quote(excerpt.trim()), '');
        }
        lines.push(`${t('Build inventory')}: ${link('compile.txt', job.inventoryPath)}`, '');
        if (inventory) {
            lines.push(t('Scenario settings: {0}', inventory.scenarioSettingsCodes.map(markdown).join(', ') || '—'),
                t('Process settings: {0}', inventory.processSettingsCodes.map(markdown).join(', ') || '—'), '');
        } else { lines.push(inventoryContent === undefined ? t('Inventory unavailable.') : t('Inventory malformed.'), ''); }
        lines.push(`${t('Compiler JUnit')}: ${link(t('Compiler JUnit'), job.junitPath)}`, '');
        if (junit) {
            const summary = junit.summary;
            lines.push(t('Tests: {0}; failures: {1}; errors: {2}; skipped: {3}.', String(summary.tests), String(summary.failures), String(summary.errors), String(summary.skipped)), '');
            for (const entry of junit.entries.filter(entry => entry.status === 'skipped' || entry.status === 'passed')) {
                const diagnostics = [...new Set([entry.message, entry.details].filter(Boolean))];
                if (!diagnostics.length) { continue; }
                lines.push(`**${markdown(entry.name || entry.suiteName)} · ${states[entry.status]}**`, '');
                diagnostics.forEach(diagnostic => lines.push(quote(diagnostic), ''));
            }
        } else { lines.push(junitContent === undefined ? t('JUnit unavailable.') : t('JUnit malformed.'), ''); }
        for (const error of errors) {
            lines.push(link(path.basename(error.file), error.file), '');
            if (!error.report) { lines.push(t('Error report unavailable or malformed.'), ''); }
        }
        lines.push('</details>', '');
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, lines.join('\n'), 'utf8');
}

/** Return false when no valid input exists; absent workers never become synthetic passing cases. */
export async function aggregateCompilerJUnit(jobs: readonly CompilerBuildJob[], targetPath: string): Promise<boolean> {
    const contents = await Promise.all(jobs.map(job => readOptional(job.junitPath)));
    const reports = contents.map(content => ({ report: parseCompilerJUnit(content), suites: extractCompilerJUnitSuitesXml(content) }))
        .filter(item => item.report !== null && item.suites !== null);
    if (!reports.length) {
        await fs.rm(targetPath, { force: true });
        return false;
    }
    const sum = (key: 'tests' | 'failures' | 'errors' | 'skipped' | 'timeSeconds'): number => reports
        .reduce((total, item) => total + (item.report?.summary[key] ?? 0), 0);
    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<testsuites tests="${sum('tests')}" failures="${sum('failures')}" errors="${sum('errors')}" skipped="${sum('skipped')}" time="${sum('timeSeconds')}">`,
        ...reports.flatMap(item => item.suites ?? []), '</testsuites>', ''
    ].join('\n');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, xml, 'utf8');
    return true;
}
