const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const manifest = read('package.json');
const translations = read('package.nls.ru.json');
const presentation = read('media/kotSettingsModel.json');
const localize = value => typeof value === 'string' && /^%.*%$/u.test(value) ? translations[value.slice(1, -1)] || value : value;
const cell = value => String(value ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>');
const properties = Object.assign({}, ...manifest.contributes.configuration.map(section => section.properties));
let settings = '# Справочник настроек\n\nСоздан из `package.json` и локализации KOT. Для редактирования используйте [страницу настроек](../guides/first-run-settings.md). Значения, идентификаторы и варианты здесь не переименовываются.\n\nОбновление: `npm run docs:reference`.\n\n';
settings += 'Области: `window` — окно; `resource` — ресурс/папка; остальные значения следуют VS Code configuration scope. В обычном окне одной папки проектные настройки соответствуют Workspace. В multi-root доступность Folder зависит от scope.\n\n';
for (const section of presentation.sections) {
    settings += `## ${section.title}\n\n`;
    for (const item of presentation.settings.filter(item => item.section === section.id)) {
        const value = properties[item.key];
        if (!value) { throw new Error(`Unknown presentation setting: ${item.key}`); }
        settings += `### ${item.label}\n\n\`${item.key}\`\n\n${localize(value.markdownDescription || value.description || '')}\n\n`;
        settings += `Тип: \`${JSON.stringify(value.type)}\`. Область: \`${value.scope || 'window'}\`.\n\n`;
        settings += `Значение по умолчанию:\n\n\`\`\`json\n${JSON.stringify(value.default ?? null, null, 2)}\n\`\`\`\n\n`;
        if (value.enum) { settings += 'Допустимые значения: ' + value.enum.map(option => '`' + JSON.stringify(option) + '`').join(', ') + '.\n\n'; }
        if (value.items?.enum) { settings += 'Элементы списка: ' + value.items.enum.map(option => '`' + option + '`').join(', ') + '.\n\n'; }
    }
}
const presented = new Set(presentation.settings.map(setting => setting.key));
if (presented.size !== Object.keys(properties).length || Object.keys(properties).some(key => !presented.has(key))) { throw new Error('Settings presentation must cover every manifest key'); }
fs.writeFileSync(path.join(root, 'docs/technical/settings-reference.md'), settings.trimEnd() + '\n');
let commands = '# Команды и сочетания клавиш\n\nСправочник создан из manifest KOT. Пользовательские маршруты описаны в [руководстве](../README.md). Наличие команды не означает применимость к любому документу: контекст, состояние сеанса и необходимые файлы проверяются отдельно.\n\nОбновление: `npm run docs:reference`.\n\n## Объявленные сочетания\n\n| Команда | Windows/Linux | macOS | Условие |\n|---|---|---|---|\n';
for (const binding of manifest.contributes.keybindings) { commands += `| \`${binding.command}\` | ${cell(binding.key)} | ${cell(binding.mac || binding.key)} | ${cell(binding.when)} |\n`; }
commands += '\nПользовательские сочетания VS Code могут переопределить эти значения.\n\n## Идентификаторы команд\n\n| Название | Идентификатор |\n|---|---|\n';
for (const command of manifest.contributes.commands) { commands += `| ${cell(localize(command.title))} | \`${command.command}\` |\n`; }
fs.writeFileSync(path.join(root, 'docs/technical/commands-reference.md'), commands.trimEnd() + '\n');
console.log(`Documentation references: ${Object.keys(properties).length} settings, ${manifest.contributes.commands.length} commands, ${manifest.contributes.keybindings.length} keybindings.`);
