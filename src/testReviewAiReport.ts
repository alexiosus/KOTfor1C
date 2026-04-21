import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import {
    buildAiEndpoint,
    ensureAiConnectionSettingsComplete,
    getAiConnectionSettings,
    requestTextFromAi,
    type AiOutputLanguage
} from './aiClient';
import {
    buildConfigurationDiffContext,
    resolveRuntimeRootUri,
    sanitizeBranchNameForReportFile
} from './configurationDiffAiReport';
import { getFormExplorerConfigurationSourceDirectory } from './formExplorerPaths';
import { getScenarioScanRootPath } from './scenarioScanRoot';

const execFileAsync = promisify(execFile);
const GIT_EXEC_MAX_BUFFER = 32 * 1024 * 1024;

const DEFAULT_TEST_REVIEW_SYSTEM_PROMPT = [
    'Ты выступаешь как senior QA/test lead и ревьюер изменений автотестов KOT для 1С.',
    'На вход приходит diff измененных тестов относительно главной ветки, контекст diff конфигурации и необязательный текст UserStory.',
    'Нужно оценить, насколько измененные тесты покрывают продуктовые изменения и намерение задачи.',
    'Главный фокус: покрытие, пропущенные проверки, рискованные слепые зоны, хрупкие места и практические улучшения.',
    'Пиши как полезный ревьюер для автора тестов, а не как формальный линтер.',
    'Не выдумывай покрытие, которого нет в diff и предоставленных фрагментах.',
    'Если вывод нельзя сделать уверенно, явно помечай его как гипотезу или вопрос.'
].join('\n');

interface ChangedPathEntry {
    status: string;
    path: string;
    rootRelativePath: string;
    oldPath?: string;
    oldRootRelativePath?: string;
    descriptor: string;
    score: number;
}

interface FileExcerptEntry {
    path: string;
    rootRelativePath: string;
    descriptor: string;
    score: number;
    excerpt: string;
}

interface DiffPatch {
    path: string;
    text: string;
    score: number;
    index: number;
}

interface ChangedTestsReviewContext {
    repositoryRootPath: string;
    testsRootPath: string;
    testsRootRelativePath: string;
    currentBranch: string;
    baseRef: string;
    mergeBase: string;
    changedFiles: ChangedPathEntry[];
    untrackedFiles: FileExcerptEntry[];
    currentFileExcerpts: FileExcerptEntry[];
    trackedDiffText: string;
    userStoryText: string;
}

interface GeneratedChangedTestsReview {
    reportBody: string;
    outputLanguage: AiOutputLanguage;
}

class SettingsActionError extends Error {
    constructor(message: string, public readonly settingsQuery?: string) {
        super(message);
    }
}

function normalizePathSeparators(value: string): string {
    return value.replace(/\\/g, '/');
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const relativePath = path.relative(parentPath, childPath);
    return relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function toDirectoryRelativePath(repositoryRelativePath: string, directoryRelativePath: string): string {
    const normalizedRepositoryPath = normalizePathSeparators(repositoryRelativePath).replace(/^\/+/, '');
    const normalizedDirectoryPath = normalizePathSeparators(directoryRelativePath)
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');

    if (!normalizedDirectoryPath) {
        return normalizedRepositoryPath;
    }

    if (normalizedRepositoryPath === normalizedDirectoryPath) {
        return '';
    }

    const prefix = `${normalizedDirectoryPath}/`;
    return normalizedRepositoryPath.startsWith(prefix)
        ? normalizedRepositoryPath.slice(prefix.length)
        : normalizedRepositoryPath;
}

function formatGitError(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const execError = error as Error & {
        stderr?: string;
        stdout?: string;
        code?: string | number;
    };
    const stderr = typeof execError.stderr === 'string' ? execError.stderr.trim() : '';
    const stdout = typeof execError.stdout === 'string' ? execError.stdout.trim() : '';
    const details = stderr || stdout || execError.message;
    const code = execError.code !== undefined ? ` (${String(execError.code)})` : '';
    return `${details}${code}`.trim();
}

function truncateText(value: string, maxChars: number, marker: string): string {
    if (value.length <= maxChars) {
        return value;
    }

    return `${value.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}${marker}`;
}

async function execGit(
    repositoryRootPath: string,
    args: string[],
    allowFailure = false
): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd: repositoryRootPath,
            maxBuffer: GIT_EXEC_MAX_BUFFER
        });
        return stdout.trimEnd();
    } catch (error) {
        if (allowFailure) {
            return null;
        }

        throw new Error(vscode.l10n.t('Git command failed: {0}', formatGitError(error)));
    }
}

async function resolveRepositoryRoot(startPath: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
            cwd: startPath,
            maxBuffer: 1024 * 1024
        });
        return stdout.trim();
    } catch (error) {
        throw new Error(vscode.l10n.t('Git command failed: {0}', formatGitError(error)));
    }
}

async function resolveMainBranchRef(repositoryRootPath: string): Promise<string> {
    const originHeadRef = await execGit(
        repositoryRootPath,
        ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
        true
    );
    if (originHeadRef) {
        const normalizedRef = originHeadRef.trim();
        if (normalizedRef.startsWith('refs/remotes/')) {
            return normalizedRef.slice('refs/remotes/'.length);
        }
    }

    const candidates = ['origin/main', 'origin/master', 'main', 'master'];
    for (const candidate of candidates) {
        const resolved = await execGit(
            repositoryRootPath,
            ['rev-parse', '--verify', '--quiet', candidate],
            true
        );
        if (resolved) {
            return candidate;
        }
    }

    throw new Error(vscode.l10n.t(
        'Could not determine the main branch ref. Expected one of origin/main, origin/master, main or master.'
    ));
}

async function resolveCurrentBranchName(repositoryRootPath: string): Promise<string> {
    const branchName = await execGit(
        repositoryRootPath,
        ['branch', '--show-current'],
        true
    );
    return branchName?.trim() || 'HEAD';
}

async function resolveMergeBase(repositoryRootPath: string, baseRef: string): Promise<string> {
    const mergeBase = await execGit(repositoryRootPath, ['merge-base', 'HEAD', baseRef], true);
    if (mergeBase?.trim()) {
        return mergeBase.trim();
    }

    return baseRef;
}

async function resolveConfiguredTestsRootDirectory(): Promise<string> {
    const configuredPath = String(getScenarioScanRootPath() || '').trim();
    if (path.isAbsolute(configuredPath)) {
        return configuredPath;
    }

    const workspaceFolderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceFolderUri) {
        throw new Error(vscode.l10n.t('No workspace folder is open.'));
    }

    return path.join(workspaceFolderUri.fsPath, configuredPath || 'tests/RegressionTests/yaml');
}

function describeTestPath(relativePath: string): string {
    const normalizedPath = normalizePathSeparators(relativePath);
    const segments = normalizedPath.split('/').filter(Boolean);
    const fileName = segments[segments.length - 1] || normalizedPath;
    const scenarioFolderName = segments.length >= 2 ? segments[segments.length - 2] : '';
    const lowerFileName = fileName.toLowerCase();

    if (lowerFileName === 'scen.yaml') {
        return scenarioFolderName
            ? `scenario descriptor for "${scenarioFolderName}"`
            : 'scenario descriptor';
    }
    if (lowerFileName === 'test.yaml') {
        return scenarioFolderName
            ? `test settings for "${scenarioFolderName}"`
            : 'test settings';
    }
    if (lowerFileName === 'main.yaml') {
        return scenarioFolderName
            ? `main scenario YAML for "${scenarioFolderName}"`
            : 'main scenario YAML';
    }
    if (lowerFileName.endsWith('.feature')) {
        return `feature file "${fileName}"`;
    }
    if (lowerFileName.endsWith('.yaml')) {
        return `YAML test file "${fileName}"`;
    }

    return `test file "${fileName}"`;
}

function scoreTestPath(relativePath: string): number {
    const normalizedPath = normalizePathSeparators(relativePath).toLowerCase();
    let score = 1;

    if (normalizedPath.endsWith('/scen.yaml') || normalizedPath === 'scen.yaml') {
        score += 10;
    } else if (normalizedPath.endsWith('/test.yaml') || normalizedPath === 'test.yaml') {
        score += 8;
    } else if (normalizedPath.endsWith('.feature')) {
        score += 7;
    } else if (normalizedPath.endsWith('/main.yaml') || normalizedPath === 'main.yaml') {
        score += 6;
    } else if (normalizedPath.endsWith('.yaml')) {
        score += 5;
    }

    if (normalizedPath.includes('/parent scenarios/')) {
        score += 2;
    }
    if (normalizedPath.includes('/drive/')) {
        score += 1;
    }

    return score;
}

function parseChangedFiles(
    nameStatusOutput: string,
    directoryRelativePath: string
): ChangedPathEntry[] {
    const result: ChangedPathEntry[] = [];

    for (const rawLine of nameStatusOutput.split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        const parts = line.split('\t');
        if (parts.length < 2) {
            continue;
        }

        const statusToken = parts[0];
        const status = statusToken.charAt(0) || statusToken;
        if ((status === 'R' || status === 'C') && parts.length >= 3) {
            const nextPath = parts[2];
            const rootRelativePath = toDirectoryRelativePath(nextPath, directoryRelativePath);
            const oldPath = parts[1];
            result.push({
                status,
                path: nextPath,
                rootRelativePath,
                oldPath,
                oldRootRelativePath: toDirectoryRelativePath(oldPath, directoryRelativePath),
                descriptor: describeTestPath(rootRelativePath),
                score: scoreTestPath(rootRelativePath)
            });
            continue;
        }

        const nextPath = parts[1];
        const rootRelativePath = toDirectoryRelativePath(nextPath, directoryRelativePath);
        result.push({
            status,
            path: nextPath,
            rootRelativePath,
            descriptor: describeTestPath(rootRelativePath),
            score: scoreTestPath(rootRelativePath)
        });
    }

    return result;
}

function parseUntrackedFiles(statusOutput: string): string[] {
    const result: string[] = [];
    for (const rawLine of statusOutput.split('\n')) {
        if (!rawLine.startsWith('?? ')) {
            continue;
        }

        const relativePath = rawLine.slice(3).trim();
        if (relativePath.length > 0) {
            result.push(relativePath);
        }
    }

    return result;
}

async function collectUntrackedFiles(
    repositoryRootPath: string,
    relativePaths: string[],
    directoryRelativePath: string
): Promise<FileExcerptEntry[]> {
    const rankedPaths = relativePaths
        .map(relativePath => ({
            path: relativePath,
            rootRelativePath: toDirectoryRelativePath(relativePath, directoryRelativePath),
            score: scoreTestPath(toDirectoryRelativePath(relativePath, directoryRelativePath))
        }))
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .slice(0, 16);

    const result: FileExcerptEntry[] = [];
    for (const entry of rankedPaths) {
        const absolutePath = path.join(repositoryRootPath, entry.path);
        let excerpt = '[failed to read file]';
        try {
            const fileContent = await fs.promises.readFile(absolutePath, 'utf8');
            excerpt = truncateText(fileContent, 2800, '\n... [file truncated] ...');
        } catch {
            // Keep diagnostic placeholder for failed reads.
        }

        result.push({
            path: entry.path,
            rootRelativePath: entry.rootRelativePath,
            descriptor: describeTestPath(entry.rootRelativePath),
            score: entry.score,
            excerpt
        });
    }

    return result;
}

async function collectCurrentChangedFileExcerpts(
    repositoryRootPath: string,
    changedFiles: ChangedPathEntry[]
): Promise<FileExcerptEntry[]> {
    const rankedFiles = changedFiles
        .filter(entry => entry.status !== 'D')
        .slice()
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .slice(0, 8);

    const result: FileExcerptEntry[] = [];
    for (const entry of rankedFiles) {
        const absolutePath = path.join(repositoryRootPath, entry.path);
        try {
            const stat = await fs.promises.stat(absolutePath);
            if (!stat.isFile()) {
                continue;
            }

            const fileContent = await fs.promises.readFile(absolutePath, 'utf8');
            result.push({
                path: entry.path,
                rootRelativePath: entry.rootRelativePath,
                descriptor: entry.descriptor,
                score: entry.score,
                excerpt: truncateText(fileContent, 2200, '\n... [file truncated] ...')
            });
        } catch {
            // Ignore files that are no longer present in the working tree.
        }
    }

    return result;
}

function buildPathScoreMap(entries: Array<{ path: string; score: number }>): Map<string, number> {
    const scoreMap = new Map<string, number>();
    for (const entry of entries) {
        const existingScore = scoreMap.get(entry.path) || 0;
        if (entry.score > existingScore) {
            scoreMap.set(entry.path, entry.score);
        }
    }

    return scoreMap;
}

function splitDiffIntoPatches(rawDiff: string, scoreMap: Map<string, number>): DiffPatch[] {
    const lines = rawDiff.split('\n');
    const patches: DiffPatch[] = [];
    let currentLines: string[] = [];
    let currentPath = '';
    let currentIndex = 0;

    const flushCurrentPatch = (): void => {
        if (currentLines.length === 0) {
            return;
        }

        const patchText = currentLines.join('\n').trim();
        if (!patchText) {
            currentLines = [];
            currentPath = '';
            return;
        }

        patches.push({
            path: currentPath,
            text: patchText,
            score: scoreMap.get(currentPath) || 1,
            index: currentIndex++
        });
        currentLines = [];
        currentPath = '';
    };

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            flushCurrentPatch();
            const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
            currentPath = match?.[2] || match?.[1] || '';
            currentLines.push(line);
            continue;
        }

        if (currentLines.length > 0) {
            currentLines.push(line);
        }
    }

    flushCurrentPatch();
    return patches;
}

function compactPatchText(patch: DiffPatch): string {
    const perPatchLimit = patch.score >= 10
        ? 3600
        : patch.score >= 7
            ? 2200
            : 1200;
    if (patch.text.length <= perPatchLimit) {
        return patch.text;
    }

    const lines = patch.text.split('\n');
    const selectedLines: string[] = [];
    let currentLength = 0;
    for (const line of lines) {
        const important = line.startsWith('diff --git ')
            || line.startsWith('index ')
            || line.startsWith('--- ')
            || line.startsWith('+++ ')
            || line.startsWith('rename ')
            || line.startsWith('new file mode ')
            || line.startsWith('deleted file mode ')
            || line.startsWith('similarity index ')
            || line.startsWith('@@ ')
            || line.startsWith('+')
            || line.startsWith('-');
        if (!important) {
            continue;
        }

        const nextLength = currentLength === 0 ? line.length : currentLength + 1 + line.length;
        if (nextLength > perPatchLimit - 28) {
            break;
        }

        selectedLines.push(line);
        currentLength = nextLength;
    }

    selectedLines.push('... [patch trimmed] ...');
    return selectedLines.join('\n');
}

function compactTrackedDiff(rawDiff: string, maxChars: number, scoreMap: Map<string, number>): string {
    if (rawDiff.length <= maxChars) {
        return rawDiff.trim();
    }

    const patches = splitDiffIntoPatches(rawDiff, scoreMap);
    if (patches.length === 0) {
        return truncateText(rawDiff.trim(), maxChars, '\n... [diff trimmed] ...');
    }

    const rankedPatches = [...patches]
        .sort((left, right) => right.score - left.score || left.index - right.index);
    const selectedIndices = new Set<number>();
    const compactedByIndex = new Map<number, string>();
    let totalLength = 0;

    for (const patch of rankedPatches) {
        const compactedText = compactPatchText(patch);
        const nextLength = totalLength === 0 ? compactedText.length : totalLength + 2 + compactedText.length;
        if (nextLength > maxChars - 24) {
            continue;
        }

        selectedIndices.add(patch.index);
        compactedByIndex.set(patch.index, compactedText);
        totalLength = nextLength;
    }

    if (selectedIndices.size === 0) {
        return truncateText(rawDiff.trim(), maxChars, '\n... [diff trimmed] ...');
    }

    const compactedChunks = patches
        .filter(patch => selectedIndices.has(patch.index))
        .map(patch => compactedByIndex.get(patch.index) || patch.text);

    return `${compactedChunks.join('\n\n')}\n... [diff trimmed] ...`;
}

function formatChangedTestFileLine(entry: ChangedPathEntry): string {
    const renamePart = entry.oldRootRelativePath
        ? `\`${entry.oldRootRelativePath}\` -> \`${entry.rootRelativePath}\``
        : `\`${entry.rootRelativePath}\``;
    return `- [${entry.status}] ${renamePart} - ${entry.descriptor}`;
}

function formatUntrackedTestFileLine(entry: FileExcerptEntry): string {
    return `- [U] \`${entry.rootRelativePath}\` - ${entry.descriptor}`;
}

function formatConfigurationChangedFileLine(
    entry: Awaited<ReturnType<typeof buildConfigurationDiffContext>>['changedFiles'][number]
): string {
    const renamePart = entry.oldPath
        ? `\`${entry.oldPath}\` -> \`${entry.path}\``
        : `\`${entry.path}\``;
    return `- [${entry.status}] ${renamePart} - ${entry.descriptor}`;
}

function formatConfigurationUntrackedFileLine(
    entry: Awaited<ReturnType<typeof buildConfigurationDiffContext>>['untrackedFiles'][number]
): string {
    return `- [U] \`${entry.path}\` - ${entry.descriptor}`;
}

async function ensureConfigurationDiffContextCanBeBuilt(): Promise<void> {
    const configurationSourceDirectory = getFormExplorerConfigurationSourceDirectory();
    if (!configurationSourceDirectory || !fs.existsSync(configurationSourceDirectory)) {
        throw new SettingsActionError(
            vscode.l10n.t(
                'Configuration source directory is not configured or not found. Set kotTestToolkit.formExplorer.configurationSourceDirectory.'
            ),
            'kotTestToolkit.formExplorer.configurationSourceDirectory'
        );
    }

    const configurationDirectoryStats = await fs.promises.stat(configurationSourceDirectory);
    if (!configurationDirectoryStats.isDirectory()) {
        throw new SettingsActionError(
            vscode.l10n.t(
                'Configuration source directory is not configured or not found. Set kotTestToolkit.formExplorer.configurationSourceDirectory.'
            ),
            'kotTestToolkit.formExplorer.configurationSourceDirectory'
        );
    }
}

async function buildChangedTestsReviewContext(userStoryText: string): Promise<ChangedTestsReviewContext> {
    const testsRootPath = await resolveConfiguredTestsRootDirectory();
    if (!fs.existsSync(testsRootPath)) {
        throw new Error(vscode.l10n.t('Tests directory was not found: {0}', testsRootPath));
    }

    const testsRootStats = await fs.promises.stat(testsRootPath);
    if (!testsRootStats.isDirectory()) {
        throw new Error(vscode.l10n.t('Tests directory is not a folder: {0}', testsRootPath));
    }

    const repositoryRootPath = await resolveRepositoryRoot(testsRootPath);
    if (!isPathInside(repositoryRootPath, testsRootPath)) {
        throw new Error(vscode.l10n.t(
            'Tests directory "{0}" is outside the git repository "{1}".',
            testsRootPath,
            repositoryRootPath
        ));
    }

    const testsRootRelativePath = normalizePathSeparators(path.relative(repositoryRootPath, testsRootPath));
    const baseRef = await resolveMainBranchRef(repositoryRootPath);
    const mergeBase = await resolveMergeBase(repositoryRootPath, baseRef);
    const currentBranch = await resolveCurrentBranchName(repositoryRootPath);
    const trackedDiffText = await execGit(
        repositoryRootPath,
        ['diff', '--find-renames', '--find-copies', '--unified=3', mergeBase, '--', testsRootRelativePath]
    ) || '';
    const changedFiles = parseChangedFiles(
        await execGit(
            repositoryRootPath,
            ['diff', '--name-status', '--find-renames', '--find-copies', mergeBase, '--', testsRootRelativePath]
        ) || '',
        testsRootRelativePath
    );
    const untrackedRelativePaths = parseUntrackedFiles(
        await execGit(
            repositoryRootPath,
            ['status', '--porcelain=1', '--untracked-files=all', '--', testsRootRelativePath]
        ) || ''
    );
    const untrackedFiles = await collectUntrackedFiles(
        repositoryRootPath,
        untrackedRelativePaths,
        testsRootRelativePath
    );
    const currentFileExcerpts = await collectCurrentChangedFileExcerpts(repositoryRootPath, changedFiles);

    return {
        repositoryRootPath,
        testsRootPath,
        testsRootRelativePath,
        currentBranch,
        baseRef,
        mergeBase,
        changedFiles,
        untrackedFiles,
        currentFileExcerpts,
        trackedDiffText,
        userStoryText
    };
}

function buildChangedTestsReviewPrompt(
    testsContext: ChangedTestsReviewContext,
    configurationDiffContext: Awaited<ReturnType<typeof buildConfigurationDiffContext>>,
    outputLanguage: AiOutputLanguage,
    options: {
        testDiffCharLimit: number;
        testChangedFileLimit: number;
        configurationDiffCharLimit: number;
        configurationChangedFileLimit: number;
        includeCurrentTestExcerpts: boolean;
    }
): string {
    const changedTestFileLines = testsContext.changedFiles
        .slice()
        .sort((left, right) => right.score - left.score || left.rootRelativePath.localeCompare(right.rootRelativePath))
        .slice(0, options.testChangedFileLimit)
        .map(formatChangedTestFileLine);
    const remainingChangedTestCount = Math.max(0, testsContext.changedFiles.length - changedTestFileLines.length);
    const untrackedTestFileLines = testsContext.untrackedFiles.map(formatUntrackedTestFileLine);
    const compactedTestsDiff = compactTrackedDiff(
        testsContext.trackedDiffText,
        options.testDiffCharLimit,
        buildPathScoreMap(testsContext.changedFiles)
    );

    const configurationChangedFileLines = configurationDiffContext.changedFiles
        .slice()
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .slice(0, options.configurationChangedFileLimit)
        .map(formatConfigurationChangedFileLine);
    const remainingConfigurationChangedCount = Math.max(
        0,
        configurationDiffContext.changedFiles.length - configurationChangedFileLines.length
    );
    const configurationUntrackedFileLines = configurationDiffContext.untrackedFiles
        .map(formatConfigurationUntrackedFileLine);
    const compactedConfigurationDiff = configurationDiffContext.changedFiles.length > 0
        ? compactTrackedDiff(
            configurationDiffContext.trackedDiffText,
            options.configurationDiffCharLimit,
            buildPathScoreMap(configurationDiffContext.changedFiles)
        )
        : '';
    const mergeBaseShort = testsContext.mergeBase.slice(0, 12);
    const userStoryText = testsContext.userStoryText.trim();

    if (outputLanguage === 'en') {
        return [
            'Review the changed KOT tests against the main branch.',
            'Use the changed test diff, the current test excerpts, the configuration diff context and the optional UserStory text.',
            'Act like a practical reviewer for test authors.',
            'Rules:',
            '- Use only facts from this prompt.',
            '- Separate confirmed gaps from assumptions.',
            '- Reference concrete file paths in backticks.',
            '- Focus on meaningful coverage, missing business checks, data/role branches, negative scenarios, brittle assertions and risky blind spots.',
            '- Do not nitpick formatting or naming unless it harms maintainability or hides test intent.',
            '- If the configuration diff shows no changes, say that explicitly and review only the tests and UserStory.',
            '',
            'Return these sections in markdown:',
            '## Alignment with configuration diff and UserStory',
            '## What is already covered well',
            '## Gaps and risks',
            '## Concrete additions or rework to make',
            '## Questions and assumptions',
            '',
            'Repository context:',
            `- Current branch: ${testsContext.currentBranch}`,
            `- Main branch ref: ${testsContext.baseRef}`,
            `- Merge base: ${mergeBaseShort}`,
            `- Tests directory: ${testsContext.testsRootRelativePath}`,
            `- Changed tracked test files: ${testsContext.changedFiles.length}`,
            `- Untracked new test files: ${testsContext.untrackedFiles.length}`,
            '',
            `UserStory: ${userStoryText.length > 0 ? 'provided' : 'not provided'}`,
            ...(userStoryText.length > 0
                ? [
                    '```text',
                    truncateText(userStoryText, 4000, '\n... [UserStory truncated] ...'),
                    '```'
                ]
                : []),
            '',
            'Changed test files:',
            ...(changedTestFileLines.length > 0 ? changedTestFileLines : ['- tracked test changes were not found']),
            ...(remainingChangedTestCount > 0 ? [`- ... and ${remainingChangedTestCount} more tracked test files`] : []),
            ...(untrackedTestFileLines.length > 0 ? ['', 'New untracked test files:', ...untrackedTestFileLines] : []),
            '',
            'Changed tests diff excerpt:',
            '```diff',
            compactedTestsDiff || '[tracked test diff is empty]',
            '```',
            ...(options.includeCurrentTestExcerpts && testsContext.currentFileExcerpts.length > 0
                ? [
                    '',
                    'Current excerpts from changed tracked test files:',
                    ...testsContext.currentFileExcerpts.map(entry => [
                        `### ${entry.rootRelativePath}`,
                        '```text',
                        entry.excerpt || '[empty file]',
                        '```'
                    ].join('\n'))
                ]
                : []),
            ...(testsContext.untrackedFiles.length > 0
                ? [
                    '',
                    'Current excerpts from new untracked test files:',
                    ...testsContext.untrackedFiles.map(entry => [
                        `### ${entry.rootRelativePath}`,
                        '```text',
                        entry.excerpt || '[empty file]',
                        '```'
                    ].join('\n'))
                ]
                : []),
            '',
            'Configuration diff context:',
            `- Configuration directory: ${configurationDiffContext.configurationSourceDirectoryRelativePath}`,
            `- Changed tracked configuration files: ${configurationDiffContext.changedFiles.length}`,
            `- Untracked new configuration files: ${configurationDiffContext.untrackedFiles.length}`,
            ...(configurationChangedFileLines.length > 0
                ? ['Changed configuration files:', ...configurationChangedFileLines]
                : ['Changed configuration files:', '- no tracked configuration changes were found']),
            ...(remainingConfigurationChangedCount > 0
                ? [`- ... and ${remainingConfigurationChangedCount} more tracked configuration files`]
                : []),
            ...(configurationUntrackedFileLines.length > 0
                ? ['', 'New untracked configuration files:', ...configurationUntrackedFileLines]
                : []),
            ...(compactedConfigurationDiff
                ? [
                    '',
                    'Configuration diff excerpt:',
                    '```diff',
                    compactedConfigurationDiff,
                    '```'
                ]
                : [])
        ].join('\n');
    }

    return [
        'Сделай ревью измененных KOT-тестов относительно главной ветки.',
        'Используй diff измененных тестов, актуальные фрагменты самих тестов, контекст diff конфигурации и необязательный текст UserStory.',
        'Выступай как практичный ревьюер для автора тестов.',
        'Правила:',
        '- Делай выводы только по фактам из этого prompt.',
        '- Отдельно помечай подтвержденные пробелы и гипотезы.',
        '- Ссылайся на конкретные пути файлов в backticks.',
        '- Фокусируйся на полезности покрытия, пропущенных бизнес-проверках, ветках по данным и ролям, негативных сценариях, хрупких проверках и рискованных слепых зонах.',
        '- Не придирайся к форматированию и неймингу, если это не мешает поддержке или не скрывает смысл теста.',
        '- Если diff конфигурации пустой, явно скажи об этом и ревьюй только тесты и UserStory.',
        '',
        'Верни разделы в markdown:',
        '## Соответствие diff конфигурации и UserStory',
        '## Что уже покрыто хорошо',
        '## Где есть пробелы и риски',
        '## Что стоит добавить или переработать',
        '## Вопросы и гипотезы',
        '',
        'Контекст репозитория:',
        `- Текущая ветка: ${testsContext.currentBranch}`,
        `- Главная ветка: ${testsContext.baseRef}`,
        `- Merge base: ${mergeBaseShort}`,
        `- Каталог тестов: ${testsContext.testsRootRelativePath}`,
        `- Измененных tracked-файлов тестов: ${testsContext.changedFiles.length}`,
        `- Новых untracked-файлов тестов: ${testsContext.untrackedFiles.length}`,
        '',
        `UserStory: ${userStoryText.length > 0 ? 'передан' : 'не передан'}`,
        ...(userStoryText.length > 0
            ? [
                '```text',
                truncateText(userStoryText, 4000, '\n... [UserStory truncated] ...'),
                '```'
            ]
            : []),
        '',
        'Измененные файлы тестов:',
        ...(changedTestFileLines.length > 0 ? changedTestFileLines : ['- tracked-изменения тестов не найдены']),
        ...(remainingChangedTestCount > 0 ? [`- ... и еще ${remainingChangedTestCount} tracked-файлов тестов`] : []),
        ...(untrackedTestFileLines.length > 0 ? ['', 'Новые untracked-файлы тестов:', ...untrackedTestFileLines] : []),
        '',
        'Фрагмент diff измененных тестов:',
        '```diff',
        compactedTestsDiff || '[tracked diff тестов отсутствует]',
        '```',
        ...(options.includeCurrentTestExcerpts && testsContext.currentFileExcerpts.length > 0
            ? [
                '',
                'Актуальные фрагменты измененных tracked-файлов тестов:',
                ...testsContext.currentFileExcerpts.map(entry => [
                    `### ${entry.rootRelativePath}`,
                    '```text',
                    entry.excerpt || '[пустой файл]',
                    '```'
                ].join('\n'))
            ]
            : []),
        ...(testsContext.untrackedFiles.length > 0
            ? [
                '',
                'Актуальные фрагменты новых untracked-файлов тестов:',
                ...testsContext.untrackedFiles.map(entry => [
                    `### ${entry.rootRelativePath}`,
                    '```text',
                    entry.excerpt || '[пустой файл]',
                    '```'
                ].join('\n'))
            ]
            : []),
        '',
        'Контекст diff конфигурации:',
        `- Каталог конфигурации: ${configurationDiffContext.configurationSourceDirectoryRelativePath}`,
        `- Измененных tracked-файлов конфигурации: ${configurationDiffContext.changedFiles.length}`,
        `- Новых untracked-файлов конфигурации: ${configurationDiffContext.untrackedFiles.length}`,
        ...(configurationChangedFileLines.length > 0
            ? ['Измененные файлы конфигурации:', ...configurationChangedFileLines]
            : ['Измененные файлы конфигурации:', '- tracked-изменения конфигурации не найдены']),
        ...(remainingConfigurationChangedCount > 0
            ? [`- ... и еще ${remainingConfigurationChangedCount} tracked-файлов конфигурации`]
            : []),
        ...(configurationUntrackedFileLines.length > 0
            ? ['', 'Новые untracked-файлы конфигурации:', ...configurationUntrackedFileLines]
            : []),
        ...(compactedConfigurationDiff
            ? [
                '',
                'Фрагмент diff конфигурации:',
                '```diff',
                compactedConfigurationDiff,
                '```'
            ]
            : [])
    ].join('\n');
}

function buildRetryPrompt(basePrompt: string, outputLanguage: AiOutputLanguage): string {
    return outputLanguage === 'en'
        ? [
            basePrompt,
            '',
            'Important: the previous answer was empty or too weak.',
            'Repeat the review and return only the final markdown report.',
            'Do not leave the requested sections empty. Keep the review practical and concrete.'
        ].join('\n')
        : [
            basePrompt,
            '',
            'Важно: предыдущий ответ оказался пустым или слишком слабым.',
            'Повтори ревью и верни только итоговый markdown-отчет.',
            'Не оставляй обязательные разделы пустыми. Делай выводы практичными и конкретными.'
        ].join('\n');
}

function isContextLengthError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('context length')
        || message.includes('maximum context length')
        || message.includes('prompt is too long')
        || message.includes('number of tokens to keep')
        || message.includes('input is too long');
}

async function generateChangedTestsReview(
    testsContext: ChangedTestsReviewContext,
    configurationDiffContext: Awaited<ReturnType<typeof buildConfigurationDiffContext>>
): Promise<GeneratedChangedTestsReview> {
    const settings = getAiConnectionSettings(vscode.Uri.file(testsContext.testsRootPath));
    try {
        ensureAiConnectionSettingsComplete(settings);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SettingsActionError(message, 'kotTestToolkit.ai');
    }

    const endpoint = buildAiEndpoint(settings.baseUrl, settings.apiFormat, settings.apiVersion || undefined);
    const standardPrompt = buildChangedTestsReviewPrompt(
        testsContext,
        configurationDiffContext,
        settings.outputLanguage,
        {
            testDiffCharLimit: 22000,
            testChangedFileLimit: 40,
            configurationDiffCharLimit: 10000,
            configurationChangedFileLimit: 30,
            includeCurrentTestExcerpts: true
        }
    );
    const compactPrompt = buildChangedTestsReviewPrompt(
        testsContext,
        configurationDiffContext,
        settings.outputLanguage,
        {
            testDiffCharLimit: 10000,
            testChangedFileLimit: 20,
            configurationDiffCharLimit: 5000,
            configurationChangedFileLimit: 16,
            includeCurrentTestExcerpts: false
        }
    );

    const requestReview = async (prompt: string): Promise<string> => {
        const firstAttempt = (await requestTextFromAi(
            endpoint,
            settings,
            DEFAULT_TEST_REVIEW_SYSTEM_PROMPT,
            prompt
        )).trim();
        if (firstAttempt.length > 0) {
            return firstAttempt;
        }

        return (await requestTextFromAi(
            endpoint,
            settings,
            DEFAULT_TEST_REVIEW_SYSTEM_PROMPT,
            buildRetryPrompt(prompt, settings.outputLanguage)
        )).trim();
    };

    try {
        const standardAttempt = await requestReview(standardPrompt);
        if (standardAttempt.length > 0) {
            return {
                reportBody: standardAttempt,
                outputLanguage: settings.outputLanguage
            };
        }
    } catch (error) {
        if (!isContextLengthError(error)) {
            throw error;
        }
    }

    const compactAttempt = await requestReview(compactPrompt);
    if (compactAttempt.length === 0) {
        throw new Error(settings.outputLanguage === 'en'
            ? 'LLM returned an empty review.'
            : 'LLM вернула пустое ревью.');
    }

    return {
        reportBody: compactAttempt,
        outputLanguage: settings.outputLanguage
    };
}

function buildFinalMarkdownReport(
    testsContext: ChangedTestsReviewContext,
    configurationDiffContext: Awaited<ReturnType<typeof buildConfigurationDiffContext>>,
    generatedReview: GeneratedChangedTestsReview
): string {
    const mergeBaseShort = testsContext.mergeBase.slice(0, 12);
    const title = generatedReview.outputLanguage === 'en'
        ? '# AI review of changed tests'
        : '# AI-ревью измененных тестов';
    const userStorySectionTitle = generatedReview.outputLanguage === 'en'
        ? '## UserStory context'
        : '## Контекст UserStory';
    const testsAppendixTitle = generatedReview.outputLanguage === 'en'
        ? '## Appendix: changed test files'
        : '## Приложение: измененные файлы тестов';
    const configurationAppendixTitle = generatedReview.outputLanguage === 'en'
        ? '## Appendix: configuration diff files'
        : '## Приложение: файлы diff конфигурации';
    const userStoryState = testsContext.userStoryText.trim().length > 0
        ? (generatedReview.outputLanguage === 'en' ? 'provided' : 'передан')
        : (generatedReview.outputLanguage === 'en' ? 'not provided' : 'не передан');

    return [
        title,
        '',
        `- Generated: ${new Date().toLocaleString()}`,
        `- Branch: \`${testsContext.currentBranch}\``,
        `- Main ref: \`${testsContext.baseRef}\``,
        `- Merge base: \`${mergeBaseShort}\``,
        `- Repository root: \`${testsContext.repositoryRootPath}\``,
        `- Tests directory: \`${testsContext.testsRootRelativePath}\``,
        `- Changed tracked test files: ${testsContext.changedFiles.length}`,
        `- New untracked test files: ${testsContext.untrackedFiles.length}`,
        `- Changed tracked configuration files: ${configurationDiffContext.changedFiles.length}`,
        `- New untracked configuration files: ${configurationDiffContext.untrackedFiles.length}`,
        `- UserStory: ${userStoryState}`,
        '',
        ...(testsContext.userStoryText.trim().length > 0
            ? [
                userStorySectionTitle,
                '',
                '```text',
                truncateText(testsContext.userStoryText.trim(), 4000, '\n... [UserStory truncated] ...'),
                '```',
                ''
            ]
            : []),
        generatedReview.reportBody.trim(),
        '',
        '---',
        '',
        testsAppendixTitle,
        '',
        ...(testsContext.changedFiles.length > 0
            ? testsContext.changedFiles
                .slice()
                .sort((left, right) => right.score - left.score || left.rootRelativePath.localeCompare(right.rootRelativePath))
                .map(formatChangedTestFileLine)
            : ['- tracked-изменения тестов не найдены']),
        ...(testsContext.untrackedFiles.length > 0
            ? ['', ...testsContext.untrackedFiles.map(formatUntrackedTestFileLine)]
            : []),
        '',
        configurationAppendixTitle,
        '',
        ...(configurationDiffContext.changedFiles.length > 0
            ? configurationDiffContext.changedFiles
                .slice()
                .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
                .map(formatConfigurationChangedFileLine)
            : ['- tracked-изменения конфигурации не найдены']),
        ...(configurationDiffContext.untrackedFiles.length > 0
            ? ['', ...configurationDiffContext.untrackedFiles.map(formatConfigurationUntrackedFileLine)]
            : [])
    ].join('\n');
}

async function doesUriExist(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

interface TestReviewReportStorageContext {
    currentBranch: string;
    reportsDirectoryUri: vscode.Uri;
    reportUri: vscode.Uri;
}

async function resolveTestReviewReportStorageContext(): Promise<TestReviewReportStorageContext> {
    const testsRootPath = await resolveConfiguredTestsRootDirectory();
    const repositoryRootPath = await resolveRepositoryRoot(testsRootPath);
    const currentBranch = await resolveCurrentBranchName(repositoryRootPath);
    const runtimeRootUri = resolveRuntimeRootUri(repositoryRootPath);
    const reportsDirectoryUri = vscode.Uri.joinPath(runtimeRootUri, 'test-review-ai-reports');
    const reportUri = vscode.Uri.joinPath(
        reportsDirectoryUri,
        sanitizeBranchNameForReportFile(currentBranch)
    );
    return { currentBranch, reportsDirectoryUri, reportUri };
}

function resolveTestReviewReportUriFromContext(context: ChangedTestsReviewContext): {
    reportsDirectoryUri: vscode.Uri;
    reportUri: vscode.Uri;
} {
    const runtimeRootUri = resolveRuntimeRootUri(context.repositoryRootPath);
    const reportsDirectoryUri = vscode.Uri.joinPath(runtimeRootUri, 'test-review-ai-reports');
    const reportUri = vscode.Uri.joinPath(
        reportsDirectoryUri,
        sanitizeBranchNameForReportFile(context.currentBranch)
    );
    return { reportsDirectoryUri, reportUri };
}

export interface TestReviewReportState {
    available: boolean;
    branchName: string | null;
    reportUri: vscode.Uri | null;
    hasSavedReport: boolean;
}

export async function getTestReviewReportState(): Promise<TestReviewReportState> {
    try {
        const storageContext = await resolveTestReviewReportStorageContext();
        return {
            available: true,
            branchName: storageContext.currentBranch,
            reportUri: storageContext.reportUri,
            hasSavedReport: await doesUriExist(storageContext.reportUri)
        };
    } catch {
        return { available: false, branchName: null, reportUri: null, hasSavedReport: false };
    }
}

export async function openSavedTestReviewReport(): Promise<boolean> {
    const state = await getTestReviewReportState();
    if (!state.reportUri || !state.hasSavedReport) {
        return false;
    }
    await vscode.commands.executeCommand('markdown.showPreviewToSide', state.reportUri);
    return true;
}

export async function handleReviewChangedTestsWithAi(): Promise<void> {
    const openSettings = vscode.l10n.t('Open settings');

    try {
        const userStoryInputLabel = vscode.l10n.t('UserStory text (optional)');
        const testsContextWithoutStory = await buildChangedTestsReviewContext('');
        if (testsContextWithoutStory.changedFiles.length === 0 && testsContextWithoutStory.untrackedFiles.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t(
                'No test changes relative to {0} were found in {1}.',
                testsContextWithoutStory.baseRef,
                testsContextWithoutStory.testsRootRelativePath
            ));
            return;
        }

        await ensureConfigurationDiffContextCanBeBuilt();
        const configurationDiffContext = await buildConfigurationDiffContext();

        const userStoryText = await vscode.window.showInputBox({
            prompt: vscode.l10n.t('Paste UserStory text to help review test coverage. Leave empty to skip.'),
            placeHolder: userStoryInputLabel,
            ignoreFocusOut: true,
            value: ''
        });
        if (userStoryText === undefined) {
            return;
        }

        const testsContext: ChangedTestsReviewContext = {
            ...testsContextWithoutStory,
            userStoryText: userStoryText.trim()
        };

        const generatedReview = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Generating AI review for changed tests...'),
            cancellable: false
        }, () => generateChangedTestsReview(testsContext, configurationDiffContext));

        const reportMarkdown = buildFinalMarkdownReport(testsContext, configurationDiffContext, generatedReview);
        const { reportsDirectoryUri, reportUri } = resolveTestReviewReportUriFromContext(testsContext);
        await vscode.workspace.fs.createDirectory(reportsDirectoryUri);
        await vscode.workspace.fs.writeFile(reportUri, Buffer.from(reportMarkdown, 'utf8'));

        const openReportAction = vscode.l10n.t('Open report');
        const selection = await vscode.window.showInformationMessage(
            vscode.l10n.t(
                'Changed tests review was generated with AI and saved for branch "{0}".',
                testsContext.currentBranch
            ),
            openReportAction
        );
        if (selection === openReportAction) {
            await vscode.commands.executeCommand('markdown.showPreviewToSide', reportUri);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SettingsActionError && error.settingsQuery) {
            const selection = await vscode.window.showErrorMessage(message, openSettings);
            if (selection === openSettings) {
                void vscode.commands.executeCommand('workbench.action.openSettings', error.settingsQuery);
            }
            return;
        }

        await vscode.window.showErrorMessage(
            vscode.l10n.t('Failed to review changed tests with AI: {0}', message)
        );
    }
}
