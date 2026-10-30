import { normalizeBuildParameterKey, type CompilerBuildParameter } from './compilerBuildParameters';

export type CompilerBuildValueIssue = Readonly<{ parameter: string; code: string; message: string }>;
export type CompilerBuildValueHint = Readonly<{
    valueKind: 'boolean' | 'number' | 'xmlDateTime';
    min?: number;
    max?: number;
    step?: number | 'any';
    allowBlank: boolean;
}>;

// Supplied compiler Form.Module: СтрокуВБулево and ЗаполнитьПараметрыОбработки.
// DebugMode is also an xs:boolean attribute, used directly in a Boolean condition.
const booleanDefaults = new Set([
    'authcompile', 'capturescreen', 'usescreenshotcomponent', 'useexternalcomponent',
    'pidinformation', 'allurereport', 'safestepsexecution', 'junitreport', 'cucumberreport', 'spprreport'
]);
const booleanKeys = new Set([
    ...booleanDefaults, 'createjson', 'createjunit', 'debugmode', 'externalmode',
    'createmodellingxml', 'severalscenariosinonefile', 'scenariofilterhaspriority', 'splitfeaturefiles'
]);
const nonnegativeKeys = new Set(['pauseonwindowsopening', 'waitwindowtime', 'timeoutforasyncsteps', 'timeouttestclientstart']);
const partitionKeys = new Set(['threadscount', 'threadtotal', 'threadnumber', 'threadindex']);
const supportedBooleans = new Set(['true', 'false', 'истина', 'ложь']);

export function getCompilerBuildValueHint(key: string): CompilerBuildValueHint | undefined {
    const normalized = normalizeBuildParameterKey(key);
    if (booleanKeys.has(normalized)) { return Object.freeze({ valueKind: 'boolean', allowBlank: booleanDefaults.has(normalized) }); }
    if (normalized === 'testclientport') { return Object.freeze({ valueKind: 'number', min: 1, max: 65535, step: 1, allowBlank: true }); }
    if (nonnegativeKeys.has(normalized)) { return Object.freeze({ valueKind: 'number', min: 0, step: 'any', allowBlank: true }); }
    if (normalized === 'numberofattempts' || normalized === 'threadscount' || normalized === 'threadtotal') {
        return Object.freeze({ valueKind: 'number', min: 1, max: Number.MAX_SAFE_INTEGER, step: 1, allowBlank: true });
    }
    if (normalized === 'threadnumber' || normalized === 'threadindex') { return Object.freeze({ valueKind: 'number', step: 1, allowBlank: true }); }
    if (normalized === 'detectiontime') { return Object.freeze({ valueKind: 'xmlDateTime', allowBlank: true }); }
    return undefined;
}

function decimalNumber(value: string): number {
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) ? Number(value) : Number.NaN;
}

/** XML Schema dateTime lexical/calendar checks, within the 1C Date year range.
 * https://www.w3.org/TR/xmlschema-2/#dateTime
 * Avoid Date.parse: it accepts incomplete formats and normalizes impossible dates.
 */
function isXmlDateTime(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))?$/u.exec(value);
    if (!match) { return false; }
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1 || minute > 59 || second > 59 || hour > 24) { return false; }
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day > days[month - 1]) { return false; }
    if (hour === 24 && (minute !== 0 || second !== 0 || /[1-9]/u.test(match[7] || '') || (year === 9999 && month === 12 && day === 31))) { return false; }
    if (match[8]) {
        const zoneHour = Number(match[9]); const zoneMinute = Number(match[10]);
        if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) { return false; }
    }
    return true;
}

/** Validates effective known values without coercing inputs or exposing their contents. */
export function collectCompilerBuildValueIssues(parameters: readonly CompilerBuildParameter[]): readonly CompilerBuildValueIssue[] {
    const values = new Map(parameters.map(parameter => [normalizeBuildParameterKey(parameter.key), parameter]));
    const issues: CompilerBuildValueIssue[] = [];
    const issue = (parameter: CompilerBuildParameter, code: string, message: string) => {
        issues.push(Object.freeze({ parameter: parameter.key, code, message }));
    };
    for (const [key, parameter] of values) {
        if (partitionKeys.has(key)) { continue; }
        const hint = getCompilerBuildValueHint(key);
        if (!hint) { continue; }
        const value = String(parameter.value).trim();
        if (!value && hint.allowBlank) { continue; }
        if (hint.valueKind === 'boolean') {
            if (!supportedBooleans.has(value.toLowerCase())) { issue(parameter, 'invalidBoolean', '{0} must be True, False, Истина or Ложь.'); }
        } else if (hint.valueKind === 'xmlDateTime') {
            if (!isXmlDateTime(value)) { issue(parameter, 'invalidXmlDateTime', '{0} must be a complete XML date and time with a valid calendar date, for example 2026-10-15T12:30:00Z.'); }
        } else {
            const number = decimalNumber(value);
            if (key === 'testclientport' && (!Number.isSafeInteger(number) || number < 1 || number > 65535)) {
                issue(parameter, 'invalidPort', '{0} must be an integer from 1 to 65535.');
            } else if (key === 'numberofattempts' && (!Number.isSafeInteger(number) || number < 1)) {
                issue(parameter, 'invalidPositiveInteger', '{0} must be a positive safe integer.');
            } else if (nonnegativeKeys.has(key) && (!Number.isFinite(number) || number < 0)) {
                issue(parameter, 'invalidNonnegativeNumber', '{0} must be a finite nonnegative number.');
            }
        }
    }

    // Exactly the alias precedence and integer/clamp policy of planCompilerBuildJobs.
    const count = values.get('threadtotal')?.value ? values.get('threadtotal') : values.get('threadscount');
    if (count?.value && (!Number.isSafeInteger(Number(count.value)) || Number(count.value) < 1)) {
        issue(count, 'invalidPartitionCount', '{0} must be a positive safe integer.');
    }
    const index = values.get('threadindex')?.value.trim() ? values.get('threadindex') : values.get('threadnumber');
    if (index?.value.trim()) {
        const requested = Number(index.value) + (normalizeBuildParameterKey(index.key) === 'threadnumber' ? 1 : 0);
        if (!Number.isSafeInteger(requested)) { issue(index, 'invalidPartitionIndex', '{0} must be a safe integer; SPPR clamps the partition index to its available range.'); }
    }
    return Object.freeze(issues);
}
