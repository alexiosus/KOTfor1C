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
    return value.replace(/[\\`*_\[\]<>]/gu, character => `\\${character}`);
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

async function sourceLink(sources: readonly CompilerBuildReportSource[], reportPath: string, uid?: string, code?: string, message = ''): Promise<string> {
    uid ||= /UIDСценария:\s*([\w-]+)/iu.exec(message)?.[1];
    const byUid = uid ? sources.filter(source => source.uid?.toLocaleLowerCase() === uid.toLocaleLowerCase()) : [];
    const matches = byUid.length ? byUid : code ? sources.filter(source => source.code === code) : [];
    if (matches.length !== 1) { return ''; }
    const location = await resolveCompilerBuildErrorLocation(sources, matches[0], message);
    const source = location?.source ?? matches[0]; const line = location?.line;
    return `Source: ${reportLink(`${source.name}${line ? `:${line}` : ''}`, source.path, reportPath, line)}`;
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
    preflight: readonly CompilerBuildPreflightIssue[] = []
): Promise<void> {
    const link = (label: string, file: string, line?: number) => reportLink(label, file, targetPath, line);
    const lines = ['# Compiler build report', '', 'compile.txt lists attempted settings; JUnit and SPPR describe compilation results.', ''];
    if (preflight.length) {
        lines.push('## SPPR preflight', '');
        const reasons = { scalar: 'Quote scalar values; SPPR removes their outer characters.', indentation: 'Use indentation in multiples of four spaces.',
            blockScalar: 'SPPR supports the exact literal marker |.', comment: 'The SPPR reader does not support this YAML comment.', extension: 'The SPPR reader expects .yaml files.' };
        for (const issue of preflight) {
            const message = issue.message.replace(/\{(\d+)\}/gu, (_, index: string) => String(issue.messageArgs?.[Number(index)] ?? ''));
            lines.push(`- ${issue.severity}: ${markdown(message)}`, '');
            if (issue.uri?.startsWith('file:')) {
                const file = fileURLToPath(issue.uri);
                for (const detail of issue.formatIssues ?? []) { lines.push(`  - ${link(`Line ${detail.line + 1}`, file, detail.line + 1)}: ${reasons[detail.kind]}`, ''); }
                if (!issue.formatIssues?.length) { lines.push(link(path.basename(file), file), ''); }
            }
        }
    }
    for (const job of jobs) {
        const [result, log, inventoryContent, junitContent, xmlFiles] = await Promise.all([
            readOptional(job.resultPath), readOptional(job.logPath), readOptional(job.inventoryPath),
            readOptional(job.junitPath), errorFiles(job.errorPath)
        ]);
        const inventory = parseCompileInventory(inventoryContent);
        const junit = parseCompilerJUnit(junitContent);
        const errors = await Promise.all(xmlFiles.map(async file => ({ file, report: parseCompilerErrorXml(await readOptional(file)) })));
        const resultCode = result?.replace(/^\uFEFF/u, '').trim();
        const hasErrors = Boolean(junit?.summary.failures || junit?.summary.errors || errors.some(error => error.report));
        const status = hasErrors || (resultCode && resultCode !== '0') ? 'failed'
            : resultCode === '0' ? 'compiler completed' : 'unavailable';
        lines.push(`## Part ${job.index}/${job.total}`, '', `Status: ${status}`, '',
            `Result code: ${markdown(resultCode || 'unavailable')} (${link('result file', job.resultPath)})`, '',
            `Log: ${link('compiler log', job.logPath)}${log === undefined ? ' (unavailable)' : ''}`, '');
        if (log?.trim()) {
            const excerpt = log.length > 12000 ? log.slice(-12000) : log;
            if (log.length > excerpt.length) { lines.push('Final 12000 characters of the compiler log:', ''); }
            lines.push(quote(excerpt.trim()), '');
        }
        lines.push(`Inventory: ${link('compile.txt', job.inventoryPath)}`, '');
        if (inventory) {
            lines.push(`Scenario settings: ${inventory.scenarioSettingsCodes.map(markdown).join(', ') || '(none)'}`,
                `Process settings: ${inventory.processSettingsCodes.map(markdown).join(', ') || '(none)'}`, '');
        } else { lines.push(inventoryContent === undefined ? 'Inventory unavailable.' : 'Inventory malformed.', ''); }
        lines.push(`JUnit: ${link('compiler JUnit', job.junitPath)}`, '');
        if (junit) {
            const summary = junit.summary;
            lines.push(`Tests: ${summary.tests}; failures: ${summary.failures}; errors: ${summary.errors}; skipped: ${summary.skipped}.`, '');
            for (const entry of junit.entries) {
                lines.push(`- ${markdown(entry.name || entry.suiteName)}: ${entry.status}`, '');
                const source = await sourceLink(sources, targetPath, entry.properties.uid_scenario, entry.properties.scenario || entry.properties.process,
                    [entry.message, entry.details, entry.properties.description, entry.properties.how_to].filter(Boolean).join('\n'));
                if (source) { lines.push(source, ''); }
                if (entry.message) { lines.push(quote(entry.message), ''); }
                if (entry.details && entry.details !== entry.message) { lines.push(quote(entry.details), ''); }
            }
        } else { lines.push(junitContent === undefined ? 'JUnit unavailable.' : 'JUnit malformed.', ''); }
        lines.push('SPPR errors:', '');
        if (!errors.length) { lines.push('No SPPR error reports found.', ''); }
        for (const error of errors) {
            lines.push(link(path.basename(error.file), error.file), '');
            if (!error.report) { lines.push('Error report unavailable or malformed.', ''); continue; }
            lines.push(quote(error.report.message), '');
            if (error.report.details && error.report.details !== error.report.message) { lines.push(quote(error.report.details), ''); }
            const source = await sourceLink(sources, targetPath, undefined, error.report.scenarioCode || error.report.processCode,
                [error.report.message, error.report.details, error.report.reproductionSteps].join('\n'));
            if (source) { lines.push(source, ''); }
        }
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
