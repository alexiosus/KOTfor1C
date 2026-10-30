import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';

export interface SetupInspection {
    root: string; sppr: string[]; processes: string[]; features: string[]; libraries: string[]; launchJson: string[];
    metadata: string[]; examples: string[]; token: string; truncated: boolean; warnings: string[];
}
export function selectSetupExample(inspection: SetupInspection, mode: 'vanessa' | 'sppr'): string | undefined {
    const file = mode === 'sppr' ? inspection.sppr[0] ?? inspection.processes[0] : inspection.features[0];
    return file?.replace(/(?:^|\/)meta\.yaml$/u, match => match.replace('meta.yaml', 'scen.feature'));
}
export function suggestSetupRoots(inspection: SetupInspection, mode: 'vanessa' | 'sppr'): { sources: string; libraries: string } {
    const common = (files: string[]) => {
        if (!files.length) { return ''; }
        const shared = path.posix.dirname(files[0]).split('/');
        for (const file of files.slice(1)) { const parts = path.posix.dirname(file).split('/'); while (shared.length && shared.some((value, index) => value !== parts[index])) { shared.pop(); } }
        return shared.join('/') || '.';
    };
    return { sources: common(mode === 'sppr' ? [...inspection.sppr, ...inspection.processes] : inspection.features), libraries: common(inspection.libraries) };
}
export function validateSetupSourceRoot(inspection: SetupInspection, mode: 'vanessa' | 'sppr', sources: string): void {
    const selected = path.resolve(inspection.root, sources);
    const files = mode === 'sppr' ? [...inspection.sppr, ...inspection.processes] : inspection.features;
    if (!files.some(file => { const relative = path.relative(selected, path.resolve(inspection.root, file)); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); })) {
        throw new Error('The selected folder does not contain the detected test sources. Choose their actual folder.');
    }
}
/** Existing compilation profiles control one shared scan root, so setup must use its owning window. */
export function assertPrimarySetupFolder(identity: string, primary: string | undefined): void {
    if (identity !== primary) { throw new Error('Open this project in its own window before preparing its build profile.'); }
}
const excluded = new Set(['.git', 'node_modules', '.superpowers', '.vscode-test', 'out', 'dist', 'build', 'coverage', 'kot-runtime']);
export async function inspectSetupProject(root: string, options: { cancelled?: () => boolean; maxFiles?: number } = {}): Promise<SetupInspection> {
    const result: SetupInspection = { root, sppr: [], processes: [], features: [], libraries: [], launchJson: [], metadata: [], examples: [], token: '', truncated: false, warnings: [] };
    const projectRoot = path.resolve(root);
    const queue = [projectRoot]; const texts = new Map<string, string>(); const fingerprint: string[] = [];
    const check = () => { if (options.cancelled?.()) { throw new Error('Project inspection cancelled'); } };
    let count = 0;
    scan: for (let index = 0; index < queue.length; index++) {
        check();
        if (index >= 100000) { result.truncated = true; break; }
        const directory = queue[index];
        const entries = await fs.readdir(directory, { withFileTypes: true });
        // Configuration dumps can contain thousands of unrelated metadata folders.
        // Keep the workspace root itself: tests may live beside Configuration.xml.
        if (directory !== projectRoot && entries.some(entry => entry.isFile() && entry.name === 'Configuration.xml')) {
            const file = await fs.open(path.join(directory, 'Configuration.xml'), 'r');
            let configuration = false;
            try {
                const buffer = Buffer.alloc(4096);
                const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
                configuration = /http:\/\/v8\.1c\.ru\/8\.3\/MDClasses/u.test(buffer.toString('utf8', 0, bytesRead));
            } finally { await file.close(); }
            if (configuration) { continue; }
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            check();
            const file = path.join(directory, entry.name);
            if (entry.isDirectory() && !excluded.has(entry.name)) {
                queue.push(file);
            } else if (entry.isFile() && /\.(?:feature|ya?ml|json)$/iu.test(entry.name)) {
                if (++count > (options.maxFiles ?? 12000)) { result.truncated = true; break scan; }
                const relative = path.relative(root, file).split(path.sep).join('/');
                const stat = await fs.stat(file);
                if (stat.size > 2 * 1024 * 1024) { result.warnings.push(relative); result.truncated = true; continue; }
                const source = await fs.readFile(file, 'utf8'); check(); texts.set(relative, source);
                fingerprint.push(`${relative}:${createHash('sha256').update(source).digest('hex')}`);
            }
        }
    }
    for (const [relative, source] of texts) {
        if (relative.startsWith('.kot/') || relative.endsWith('.kot.yml') || /^KOTМетаданные\s*:/mu.test(source)) { result.metadata.push(relative); }
        if (/\.feature$/iu.test(relative)) {
            const paired = /(?:^|\/)scen\.feature$/iu.test(relative) && texts.has(relative.replace(/scen\.feature$/iu, 'meta.yaml'));
            if (paired) { continue; }
            if (/@ExportScenarios\b/iu.test(source)) { result.libraries.push(relative); }
            else if (/^\s*(?:Feature|Функциональность|Функция|Свойство)\s*:/mu.test(source)) { result.features.push(relative); result.examples.push(relative); }
        } else if (/\.ya?ml$/iu.test(relative) && !relative.endsWith('.kot.yml') && !relative.startsWith('.kot/')) {
            try {
                const document = parse(source) as Record<string, unknown> | null;
                if (document?.ТипФайла === 'Сценарий' && document.ДанныеСценария) { result.sppr.push(relative); result.examples.push(relative.endsWith('/meta.yaml') ? relative.replace(/meta\.yaml$/u, 'scen.feature') : relative); }
                else if (document?.ТипФайла === 'Процесс' && document.ДанныеПроцесса) { result.processes.push(relative); }
            } catch { result.warnings.push(relative); }
        } else if (/\.json$/iu.test(relative)) {
            try { const json = JSON.parse(source); if (json && typeof json === 'object' && (texts.has(relative.replace(/\.json$/iu, '.feature')) || 'FeaturesToRun' in json || 'КаталогФич' in json || 'ДанныеКлиентовТестирования' in json)) { result.launchJson.push(relative); } } catch { /* unrelated JSON is not a setup failure */ }
        }
    }
    result.token = createHash('sha256').update(fingerprint.sort().join('\n')).digest('hex');
    return result;
}

export interface SetupFile { path: string; text: string }
export function planNewProject(mode: 'vanessa' | 'sppr', language: 'en' | 'ru', format: 'legacy' | 'native'): SetupFile[] {
    const step = language === 'ru' ? 'И я запоминаю "Первый тест" в переменную "Message"' : 'And I save "First test" in "Message" variable';
    const files = [{ path: 'README-KOT.md', text: '# KOT for 1C\n\n'+(language === 'ru' ? 'Откройте тест и свойства справа. В Библиотеке ищите и вставляйте шаги. Настройки KOT доступны из меню панели; для выполнения подключите Vanessa.\n' : 'Open the test and its properties on the right. Find and insert steps from the Library. Open KOT settings from the panel menu; connect Vanessa when you are ready to run tests.\n') }];
    if (mode === 'vanessa') {
        files.push({ path: 'tests/first.feature', text: `#language: ${language}\n${language === 'ru' ? 'Функциональность: Первый тест\n\nСценарий: Запомнить значение' : 'Feature: First test\n\nScenario: Remember a value'}\n    ${step}\n` });
    } else {
        const uid = randomUUID(); const settingUid = randomUUID(); const childUid = randomUUID();
        const childName = language === 'ru' ? 'я подготавливаю покупателя' : 'I prepare customer';
        const text = `#language: ${language}\n${language === 'ru' ? 'И' : 'And'} ${childName}\n    Customer = "[Customer]"\n${step}\n`;
        const parameters = [{ ПараметрыСценария1: { Имя: 'Customer', Значение: language === 'ru' ? 'Учебный покупатель' : 'Demo customer', ТипПараметра: 'Строка', ИсходящийПараметр: 'Нет' } }];
        const metadata = { ТипФайла: 'Сценарий', ДанныеСценария: { UID: uid, Имя: language === 'ru' ? 'Первый сценарий' : 'First scenario', Код: '900001001', Проект: 'KOT', ФункцияСистемы: 'KOT', UIDФункцияСистемы: randomUUID(), РазрешеноИспользоватьВДругихФункциях: 'Да' }, ПараметрыСценария: parameters, ВложенныеСценарии: [{ ВложенныеСценарии1: { UIDВложенныйСценарий: childUid, ИмяСценария: childName } }], ...(format === 'legacy' ? { ТекстСценария: text } : {}) };
        files.push({ path: `tests/first-scenario/${format === 'native' ? 'meta' : 'scen'}.yaml`, text: stringify(metadata, { indent: 4, lineWidth: 0 }) });
        if (format === 'native') { files.push({ path: 'tests/first-scenario/scen.feature', text }); }
        files.push({ path: 'tests/first-scenario/test/900001001.yaml', text: stringify({ ТипФайла: 'НастройкаТеста', ДанныеТеста: { UID: settingUid, UIDСценария: uid, СценарийНаименование: metadata.ДанныеСценария.Имя, Имя: metadata.ДанныеСценария.Имя, Код: '900001001' }, ПараметрыТеста: [] }, { indent: 4, lineWidth: 0 }) });
        const childText = `#language: ${language}\n${language === 'ru' ? 'И я запоминаю "[Customer]" в переменную "Customer"' : 'And I save "[Customer]" in "Customer" variable'}\n`;
        files.push({ path: `tests/prepare-customer/${format === 'native' ? 'meta' : 'scen'}.yaml`, text: stringify({ ...metadata, ДанныеСценария: { ...metadata.ДанныеСценария, UID: childUid, Имя: childName, Код: '900001002' }, ВложенныеСценарии: [], ...(format === 'legacy' ? { ТекстСценария: childText } : {}) }, { indent: 4, lineWidth: 0 }) });
        if (format === 'native') { files.push({ path: 'tests/prepare-customer/scen.feature', text: childText }); }
        files[0].text += language === 'ru' ? '\nВ первом сценарии измените Customer в свойствах. Нажмите F12 на вызове вложенного сценария, чтобы открыть его. В Менеджере тестов главный сценарий имеет настройку запуска, вложенный доступен в Библиотеке.\n' : '\nChange Customer in the first scenario properties. Press F12 on the nested call to open its source. The main scenario has a run setting in Test Manager; the nested scenario is available in the Library.\n';
    }
    return files;
}

/** Create only reviewed new files. Existing content, symlink parents and outside paths are never replaced. */
export async function applySetupFiles(root: string, files: readonly SetupFile[]): Promise<void> {
    const prepared: Array<{ path: string; text: string }> = [];
    for (const file of files) {
        const target = path.resolve(root, file.path); const relative = path.relative(root, target);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { throw new Error('Setup path is outside the project'); }
        for (let parent = path.dirname(target); parent !== path.resolve(root); parent = path.dirname(parent)) {
            const stat = await fs.lstat(parent).catch(error => { if (error.code !== 'ENOENT') { throw error; } return undefined; });
            if (stat?.isSymbolicLink() || stat && !stat.isDirectory()) { throw new Error('Setup path has an unsafe parent'); }
        }
        if (await fs.lstat(target).then(() => true, error => { if (error.code !== 'ENOENT') { throw error; } return false; })) { throw new Error(`File already exists or changed: ${file.path}`); }
        prepared.push({ path: target, text: file.text });
    }
    const created: typeof prepared = [];
    try {
        for (const file of prepared) { await fs.mkdir(path.dirname(file.path), { recursive: true }); await fs.writeFile(file.path, file.text, { flag: 'wx' }); created.push(file); }
    } catch (error) {
        for (const file of created.reverse()) { if (await fs.readFile(file.path, 'utf8').catch(() => undefined) === file.text) { await fs.unlink(file.path); } }
        throw error;
    }
}
