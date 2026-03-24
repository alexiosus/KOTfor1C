import * as vscode from 'vscode';
import { getTranslator } from './localization';
import { v4 as uuidv4 } from 'uuid';
import { YamlParametersManager } from './yamlParametersManager';
import { scanWorkspaceForTests } from './workspaceScanner';
import { applyPreferredStepKeyword, getConfiguredScenarioLanguage, ScenarioLanguage } from './gherkinLanguage';
import { isScenarioYamlFile } from './yamlValidator';
import { findScenarioHeaderFieldLines } from './scenarioHeaderInlayHintsProvider';

type ScenarioIndex = {
    names: Set<string>;
    codes: Set<string>;
    mainScenarioGroups: Set<string>;
};

type ScenarioIndexCacheEntry = {
    workspaceRoot: string;
    loadedAt: number;
    index: ScenarioIndex;
};

type ConfiguredSystemFunction = {
    name: string;
    uid: string;
};

type NewScenarioDefaults = {
    project: string;
    allowCrossFunctionUsage: boolean;
    userProfile: string;
    reportLevel1: string;
    mainReportLevel2: string;
    nestedReportLevel2: string;
    systemFunctions: ConfiguredSystemFunction[];
};

type ScenarioHeaderValues = {
    project: string;
    systemFunctionName: string;
    systemFunctionUid: string;
    allowCrossFunctionUsage: boolean;
    userProfile: string;
    reportLevel1: string;
    reportLevel2: string;
};

type PromptForSystemFunctionOptions = {
    forcePicker?: boolean;
    placeHolder?: string;
};

const SCENARIO_INDEX_CACHE_TTL_MS = 60_000;
let scenarioIndexCache: ScenarioIndexCacheEntry | null = null;

const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_SYSTEM_FUNCTION: ConfiguredSystemFunction = {
    name: 'Drive automation testing',
    uid: '98999f57-13dc-11e8-aed1-005056a5c4e8'
};

const DEFAULT_NEW_SCENARIO_DEFAULTS: NewScenarioDefaults = {
    project: 'Drive',
    allowCrossFunctionUsage: true,
    userProfile: 'Administrator',
    reportLevel1: 'Drive',
    mainReportLevel2: 'Parent',
    nestedReportLevel2: 'Tests',
    systemFunctions: [DEFAULT_SYSTEM_FUNCTION]
};

const DRIVE_MAIN_SCENARIO_BLOCK = [
    '    And I set "TestClientAlias_Placeholder" synonym to the current TestClient',
    '',
    '    And I initialize TestClient connections',
    '',
    '    And I save key parameters from pipeline and initialize main variables',
    '',
    '    And I click Infobase was transferred button',
    '',
    '    And I get main constant values',
    '',
    '    # Include scenarios here',
    '',
    '    And I close TestClient main window'
].join('\n');

function getConfiguredNonEmptyString(
    config: vscode.WorkspaceConfiguration,
    key: string,
    fallback: string
): string {
    const configuredValue = config.get<string>(key);
    if (typeof configuredValue !== 'string') {
        return fallback;
    }

    const trimmedValue = configuredValue.trim();
    return trimmedValue.length > 0 ? trimmedValue : fallback;
}

function escapeYamlDoubleQuotedString(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
}

function replaceAllLiteral(text: string, search: string, replacement: string): string {
    return text.split(search).join(replacement);
}

function applyTemplateReplacements(templateContent: string, replacements: Record<string, string>): string {
    let result = templateContent;
    for (const [placeholder, replacement] of Object.entries(replacements)) {
        result = replaceAllLiteral(result, placeholder, replacement);
    }
    return result;
}

function formatScenarioHeaderBoolean(value: boolean): string {
    return value ? 'Да' : 'Нет';
}

function normalizeGuid(value: string): string {
    return value.trim().toLowerCase();
}

function getConfiguredSystemFunctions(config: vscode.WorkspaceConfiguration): ConfiguredSystemFunction[] {
    const configuredSystemFunctions = config.get<Array<{ name?: string; uid?: string }>>('newScenarioDefaults.systemFunctions') || [];
    const uniqueFunctionsByUid = new Map<string, ConfiguredSystemFunction>();

    for (const entry of configuredSystemFunctions) {
        const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
        const rawUid = typeof entry?.uid === 'string' ? entry.uid.trim() : '';
        if (!name || !GUID_REGEX.test(rawUid)) {
            continue;
        }

        const normalizedUid = normalizeGuid(rawUid);
        if (!uniqueFunctionsByUid.has(normalizedUid)) {
            uniqueFunctionsByUid.set(normalizedUid, {
                name,
                uid: normalizedUid
            });
        }
    }

    if (uniqueFunctionsByUid.size > 0) {
        return Array.from(uniqueFunctionsByUid.values());
    }

    const legacySystemFunctionName = getConfiguredNonEmptyString(
        config,
        'newScenarioDefaults.systemFunctionName',
        DEFAULT_SYSTEM_FUNCTION.name
    );
    const legacySystemFunctionUidRaw = getConfiguredNonEmptyString(
        config,
        'newScenarioDefaults.systemFunctionUid',
        DEFAULT_SYSTEM_FUNCTION.uid
    );

    return [{
        name: legacySystemFunctionName,
        uid: GUID_REGEX.test(legacySystemFunctionUidRaw)
            ? normalizeGuid(legacySystemFunctionUidRaw)
            : DEFAULT_SYSTEM_FUNCTION.uid
    }];
}

function getNewScenarioDefaults(config: vscode.WorkspaceConfiguration): NewScenarioDefaults {
    const systemFunctions = getConfiguredSystemFunctions(config);

    return {
        project: getConfiguredNonEmptyString(
            config,
            'newScenarioDefaults.project',
            DEFAULT_NEW_SCENARIO_DEFAULTS.project
        ),
        allowCrossFunctionUsage: config.get<boolean>(
            'newScenarioDefaults.allowCrossFunctionUsage',
            DEFAULT_NEW_SCENARIO_DEFAULTS.allowCrossFunctionUsage
        ),
        userProfile: getConfiguredNonEmptyString(
            config,
            'newScenarioDefaults.userProfile',
            DEFAULT_NEW_SCENARIO_DEFAULTS.userProfile
        ),
        reportLevel1: getConfiguredNonEmptyString(
            config,
            'newScenarioDefaults.reportLevel1',
            DEFAULT_NEW_SCENARIO_DEFAULTS.reportLevel1
        ),
        mainReportLevel2: getConfiguredNonEmptyString(
            config,
            'newScenarioDefaults.mainReportLevel2',
            DEFAULT_NEW_SCENARIO_DEFAULTS.mainReportLevel2
        ),
        nestedReportLevel2: getConfiguredNonEmptyString(
            config,
            'newScenarioDefaults.nestedReportLevel2',
            DEFAULT_NEW_SCENARIO_DEFAULTS.nestedReportLevel2
        ),
        systemFunctions
    };
}

function applyManagedScenarioHeaderDefaults(
    templateContent: string,
    headerValues: ScenarioHeaderValues
): string {
    return applyTemplateReplacements(templateContent, {
        Project_Placeholder: escapeYamlDoubleQuotedString(headerValues.project),
        SystemFunctionName_Placeholder: escapeYamlDoubleQuotedString(headerValues.systemFunctionName),
        AllowCrossFunctionUsage_Placeholder: escapeYamlDoubleQuotedString(
            formatScenarioHeaderBoolean(headerValues.allowCrossFunctionUsage)
        ),
        SystemFunctionUid_Placeholder: escapeYamlDoubleQuotedString(headerValues.systemFunctionUid),
        UserProfile_Placeholder: escapeYamlDoubleQuotedString(headerValues.userProfile),
        ReportLevel1_Placeholder: escapeYamlDoubleQuotedString(headerValues.reportLevel1),
        ReportLevel2_Placeholder: escapeYamlDoubleQuotedString(headerValues.reportLevel2)
    });
}

function getDefaultSystemFunction(defaults: NewScenarioDefaults): ConfiguredSystemFunction {
    return defaults.systemFunctions[0]
        || DEFAULT_SYSTEM_FUNCTION;
}

function getScenarioDefaultsConfigurationTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
}

async function saveConfiguredSystemFunctions(systemFunctions: ConfiguredSystemFunction[]): Promise<void> {
    const normalizedFunctions = systemFunctions.length > 0
        ? systemFunctions
        : [DEFAULT_SYSTEM_FUNCTION];

    await vscode.workspace.getConfiguration('kotTestToolkit').update(
        'newScenarioDefaults.systemFunctions',
        normalizedFunctions.map(systemFunction => ({
            name: systemFunction.name,
            uid: systemFunction.uid
        })),
        getScenarioDefaultsConfigurationTarget()
    );
}

async function promptForRequiredString(
    prompt: string,
    value: string,
    validationMessage: string,
    placeHolder?: string
): Promise<string | undefined> {
    const result = await vscode.window.showInputBox({
        prompt,
        value,
        placeHolder,
        ignoreFocusOut: true,
        validateInput: currentValue => currentValue?.trim() ? null : validationMessage
    });

    return result === undefined ? undefined : result.trim();
}

async function promptForSystemFunction(
    t: (message: string, ...args: string[]) => string,
    defaults: NewScenarioDefaults,
    options?: PromptForSystemFunctionOptions
): Promise<ConfiguredSystemFunction | undefined> {
    const shouldShowPicker = options?.forcePicker || defaults.systemFunctions.length > 1;
    if (!shouldShowPicker) {
        return getDefaultSystemFunction(defaults);
    }

    const defaultSystemFunction = getDefaultSystemFunction(defaults);
    const sortedFunctions = [
        defaultSystemFunction,
        ...defaults.systemFunctions.filter(systemFunction => systemFunction.uid !== defaultSystemFunction.uid)
    ];

    const pickedFunction = await vscode.window.showQuickPick(
        sortedFunctions.map(systemFunction => ({
            label: systemFunction.name,
            description: systemFunction.uid,
            detail: systemFunction.uid === defaultSystemFunction.uid ? t('Default') : undefined,
            systemFunction
        })),
        {
            placeHolder: options?.placeHolder || t('Select system function for the new scenario'),
            title: t('System function'),
            ignoreFocusOut: true
        }
    );

    return pickedFunction?.systemFunction;
}

async function promptForMainScenarioGroup(
    t: (message: string, ...args: string[]) => string,
    existingGroups: Set<string>
): Promise<string | undefined> {
    const normalizedGroups = Array.from(existingGroups)
        .map(group => group.trim())
        .filter(group => group.length > 0)
        .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));

    if (normalizedGroups.length === 0) {
        return vscode.window.showInputBox({
            prompt: t('Enter group name'),
            placeHolder: t('For example, "Sales tests 1" or "New Group"'),
            ignoreFocusOut: true,
            validateInput: value => value?.trim() ? null : t('Group name cannot be empty (required for display)')
        }).then(result => result?.trim());
    }

    type GroupQuickPickItem = vscode.QuickPickItem & { groupName: string };

    return new Promise<string | undefined>(resolve => {
        const quickPick = vscode.window.createQuickPick<GroupQuickPickItem>();
        let settled = false;

        const finish = (value: string | undefined) => {
            if (settled) {
                return;
            }
            settled = true;
            quickPick.dispose();
            resolve(value);
        };

        const updateItems = () => {
            const inputValue = quickPick.value.trim();
            const lowerInputValue = inputValue.toLocaleLowerCase();
            const groupItems = normalizedGroups
                .filter(group => !lowerInputValue || group.toLocaleLowerCase().includes(lowerInputValue))
                .map<GroupQuickPickItem>(group => ({
                    label: group,
                    groupName: group
                }));

            const exactMatchExists = normalizedGroups.some(group => group.toLocaleLowerCase() === lowerInputValue);
            if (inputValue && !exactMatchExists) {
                groupItems.unshift({
                    label: t('Create group "{0}"', inputValue),
                    description: t('Use entered text as a new group.'),
                    groupName: inputValue,
                    alwaysShow: true
                });
            }

            quickPick.items = groupItems;
        };

        quickPick.title = t('Main scenario group');
        quickPick.placeholder = t('Select an existing group or type a new one');
        quickPick.ignoreFocusOut = true;
        quickPick.matchOnDescription = true;
        quickPick.onDidChangeValue(updateItems);
        quickPick.onDidAccept(() => {
            const selectedItem = quickPick.selectedItems[0] || quickPick.activeItems[0];
            const groupName = (selectedItem?.groupName || quickPick.value).trim();
            if (!groupName) {
                void vscode.window.showWarningMessage(t('Group name cannot be empty.'));
                return;
            }
            finish(groupName);
        });
        quickPick.onDidHide(() => finish(undefined));

        updateItems();
        quickPick.show();
    });
}

async function promptForSystemFunctionName(
    t: (message: string, ...args: string[]) => string,
    initialValue: string = ''
): Promise<string | undefined> {
    return promptForRequiredString(
        t('Enter system function name'),
        initialValue,
        t('System function name cannot be empty')
    );
}

async function promptForSystemFunctionUid(
    t: (message: string, ...args: string[]) => string,
    initialValue: string = ''
): Promise<string | undefined> {
    const uid = await vscode.window.showInputBox({
        prompt: t('Enter system function UID'),
        value: initialValue,
        ignoreFocusOut: true,
        validateInput: currentValue => {
            const trimmedValue = currentValue?.trim() || '';
            if (!trimmedValue) {
                return t('System function UID cannot be empty');
            }
            return GUID_REGEX.test(trimmedValue)
                ? null
                : t('System function UID must be a valid GUID');
        }
    });

    return uid === undefined ? undefined : normalizeGuid(uid);
}

function findSystemFunctionIndexByUid(systemFunctions: ConfiguredSystemFunction[], uid: string): number {
    return systemFunctions.findIndex(systemFunction => systemFunction.uid === uid);
}

function generateUniqueSystemFunctionUid(systemFunctions: ConfiguredSystemFunction[]): string {
    let generatedUid = normalizeGuid(uuidv4());
    while (findSystemFunctionIndexByUid(systemFunctions, generatedUid) !== -1) {
        generatedUid = normalizeGuid(uuidv4());
    }
    return generatedUid;
}

function buildYamlHeaderFieldLine(existingLine: string, fieldName: string, value: string): string {
    const indentMatch = existingLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    return `${indent}${fieldName}: "${escapeYamlDoubleQuotedString(value)}"`;
}

async function getDefaultModelDbId(context: vscode.ExtensionContext): Promise<string> {
    const yamlParametersManager = YamlParametersManager.getInstance(context);
    const parameters = await yamlParametersManager.loadParameters();
    const modelDBidParam = parameters.find(parameter => parameter.key === 'ModelDBid');
    const configuredValue = typeof modelDBidParam?.value === 'string'
        ? modelDBidParam.value.trim()
        : '';
    return configuredValue || 'EtalonDrive';
}

async function promptForModelDbId(
    t: (message: string, ...args: string[]) => string,
    context: vscode.ExtensionContext
): Promise<string | undefined> {
    const defaultModelDbId = await getDefaultModelDbId(context);
    return promptForRequiredString(
        t('Enter ModelDBid for test.yaml'),
        defaultModelDbId,
        t('ModelDBid cannot be empty'),
        t('Will be written to ЭталоннаяБазаИмя and ИдентификаторБазы')
    );
}

export async function handleChangeScenarioSystemFunctionFromEditor(context: vscode.ExtensionContext): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage(t('No active editor.'));
        return;
    }

    const document = editor.document;
    if (!isScenarioYamlFile(document)) {
        vscode.window.showWarningMessage(t('Open a scenario YAML file to change system function.'));
        return;
    }

    const fieldLines = findScenarioHeaderFieldLines(document);
    if (fieldLines.systemFunctionLine === null || fieldLines.systemFunctionUidLine === null) {
        vscode.window.showWarningMessage(t('System function fields were not found in ДанныеСценария.'));
        return;
    }

    const config = vscode.workspace.getConfiguration('kotTestToolkit');
    const selectedSystemFunction = await promptForSystemFunction(
        t,
        getNewScenarioDefaults(config),
        {
            forcePicker: true,
            placeHolder: t('Select system function for the scenario header')
        }
    );
    if (!selectedSystemFunction) {
        return;
    }

    const systemFunctionLine = document.lineAt(fieldLines.systemFunctionLine);
    const systemFunctionUidLine = document.lineAt(fieldLines.systemFunctionUidLine);
    const updated = await editor.edit(editBuilder => {
        editBuilder.replace(
            systemFunctionLine.range,
            buildYamlHeaderFieldLine(systemFunctionLine.text, 'ФункцияСистемы', selectedSystemFunction.name)
        );
        editBuilder.replace(
            systemFunctionUidLine.range,
            buildYamlHeaderFieldLine(systemFunctionUidLine.text, 'UIDФункцияСистемы', selectedSystemFunction.uid)
        );
    });

    if (!updated) {
        vscode.window.showWarningMessage(t('Failed to update scenario system function.'));
    }
}

export async function handleManageSystemFunctions(context: vscode.ExtensionContext): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const config = vscode.workspace.getConfiguration('kotTestToolkit');
    let systemFunctions = [...getConfiguredSystemFunctions(config)];

    while (true) {
        const pickedItem = await vscode.window.showQuickPick(
            [
                ...systemFunctions.map((systemFunction, index) => ({
                    label: systemFunction.name,
                    description: systemFunction.uid,
                    detail: index === 0 ? t('Default') : undefined,
                    kind: 'systemFunction' as const,
                    uid: systemFunction.uid
                })),
                {
                    label: t('Add system function'),
                    detail: t('Create a new system function entry'),
                    kind: 'add' as const
                }
            ],
            {
                placeHolder: t('Manage available system functions'),
                title: t('System functions'),
                ignoreFocusOut: true
            }
        );

        if (!pickedItem) {
            return;
        }

        if (pickedItem.kind === 'add') {
            const name = await promptForSystemFunctionName(t);
            if (name === undefined) {
                continue;
            }

            const uid = generateUniqueSystemFunctionUid(systemFunctions);

            systemFunctions = [...systemFunctions, { name, uid }];
            await saveConfiguredSystemFunctions(systemFunctions);
            continue;
        }

        const currentIndex = findSystemFunctionIndexByUid(systemFunctions, pickedItem.uid);
        if (currentIndex === -1) {
            continue;
        }

        const currentSystemFunction = systemFunctions[currentIndex];
        const action = await vscode.window.showQuickPick(
            [
                {
                    label: t('Set as default'),
                    detail: t('Move this function to the first position in the list.'),
                    action: 'makeDefault' as const
                },
                {
                    label: t('Edit name'),
                    detail: t('Change the display name of this system function.'),
                    action: 'editName' as const
                },
                {
                    label: t('Edit UID'),
                    detail: t('Change the GUID of this system function.'),
                    action: 'editUid' as const
                },
                {
                    label: t('Delete'),
                    detail: t('Remove this system function from the list.'),
                    action: 'delete' as const
                }
            ],
            {
                placeHolder: t('Choose action for system function "{0}"', currentSystemFunction.name),
                title: t('System functions'),
                ignoreFocusOut: true
            }
        );

        if (!action) {
            continue;
        }

        if (action.action === 'makeDefault') {
            if (currentIndex > 0) {
                systemFunctions = [
                    currentSystemFunction,
                    ...systemFunctions.filter((_, index) => index !== currentIndex)
                ];
                await saveConfiguredSystemFunctions(systemFunctions);
            }
            continue;
        }

        if (action.action === 'editName') {
            const updatedName = await promptForSystemFunctionName(t, currentSystemFunction.name);
            if (updatedName === undefined) {
                continue;
            }

            systemFunctions = systemFunctions.map((systemFunction, index) =>
                index === currentIndex
                    ? { ...systemFunction, name: updatedName }
                    : systemFunction
            );
            await saveConfiguredSystemFunctions(systemFunctions);
            continue;
        }

        if (action.action === 'editUid') {
            const updatedUid = await promptForSystemFunctionUid(t, currentSystemFunction.uid);
            if (updatedUid === undefined) {
                continue;
            }

            const duplicateIndex = findSystemFunctionIndexByUid(systemFunctions, updatedUid);
            if (duplicateIndex !== -1 && duplicateIndex !== currentIndex) {
                vscode.window.showErrorMessage(t('System function with UID "{0}" already exists.', updatedUid));
                continue;
            }

            systemFunctions = systemFunctions.map((systemFunction, index) =>
                index === currentIndex
                    ? { ...systemFunction, uid: updatedUid }
                    : systemFunction
            );
            await saveConfiguredSystemFunctions(systemFunctions);
            continue;
        }

        if (systemFunctions.length === 1) {
            vscode.window.showWarningMessage(t('At least one system function must remain in the list.'));
            continue;
        }

        systemFunctions = systemFunctions.filter((_, index) => index !== currentIndex);
        await saveConfiguredSystemFunctions(systemFunctions);
    }
}

function createScenarioHeaderValues(
    defaults: NewScenarioDefaults,
    systemFunction: ConfiguredSystemFunction,
    reportLevel2: string
): ScenarioHeaderValues {
    return {
        project: defaults.project,
        systemFunctionName: systemFunction.name,
        systemFunctionUid: systemFunction.uid,
        allowCrossFunctionUsage: defaults.allowCrossFunctionUsage,
        userProfile: defaults.userProfile,
        reportLevel1: defaults.reportLevel1,
        reportLevel2
    };
}

async function promptForBooleanValue(
    t: (message: string, ...args: string[]) => string,
    prompt: string,
    defaultValue: boolean
): Promise<boolean | undefined> {
    const yesItem = { label: t('Yes'), value: true, detail: defaultValue ? t('Default') : undefined };
    const noItem = { label: t('No'), value: false, detail: !defaultValue ? t('Default') : undefined };
    const pickedValue = await vscode.window.showQuickPick(
        defaultValue ? [yesItem, noItem] : [noItem, yesItem],
        {
            placeHolder: prompt,
            title: t('Default value: {0}', defaultValue ? t('Yes') : t('No')),
            ignoreFocusOut: true
        }
    );

    return pickedValue?.value;
}

async function promptForScenarioHeaderValues(
    t: (message: string, ...args: string[]) => string,
    defaults: NewScenarioDefaults,
    systemFunction: ConfiguredSystemFunction,
    reportLevel2: string,
    reportLevel2Prompt: string
): Promise<ScenarioHeaderValues | undefined> {
    const baseValues = createScenarioHeaderValues(defaults, systemFunction, reportLevel2);
    const pickedMode = await vscode.window.showQuickPick(
        [
            {
                label: t('Use defaults'),
                detail: t('Fill the remaining header fields from workspace defaults.'),
                mode: 'defaults' as const
            },
            {
                label: t('Fill manually'),
                detail: t('Prompt for each remaining header field and prefill it from workspace defaults.'),
                mode: 'manual' as const
            }
        ],
        {
            placeHolder: t('How should the remaining scenario header fields be filled?'),
            title: t('Scenario header fields'),
            ignoreFocusOut: true
        }
    );

    if (!pickedMode) {
        return undefined;
    }

    if (pickedMode.mode === 'defaults') {
        return baseValues;
    }

    const project = await promptForRequiredString(
        t('Enter project name'),
        baseValues.project,
        t('Project cannot be empty')
    );
    if (project === undefined) {
        return undefined;
    }

    const allowCrossFunctionUsage = await promptForBooleanValue(
        t,
        t('Allow usage from other system functions?'),
        baseValues.allowCrossFunctionUsage
    );
    if (allowCrossFunctionUsage === undefined) {
        return undefined;
    }

    const userProfile = await promptForRequiredString(
        t('Enter user profile'),
        baseValues.userProfile,
        t('User profile cannot be empty')
    );
    if (userProfile === undefined) {
        return undefined;
    }

    const reportLevel1 = await promptForRequiredString(
        t('Enter report level 1'),
        baseValues.reportLevel1,
        t('Report level 1 cannot be empty')
    );
    if (reportLevel1 === undefined) {
        return undefined;
    }

    const reportLevel2Value = await promptForRequiredString(
        reportLevel2Prompt,
        baseValues.reportLevel2,
        t('Report level 2 cannot be empty')
    );
    if (reportLevel2Value === undefined) {
        return undefined;
    }

    return {
        ...baseValues,
        project,
        allowCrossFunctionUsage,
        userProfile,
        reportLevel1,
        reportLevel2: reportLevel2Value
    };
}

async function isExistingDirectory(uri: vscode.Uri): Promise<boolean> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
        return false;
    }
}

async function getDefaultMainScenarioDirectory(
    config: vscode.WorkspaceConfiguration
): Promise<vscode.Uri | undefined> {
    const workspaceRootUri = getWorkspaceRootUri();
    if (!workspaceRootUri) {
        return undefined;
    }

    const configuredYamlSourceDirectory = config.get<string>('paths.yamlSourceDirectory') || 'tests/RegressionTests/yaml';
    const yamlSourceDirectoryUri = vscode.Uri.joinPath(workspaceRootUri, configuredYamlSourceDirectory);
    const candidateDirectories = [
        vscode.Uri.joinPath(yamlSourceDirectoryUri, 'Drive', 'Parent scenarios'),
        vscode.Uri.joinPath(yamlSourceDirectoryUri, 'Parent scenarios'),
        yamlSourceDirectoryUri
    ];

    for (const candidateDirectory of candidateDirectories) {
        if (await isExistingDirectory(candidateDirectory)) {
            return candidateDirectory;
        }
    }

    return workspaceRootUri;
}

function normalizeScenarioName(name: string): string {
    return name.trim().toLocaleLowerCase();
}

function normalizeScenarioCode(code: string): string {
    return code.trim().toLocaleLowerCase();
}

function createEmptyScenarioIndex(): ScenarioIndex {
    return {
        names: new Set<string>(),
        codes: new Set<string>(),
        mainScenarioGroups: new Set<string>()
    };
}

function getWorkspaceRootUri(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
}

async function getKnownScenarioIndex(): Promise<ScenarioIndex> {
    const workspaceRootUri = getWorkspaceRootUri();
    if (!workspaceRootUri) {
        return createEmptyScenarioIndex();
    }

    const workspaceRoot = workspaceRootUri.toString();
    const now = Date.now();
    if (
        scenarioIndexCache &&
        scenarioIndexCache.workspaceRoot === workspaceRoot &&
        now - scenarioIndexCache.loadedAt < SCENARIO_INDEX_CACHE_TTL_MS
    ) {
        return scenarioIndexCache.index;
    }

    const discoveredTests = await scanWorkspaceForTests(workspaceRootUri);
    const index = createEmptyScenarioIndex();
    if (discoveredTests) {
        for (const [scenarioName, testInfo] of discoveredTests.entries()) {
            index.names.add(normalizeScenarioName(scenarioName));
            if (typeof testInfo?.name === 'string' && testInfo.name.trim().length > 0) {
                index.names.add(normalizeScenarioName(testInfo.name));
            }
            if (typeof testInfo?.scenarioCode === 'string' && testInfo.scenarioCode.trim().length > 0) {
                index.codes.add(normalizeScenarioCode(testInfo.scenarioCode));
            }
            if (typeof testInfo?.tabName === 'string' && testInfo.tabName.trim().length > 0) {
                index.mainScenarioGroups.add(testInfo.tabName.trim());
            }
        }
    }

    scenarioIndexCache = {
        workspaceRoot,
        loadedAt: now,
        index
    };
    return index;
}

function rememberScenarioInIndex(scenarioName: string, scenarioCode?: string, mainScenarioGroup?: string): void {
    const workspaceRootUri = getWorkspaceRootUri();
    if (!workspaceRootUri) {
        return;
    }

    const workspaceRoot = workspaceRootUri.toString();
    const normalizedName = normalizeScenarioName(scenarioName);
    const normalizedCode = (scenarioCode || '').trim()
        ? normalizeScenarioCode(scenarioCode || '')
        : undefined;
    const normalizedGroup = (mainScenarioGroup || '').trim();

    if (!scenarioIndexCache || scenarioIndexCache.workspaceRoot !== workspaceRoot) {
        const nextIndex = createEmptyScenarioIndex();
        nextIndex.names.add(normalizedName);
        if (normalizedCode) {
            nextIndex.codes.add(normalizedCode);
        }
        if (normalizedGroup) {
            nextIndex.mainScenarioGroups.add(normalizedGroup);
        }
        scenarioIndexCache = {
            workspaceRoot,
            loadedAt: Date.now(),
            index: nextIndex
        };
        return;
    }

    scenarioIndexCache.index.names.add(normalizedName);
    if (normalizedCode) {
        scenarioIndexCache.index.codes.add(normalizedCode);
    }
    if (normalizedGroup) {
        scenarioIndexCache.index.mainScenarioGroups.add(normalizedGroup);
    }
    scenarioIndexCache.loadedAt = Date.now();
}

function applyScenarioLanguage(templateContent: string, language: ScenarioLanguage): string {
    return templateContent.replace(/#language:\s*(en|ru)\b/g, `#language: ${language}`);
}

function buildDriveMainScenarioBlock(language: ScenarioLanguage, testClientAlias: string): string {
    const localizedBlock = DRIVE_MAIN_SCENARIO_BLOCK
        .split('\n')
        .map(line => applyPreferredStepKeyword(line, language))
        .join('\n');

    return replaceAllLiteral(localizedBlock, 'TestClientAlias_Placeholder', testClientAlias);
}

function applyMainScenarioDriveBlock(
    templateContent: string,
    includeDriveBlock: boolean,
    language: ScenarioLanguage,
    testClientAlias: string
): string {
    const block = includeDriveBlock ? buildDriveMainScenarioBlock(language, testClientAlias) : '';
    return templateContent.replace('    DriveMainScenarioBlock_Placeholder', block);
}

async function maybeAutoAddScenarioToFavorites(
    config: vscode.WorkspaceConfiguration,
    scenarioUri: vscode.Uri
): Promise<void> {
    const shouldAutoAdd = config.get<boolean>('phaseSwitcher.autoAddNewScenariosToFavorites', true);
    if (!shouldAutoAdd) {
        return;
    }
    const added = await vscode.commands.executeCommand<boolean>('kotTestToolkit._addScenarioFavoriteByUri', scenarioUri);
    if (added) {
        return;
    }

    await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcherFromCreate');
    await vscode.commands.executeCommand<boolean>('kotTestToolkit._addScenarioFavoriteByUri', scenarioUri);
}

/**
 * Обработчик команды создания вложенного сценария.
 * Запрашивает имя, код, папку, создает папку с кодом, файл scen.yaml и папку files.
 * @param context Контекст расширения для доступа к ресурсам (шаблонам).
 */
export async function handleCreateNestedScenario(context: vscode.ExtensionContext): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const config = vscode.workspace.getConfiguration('kotTestToolkit');
    const newScenarioDefaults = getNewScenarioDefaults(config);
    const newScenarioLanguage = getConfiguredScenarioLanguage(config);
    const knownScenarioIndex = await getKnownScenarioIndex();
    const knownScenarioNames = knownScenarioIndex.names;
    const knownScenarioCodes = knownScenarioIndex.codes;
    console.log("[Cmd:createNestedScenario] Starting...");
    let prefilledName = '';
    const editor = vscode.window.activeTextEditor;
    // Попытка предзаполнить имя из активного редактора
    if (editor) {
        try {
            const position = editor.selection.active;
            const line = editor.document.lineAt(position.line);
            const lineMatch = line.text.match(/^\s*(?:And|И|Допустим)\s+(.*)/i);
            if (lineMatch && lineMatch[1]) {
                prefilledName = lineMatch[1].trim();
            }
        } catch (e) {
            console.warn("[Cmd:createNestedScenario] Could not get prefilled name from editor:", e);
        }
    }

    // 1. Запрос имени
    const name = await vscode.window.showInputBox({
        prompt: t('Enter nested scenario name'),
        value: prefilledName,
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmedValue = value?.trim();
            if (!trimmedValue) {
                return t('Name cannot be empty');
            }
            if (knownScenarioNames.has(normalizeScenarioName(trimmedValue))) {
                return t('Scenario name "{0}" already exists.', trimmedValue);
            }
            return null;
        }
    });
    // Если пользователь нажал Escape или не ввел имя
    if (name === undefined) { console.log("[Cmd:createNestedScenario] Cancelled at name input."); return; }
    const trimmedName = name.trim();
    if (knownScenarioNames.has(normalizeScenarioName(trimmedName))) {
        vscode.window.showErrorMessage(t('Scenario name "{0}" already exists.', trimmedName));
        return;
    }

    // 2. Запрос кода
    const code = await vscode.window.showInputBox({
        prompt: t('Enter scenario numeric code (digits only)'),
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmedValue = value?.trim();
            if (!trimmedValue) return t('Code cannot be empty');
            if (!/^\d+$/.test(trimmedValue)) return t('Code must contain digits only');
            if (knownScenarioCodes.has(normalizeScenarioCode(trimmedValue))) {
                return t('Scenario code "{0}" already exists.', trimmedValue);
            }
            return null;
        }
    });
    if (code === undefined) { console.log("[Cmd:createNestedScenario] Cancelled at code input."); return; }
    const trimmedCode = code.trim();
    if (knownScenarioCodes.has(normalizeScenarioCode(trimmedCode))) {
        vscode.window.showErrorMessage(t('Scenario code "{0}" already exists.', trimmedCode));
        return;
    }

    // 3. Определение пути по умолчанию для диалога выбора папки
    let defaultDialogUri: vscode.Uri | undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.length) { // Проверяем, что воркспейс открыт
        const workspaceRootUri = workspaceFolders[0].uri;
        // Путь по умолчанию из настроек
        const defaultSubPath = config.get<string>('paths.yamlSourceDirectory') || 'tests/RegressionTests/yaml';
        try {
            defaultDialogUri = vscode.Uri.joinPath(workspaceRootUri, defaultSubPath);
            // console.log(`[Cmd:createNestedScenario] Default dialog path set to: ${defaultDialogUri.fsPath}`);
        } catch (error) {
            console.error(`[Cmd:createNestedScenario] Error constructing default path URI: ${error}`);
            defaultDialogUri = workspaceRootUri; // Откат к корню при ошибке
        }
    }

    // 4. Запрос пути для создания сценария (родительской папки)
    const folderUris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true, // Разрешаем выбор только папок
        canSelectMany: false, // Только одну папку
        openLabel: t('Create folder "{0}" here', trimmedCode),
        title: t('Select parent folder for nested scenario'),
        defaultUri: defaultDialogUri // Начинаем с пути по умолчанию
    });
    // Если пользователь не выбрал папку
    if (!folderUris || folderUris.length === 0) { console.log("[Cmd:createNestedScenario] Cancelled at folder selection."); return; }
    const baseFolderUri = folderUris[0]; // Выбранная родительская папка

    const selectedSystemFunction = await promptForSystemFunction(t, newScenarioDefaults);
    if (!selectedSystemFunction) {
        console.log("[Cmd:createNestedScenario] Cancelled at system function selection.");
        return;
    }

    const scenarioHeaderValues = await promptForScenarioHeaderValues(
        t,
        newScenarioDefaults,
        selectedSystemFunction,
        newScenarioDefaults.nestedReportLevel2,
        t('Enter report level 2 for nested scenario')
    );
    if (!scenarioHeaderValues) {
        console.log("[Cmd:createNestedScenario] Cancelled at scenario header values prompt.");
        return;
    }

    // 5. Создание папок и файла
    const newUid = uuidv4();
    const scenarioFolderUri = vscode.Uri.joinPath(baseFolderUri, trimmedCode); // Итоговая папка: parent/code
    const filesFolderUri = vscode.Uri.joinPath(scenarioFolderUri, 'files'); // Папка для файлов
    const templateUri = vscode.Uri.joinPath(context.extensionUri, 'res', 'scen.yaml'); // Шаблон
    const targetFileUri = vscode.Uri.joinPath(scenarioFolderUri, 'scen.yaml'); // Итоговый файл: parent/code/scen.yaml

    console.log(`[Cmd:createNestedScenario] Target folder: ${scenarioFolderUri.fsPath}`);
    // console.log(`[Cmd:createNestedScenario] Template path: ${templateUri.fsPath}`);

    try {
        // Создаем папку сценария (fs.createDirectory рекурсивна)
        await vscode.workspace.fs.createDirectory(scenarioFolderUri);
        // Создаем пустую папку files
        await vscode.workspace.fs.createDirectory(filesFolderUri);

        // Читаем шаблон
        const templateBytes = await vscode.workspace.fs.readFile(templateUri);
        const templateContent = Buffer.from(templateBytes).toString('utf-8');

        const templateWithDefaults = applyManagedScenarioHeaderDefaults(
            templateContent,
            scenarioHeaderValues
        );

        // Заменяем плейсхолдеры
        const finalContent = applyScenarioLanguage(
            applyTemplateReplacements(templateWithDefaults, {
                Name_Placeholder: escapeYamlDoubleQuotedString(trimmedName),
                Code_Placeholder: escapeYamlDoubleQuotedString(trimmedCode),
                UID_Placeholder: escapeYamlDoubleQuotedString(newUid)
            }),
            newScenarioLanguage
        );

        // Записываем новый файл
        await vscode.workspace.fs.writeFile(targetFileUri, Buffer.from(finalContent, 'utf-8'));
        rememberScenarioInIndex(trimmedName, trimmedCode);

        console.log(`[Cmd:createNestedScenario] Success! Created: ${targetFileUri.fsPath}`);
        vscode.window.showInformationMessage(t('Nested scenario "{0}" ({1}) has been created successfully!', trimmedName, trimmedCode));

        // Открываем созданный файл в редакторе
        const doc = await vscode.workspace.openTextDocument(targetFileUri);
        await vscode.window.showTextDocument(doc);

        // Обновляем Test Manager
        await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcherFromCreate');
        await maybeAutoAddScenarioToFavorites(config, targetFileUri);

    } catch (error: any) {
        console.error("[Cmd:createNestedScenario] Error:", error);
        vscode.window.showErrorMessage(t('Error creating nested scenario: {0}', error.message || String(error)));
    }
}


/**
 * Обработчик команды создания главного сценария.
 * Запрашивает имя, папку, создает папку с именем, файл scen.yaml, папку test с файлом name.yaml и папку files.
 * @param context Контекст расширения для доступа к ресурсам (шаблонам).
 */
export async function handleCreateMainScenario(context: vscode.ExtensionContext): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    const config = vscode.workspace.getConfiguration('kotTestToolkit');
    const newScenarioDefaults = getNewScenarioDefaults(config);
    const newScenarioLanguage = getConfiguredScenarioLanguage(config);
    const includeDriveBlock = config.get<boolean>('assembleScript.showDriveFeatures', false);
    const knownScenarioIndex = await getKnownScenarioIndex();
    const knownScenarioNames = knownScenarioIndex.names;
    const knownScenarioCodes = knownScenarioIndex.codes;
    const knownMainScenarioGroups = knownScenarioIndex.mainScenarioGroups;
    console.log("[Cmd:createMainScenario] Starting...");
    // 1. Запрос имени
    const name = await vscode.window.showInputBox({
        prompt: t('Enter main scenario name (folder name)'),
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmedValue = value?.trim();
            if (!trimmedValue) return t('Name cannot be empty');
            if (/[/\\:*\?"<>|]/.test(trimmedValue)) return t('Name contains invalid characters');
            if (knownScenarioNames.has(normalizeScenarioName(trimmedValue))) {
                return t('Scenario name "{0}" already exists.', trimmedValue);
            }
            if (knownScenarioCodes.has(normalizeScenarioCode(trimmedValue))) {
                return t('Scenario code "{0}" already exists.', trimmedValue);
            }
            return null;
        }
    });
    if (name === undefined) { console.log("[Cmd:createMainScenario] Cancelled at name input."); return; }
    const trimmedName = name.trim();
    if (knownScenarioNames.has(normalizeScenarioName(trimmedName))) {
        vscode.window.showErrorMessage(t('Scenario name "{0}" already exists.', trimmedName));
        return;
    }
    if (knownScenarioCodes.has(normalizeScenarioCode(trimmedName))) {
        vscode.window.showErrorMessage(t('Scenario code "{0}" already exists.', trimmedName));
        return;
    }

    // 2. Запрос имени вкладки/фазы
    const tabName = await promptForMainScenarioGroup(t, knownMainScenarioGroups);
    if (tabName === undefined) { console.log("[Cmd:createMainScenario] Cancelled at tab name input."); return; }
    const trimmedTabName = tabName.trim();

    // 3. Запрос порядка сортировки (необязательно)
    const orderStr = await vscode.window.showInputBox({
        prompt: t('Enter order within the group'),
        placeHolder: t('Optional'),
        ignoreFocusOut: true,
        validateInput: value => (!value || /^\d+$/.test(value.trim())) ? null : t('Must be an integer or empty')
    });
    // Если пользователь нажал Esc, orderStr будет undefined. Если ввел и стер - пустая строка.
    if (orderStr === undefined) { console.log("[Cmd:createMainScenario] Cancelled at order input."); return; }
    // Сохраняем как строку (или пустую строку) для замены плейсхолдера
    const orderForTemplate = orderStr?.trim() || ""; // Если пусто, плейсхолдер заменится на пустую строку

    // 4. Запрос состояния по умолчанию (QuickPick)
    const defaultStatePick = await vscode.window.showQuickPick(['true', 'false'], {
        placeHolder: t('Default state in Test Manager (optional)'),
        canPickMany: false,
        ignoreFocusOut: true,
        title: t('Checkbox enabled by default?')
    });
    // Если пользователь нажал Esc, defaultStatePick будет undefined. Считаем это как 'true'.
    const defaultStateStr = defaultStatePick || 'true'; // Строка 'true' или 'false'


    // 2. Определение пути по умолчанию для диалога выбора папки
    let defaultDialogUri: vscode.Uri | undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.length) {
        defaultDialogUri = await getDefaultMainScenarioDirectory(config);
    }

    // 3. Запрос пути для создания (родительской папки)
    const folderUris = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: t('Create folder "{0}" here', trimmedName),
        title: t('Select parent folder for main scenario'),
        defaultUri: defaultDialogUri
    });
    if (!folderUris || folderUris.length === 0) { console.log("[Cmd:createMainScenario] Cancelled at folder selection."); return; }
    const baseFolderUri = folderUris[0];

    const selectedSystemFunction = await promptForSystemFunction(t, newScenarioDefaults);
    if (!selectedSystemFunction) {
        console.log("[Cmd:createMainScenario] Cancelled at system function selection.");
        return;
    }

    const scenarioHeaderValues = await promptForScenarioHeaderValues(
        t,
        newScenarioDefaults,
        selectedSystemFunction,
        newScenarioDefaults.mainReportLevel2,
        t('Enter report level 2 for main scenario')
    );
    if (!scenarioHeaderValues) {
        console.log("[Cmd:createMainScenario] Cancelled at scenario header values prompt.");
        return;
    }

    const modelDBid = await promptForModelDbId(t, context);
    if (modelDBid === undefined) {
        console.log("[Cmd:createMainScenario] Cancelled at ModelDBid prompt.");
        return;
    }

    // 4. Подготовка путей и UID
    const mainUid = uuidv4();
    const testRandomUid = uuidv4();
    const scenarioFolderUri = vscode.Uri.joinPath(baseFolderUri, trimmedName); // parent/ScenarioName
    const testFolderUri = vscode.Uri.joinPath(scenarioFolderUri, 'test'); // parent/ScenarioName/test
    const filesFolderUri = vscode.Uri.joinPath(scenarioFolderUri, 'files'); // parent/ScenarioName/files
    const testTemplateUri = vscode.Uri.joinPath(context.extensionUri, 'res', 'test.yaml'); // Шаблон теста
    const mainTemplateUri = vscode.Uri.joinPath(context.extensionUri, 'res', 'main.yaml'); // Шаблон основного файла
    const testTargetFileUri = vscode.Uri.joinPath(testFolderUri, `${trimmedName}.yaml`);
    const mainTargetFileUri = vscode.Uri.joinPath(scenarioFolderUri, 'scen.yaml');

    console.log(`[Cmd:createMainScenario] Target folder: ${scenarioFolderUri.fsPath}`);
    // console.log(`[Cmd:createMainScenario] Test template: ${testTemplateUri.fsPath}`);
    // console.log(`[Cmd:createMainScenario] Main template: ${mainTemplateUri.fsPath}`);

    try {
        // Создаем папку сценария и вложенные папки test и files (рекурсивно)
        await vscode.workspace.fs.createDirectory(testFolderUri);
        await vscode.workspace.fs.createDirectory(filesFolderUri);

        // --- Создаем тестовый файл ---
        const testTemplateBytes = await vscode.workspace.fs.readFile(testTemplateUri);
        const testTemplateContent = Buffer.from(testTemplateBytes).toString('utf-8');
        const testFinalContent = applyTemplateReplacements(testTemplateContent, {
            Name_Placeholder: escapeYamlDoubleQuotedString(trimmedName),
            UID_Placeholder: escapeYamlDoubleQuotedString(mainUid),
            Random_UID: escapeYamlDoubleQuotedString(testRandomUid),
            ModelDBib_Placeholder: escapeYamlDoubleQuotedString(`${modelDBid}`),
            UserProfile_Placeholder: escapeYamlDoubleQuotedString(scenarioHeaderValues.userProfile)
        });
        await vscode.workspace.fs.writeFile(testTargetFileUri, Buffer.from(testFinalContent, 'utf-8'));
        console.log(`[Cmd:createMainScenario] Created test file: ${testTargetFileUri.fsPath} with ModelDBid: ${modelDBid}`);


        // --- Создаем основной файл сценария ---
        const mainTemplateBytes = await vscode.workspace.fs.readFile(mainTemplateUri);
        const mainTemplateContent = Buffer.from(mainTemplateBytes).toString('utf-8');
        const mainTemplateWithDefaults = applyManagedScenarioHeaderDefaults(
            mainTemplateContent,
            scenarioHeaderValues
        );
        // В главном шаблоне Code_Placeholder заменяется на имя сценария
        const mainFinalContent = applyMainScenarioDriveBlock(
            applyScenarioLanguage(
                applyTemplateReplacements(mainTemplateWithDefaults, {
                    Name_Placeholder: escapeYamlDoubleQuotedString(trimmedName),
                    Code_Placeholder: escapeYamlDoubleQuotedString(trimmedName),
                    UID_Placeholder: escapeYamlDoubleQuotedString(mainUid),
                    Phase_Placeholder: escapeYamlDoubleQuotedString(trimmedTabName),
                    Default_Placeholder: defaultStateStr,
                    Order_Placeholder: orderForTemplate
                }),
                newScenarioLanguage
            ),
            includeDriveBlock,
            newScenarioLanguage,
            scenarioHeaderValues.userProfile
        );
        await vscode.workspace.fs.writeFile(mainTargetFileUri, Buffer.from(mainFinalContent, 'utf-8'));
        rememberScenarioInIndex(trimmedName, trimmedName, trimmedTabName);
        console.log(`[Cmd:createMainScenario] Created main scenario file: ${mainTargetFileUri.fsPath}`);

        vscode.window.showInformationMessage(t('Main scenario "{0}" has been created successfully!', trimmedName));
        // Открываем основной созданный файл
        const doc = await vscode.workspace.openTextDocument(mainTargetFileUri);
        await vscode.window.showTextDocument(doc);

        // Обновляем Test Manager
        await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcherFromCreate');
        await maybeAutoAddScenarioToFavorites(config, mainTargetFileUri);

    } catch (error: any) {
        console.error("[Cmd:createMainScenario] Error:", error);
        vscode.window.showErrorMessage(t('Error creating main scenario: {0}', error.message || String(error)));
    }
}
