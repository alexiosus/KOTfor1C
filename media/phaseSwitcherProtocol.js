(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.PhaseSwitcherProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    function getScenarioKey(testInfo) {
        return typeof testInfo?.scenarioKey === 'string'
            ? testInfo.scenarioKey.trim()
            : '';
    }

    function createScenarioCommand(command, testInfo, extra = {}) {
        const key = getScenarioKey(testInfo);
        if (!key) {
            throw new Error('Scenario runtime key is required');
        }

        return {
            command,
            key,
            name: typeof testInfo?.name === 'string' ? testInfo.name : '',
            uri: typeof testInfo?.yamlFileUriString === 'string'
                ? testInfo.yamlFileUriString
                : key,
            ...extra
        };
    }

    return { getScenarioKey, createScenarioCommand };
});
