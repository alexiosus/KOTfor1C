(function(root) {
    const key = value => String(value || '').trim().toLowerCase().replace(/[_\-\s]/g, '');
    const folderAliases = ['LaunchDBFolder', 'TestClientDBPath'];
    const connectionAliases = ['TestClientDB', 'InfobasePath'];
    const managedKeys = new Set(['resultfile', 'logfile', 'errorfolder']);
    const truthy = value => /^(true|истина|yes|да|1)$/i.test(String(value || '').trim());
    function parameterValue(name, value) {
        if (Array.isArray(value) && ['libraries', 'vanessalibraries'].includes(key(name))) {
            return value.map(item => String(item ?? '')).join('|');
        }
        return String(value ?? '');
    }
    function pick(rows, aliases) {
        for (const alias of aliases) {
            const found = [...rows].reverse().find(row => key(row.key) === key(alias));
            if (found) { return { key: found.key, value: parameterValue(found.key, found.value) }; }
        }
        return undefined;
    }
    function defaultValue(name, defaults) {
        const aliases = folderAliases.some(alias => key(alias) === key(name)) ? folderAliases
            : connectionAliases.some(alias => key(alias) === key(name)) ? connectionAliases : [name];
        return pick(defaults, aliases)?.value ?? '';
    }
    function normalize(params, defaults) {
        const read = name => pick(params, [name]);
        const fallback = name => read(name)?.value ?? defaultValue(name, defaults);
        const testFolder = read('TestFolder');
        const vanessa = pick(params, ['VanessaPath', 'VanessaFolder', 'VanessaDir']);
        const folder = pick(params, folderAliases);
        const connection = pick(params, connectionAliases);
        let vanessaFolder = vanessa?.value ?? defaultValue('VanessaFolder', defaults);
        if (/\.epf[\\/]*$/i.test(vanessaFolder)) {
            vanessaFolder = vanessaFolder.replace(/[\\/]*$/, '');
            vanessaFolder = /[\\/]/.test(vanessaFolder)
                ? vanessaFolder.replace(/[\\/][^\\/]+$/, '') || '/' : '.';
        }
        const rows = [
            { key: 'ScenarioFolder', value: testFolder?.value ?? fallback('ScenarioFolder') },
            { key: 'FeatureFolder', value: fallback('FeatureFolder') },
            { key: 'VanessaFolder', value: vanessaFolder },
            { key: 'ModelDBSettings', value: fallback('ModelDBSettings') },
            { key: 'AuthCompile', value: truthy(fallback('AuthCompile')) ? 'True' : 'False' }
        ];
        if (folder) { rows.push(folder); }
        else if (!connection) { rows.push({ key: 'LaunchDBFolder', value: '' }); }
        if (connection) { rows.push(connection); }
        if (testFolder) { rows.push({ key: 'ProcessFolder', value: testFolder.value }); }
        else if (!read('ProcessFolder')) { rows.push({ key: 'ProcessFolder', value: fallback('ScenarioFolder') }); }
        const absorbed = new Set(['scenariofolder', 'testfolder', 'featurefolder', 'vanessafolder', 'vanessadir', 'vanessapath', 'modeldbsettings', 'authcompile', ...folderAliases.map(key), ...connectionAliases.map(key)]);
        if (testFolder) { absorbed.add('processfolder'); }
        for (const param of params) {
            if (!absorbed.has(key(param.key))) { rows.push({ key: String(param.key || '').trim(), value: parameterValue(param.key, param.value) }); }
        }
        return rows;
    }
    function requiredMissing(name, params) {
        const read = aliases => pick(params, aliases)?.value.trim() || '';
        const normalized = key(name);
        const compileOnly = /^false$|^ложь$/i.test(read(['CreateJson']));
        if (normalized === 'scenariofolder' || normalized === 'testfolder') { return !read(['TestFolder', 'ScenarioFolder']); }
        if (normalized === 'featurefolder') { return !read(['FeatureFolder']); }
        if (normalized === 'modeldbsettings') { return truthy(read(['AuthCompile'])) && !read(['ModelDBSettings']); }
        if (normalized === 'vanessafolder') { return !compileOnly && !read(['VanessaPath', 'VanessaFolder', 'VanessaDir']); }
        if ([...folderAliases, ...connectionAliases].some(alias => key(alias) === normalized)) {
            return !compileOnly && !read(connectionAliases) && !read(folderAliases);
        }
        return false;
    }
    function rowPolicy(name, definitions) {
        const normalized = key(name);
        return {
            hidden: normalized === 'splitfeaturefiles' && !definitions.some(definition => key(definition.key) === normalized),
            readOnly: managedKeys.has(normalized)
        };
    }
    function canAddParameter(name, rows, definitions) {
        const policy = rowPolicy(name, definitions);
        if (policy.hidden || policy.readOnly || rows.some(row => key(row.key) === key(name))) { return false; }
        const aliases = [folderAliases, connectionAliases].find(group => group.some(alias => key(alias) === key(name)));
        return !aliases || !pick(rows, aliases);
    }
    function availableDefinitions(rows, definitions) {
        return definitions.filter(definition => !definition.fixed && canAddParameter(definition.key, rows, definitions));
    }
    root.KotYamlBuildParameterState = { normalize, defaultValue, requiredMissing, rowPolicy, canAddParameter, availableDefinitions, folderAliases, connectionAliases };
})(typeof window === 'undefined' ? globalThis : window);
