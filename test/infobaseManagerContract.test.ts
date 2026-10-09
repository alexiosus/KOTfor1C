import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const managerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'infobaseManager.ts'),
    'utf8'
);
const sidebarSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'infobaseSidebarProvider.ts'),
    'utf8'
);
const platformSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'oneCPlatform.ts'),
    'utf8'
);

test('sidebar launches always request a platform without changing manager-panel launches', () => {
    assert.match(managerSource, /forcePlatformPicker\?: boolean/u);
    assert.match(
        sidebarSource,
        /openInfobaseInEnterprise\(context, infobase, \{\s*forcePlatformPicker: true\s*\}\)/u
    );
    assert.match(
        sidebarSource,
        /openInfobaseInDesigner\(context, infobase, \{\s*forcePlatformPicker: true\s*\}\)/u
    );

    const resolverStart = managerSource.indexOf('async function resolveManagedInfobaseLaunchPlatform(');
    const resolverEnd = managerSource.indexOf(
        'async function resolvePreferredPlatformMetadataPatchValue',
        resolverStart
    );
    const resolverSource = managerSource.slice(resolverStart, resolverEnd);
    assert.match(resolverSource, /if \(storedClientPath && !options\?\.forcePlatformPicker\)/u);
    assert.match(resolverSource, /forcePicker: options\?\.forcePlatformPicker === true/u);
    assert.match(resolverSource, /persistSelection: !options\?\.forcePlatformPicker/u);
    assert.match(
        platformSource,
        /configuredPlatforms\.length === 1 && !options\?\.forcePicker/u
    );
});

test('empty infobase login explicitly retries without authentication arguments', () => {
    const promptStart = managerSource.indexOf('async function promptInfobaseAuthentication(');
    const promptEnd = managerSource.indexOf(
        'export function getCachedInfobaseAuthentication',
        promptStart
    );
    const promptSource = managerSource.slice(promptStart, promptEnd);

    assert.match(promptSource, /const normalizedUsername = username\.trim\(\);/u);
    assert.match(
        promptSource,
        /if \(!normalizedUsername\) \{\s*return \{ username: '', password: '' \};\s*\}/u
    );
    assert.ok(
        promptSource.indexOf('if (!normalizedUsername)')
            < promptSource.indexOf("title: t('Enter infobase password')"),
        'password must not be requested for an anonymous infobase'
    );
    assert.doesNotMatch(promptSource, /\|\| 'Administrator'/u);
});
