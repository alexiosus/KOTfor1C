import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActiveYamlParametersProfile } from '../src/activeYamlParametersProfile';
import {
    buildInfobaseSidebarModel,
    resolveActiveProfileInfobasePath
} from '../src/infobaseSidebarModel';
import type { ManagedInfobaseRecord } from '../src/infobaseManager';
import type { ManagedInfobaseSnapshot } from '../src/managedInfobaseService';
import { normalizeInfobaseConnectionIdentity } from '../src/oneCInfobaseConnection';

function profile(key: string, value: string): ActiveYamlParametersProfile {
    return Object.freeze({
        id: 'profile-one',
        name: 'Profile one',
        buildParameters: Object.freeze([Object.freeze({ key, value })]),
        additionalVanessaParameters: Object.freeze([]),
        globalVanessaVariables: Object.freeze([])
    });
}

function record(overrides: Partial<ManagedInfobaseRecord> & Pick<ManagedInfobaseRecord, 'id' | 'infobasePath' | 'displayName'>): ManagedInfobaseRecord {
    return {
        id: overrides.id,
        infobaseKind: overrides.infobaseKind ?? 'file',
        infobasePath: overrides.infobasePath,
        locationLabel: overrides.locationLabel ?? overrides.infobasePath,
        displayName: overrides.displayName,
        launcherName: overrides.launcherName ?? null,
        launcherRegistered: overrides.launcherRegistered ?? false,
        exists: overrides.exists ?? true,
        markerExists: overrides.markerExists ?? true,
        state: overrides.state ?? 'ready',
        roles: overrides.roles ?? [],
        sources: overrides.sources ?? ['manual'],
        lastLaunchAt: overrides.lastLaunchAt ?? null,
        lastLaunchKind: overrides.lastLaunchKind ?? null,
        lastSnapshotPath: overrides.lastSnapshotPath ?? null,
        lastSnapshotAt: overrides.lastSnapshotAt ?? null,
        lastRunLogPath: overrides.lastRunLogPath ?? null,
        lastRunLogAt: overrides.lastRunLogAt ?? null,
        startupParametersMode: overrides.startupParametersMode ?? 'none',
        startupParameters: overrides.startupParameters ?? null,
        preferredPlatformClientExePath: overrides.preferredPlatformClientExePath ?? null,
        logTargets: overrides.logTargets ?? [],
        hidden: overrides.hidden ?? false
    };
}

function snapshot(
    activeInfobaseIdentity: string | null,
    infobases: readonly ManagedInfobaseRecord[]
): ManagedInfobaseSnapshot {
    return Object.freeze({
        revision: 1,
        profileId: 'profile-one',
        profileName: 'Profile one',
        activeInfobaseIdentity,
        infobases: Object.freeze([...infobases])
    });
}

test('resolves every supported active-profile alias case and separator insensitively', () => {
    for (const key of [
        'LaunchDBFolder',
        'launch_db_folder',
        'LAUNCH-DB-FOLDER',
        'test_client_db_path',
        'Infobase-Path',
        'TESTCLIENTDB'
    ]) {
        assert.equal(
            resolveActiveProfileInfobasePath(profile(key, 'runtime/base'), path.resolve("/workspace/project")),
            path.resolve("/workspace/project/runtime/base"),
            key
        );
    }
});

test('resolves relative File connections but preserves server and web references', () => {
    assert.equal(
        resolveActiveProfileInfobasePath(profile('LaunchDBFolder', 'File="runtime/base";'), path.resolve("/workspace/project")),
        path.resolve("/workspace/project/runtime/base")
    );
    assert.equal(
        resolveActiveProfileInfobasePath(profile('TestClientDB', 'Srvr="SERVER";Ref="Trade";'), path.resolve("/workspace")),
        'Srvr=SERVER;Ref=Trade;'
    );
    assert.equal(
        resolveActiveProfileInfobasePath(profile('InfobasePath', 'ws="https://example.test/base";'), path.resolve("/workspace")),
        'ws=https://example.test/base;'
    );
    assert.equal(resolveActiveProfileInfobasePath(profile('Other', 'runtime/base'), path.resolve("/workspace")), null);
});

test('marks normalized file, server, and web identities as active', () => {
    const cases = [
        [path.resolve("/workspace/base"), normalizeInfobaseConnectionIdentity(path.resolve("/workspace/base")), 'file'],
        ['Srvr="SERVER";Ref="Trade";', 'srvr=server;ref=trade', 'server'],
        ['ws="https://example.test/base";', 'ws=https://example.test/base', 'web']
    ] as const;
    for (const [reference, identity, kind] of cases) {
        const model = buildInfobaseSidebarModel(snapshot(identity, [record({
            id: identity,
            infobasePath: reference,
            infobaseKind: kind,
            displayName: 'Active base'
        })]));
        assert.equal(model.items[0]?.active, true, reference);
    }
});

test('projects KOT-launched runtime state without treating the active profile as runtime state', () => {
    const activePath = path.resolve("/workspace/z-active");
    const project = buildInfobaseSidebarModel as unknown as (
        value: ManagedInfobaseSnapshot,
        runningIdentities: ReadonlySet<string>
    ) => ReturnType<typeof buildInfobaseSidebarModel>;
    const model = project(snapshot(
        normalizeInfobaseConnectionIdentity(activePath),
        [
            record({ id: 'alpha', infobasePath: path.resolve("/workspace/alpha"), displayName: 'Alpha' }),
            record({ id: 'hidden', infobasePath: path.resolve("/workspace/hidden"), displayName: 'Hidden', hidden: true }),
            record({ id: 'active', infobasePath: activePath, displayName: 'Zulu active' }),
            record({ id: 'beta', infobasePath: path.resolve("/workspace/beta"), displayName: 'Beta' })
        ]
    ), new Set([normalizeInfobaseConnectionIdentity(path.resolve("/workspace/beta"))]));

    assert.deepEqual(model.items.map(item => [item.id, item.running]), [
        ['alpha', false],
        ['beta', true],
        ['active', false]
    ]);
    assert.equal(model.items.some(item => item.id === 'hidden'), false);
    assert.ok(Object.isFrozen(model));
    assert.ok(Object.isFrozen(model.items));
});
