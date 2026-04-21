# Функциональные блоки KOT for 1C

Этот раздел разбивает расширение на отдельные пользовательские блоки.

## Список блоков

1. [`test-manager.md`](./test-manager.md) — группы тестов, избранное, статусы, массовые действия.
2. [`editor-and-intellisense.md`](./editor-and-intellisense.md) — автодополнение, hover, автоформат, автоподдержка секций.
3. [`diagnostics-and-quick-fix.md`](./diagnostics-and-quick-fix.md) — правила диагностики, подсветка, quick fix.
4. [`build-and-vanessa-run.md`](./build-and-vanessa-run.md) — сборка сценариев и запуск Vanessa.
5. [`parameters-manager.md`](./parameters-manager.md) — СППР/Доп. параметры/GlobalVars.
6. [`scenario-parameters.md`](./scenario-parameters.md) — объявление/передача параметров, дефолты, `$...$`-переменные.
7. [`scenario-creation.md`](./scenario-creation.md) — создание главных и вложенных сценариев, `test.yaml`, defaults и служебные поля шапки.
8. [`metadata-and-cache.md`](./metadata-and-cache.md) — `KOTМетаданные`, кеш сценариев, stale-логика.
9. [`ai-description.md`](./ai-description.md) — AI-описание сценариев, AI-отчет по diff конфигурации, AI-ревью тестов и подключение LLM.
10. [`navigation-and-files.md`](./navigation-and-files.md) — навигация по сценариям и работа с MXL/файлами.
11. [`platform-manager.md`](./platform-manager.md) — каталог платформ 1С, платформа по умолчанию, автообнаружение и выбор платформы при запуске.
12. [`form-explorer.md`](./form-explorer.md) — KOT Form Explorer (beta): bridge через `TestManager` / `TestClient`, snapshot текущей формы, auto/manual режим и static enrichment из `cf`.
13. [`infobase-manager.md`](./infobase-manager.md) — единый менеджер ИБ: список установленных баз, подготовка баз, ключи запуска, платформа конкретной базы, редактирование баз и связь с Vanessa/Form Explorer.
14. [`etalon-bases.md`](./etalon-bases.md) — каталог `bases.yaml`, эталонные базы, `DT`, профили пользователей и связь с `test.yaml` / `ModelDBSettings`.
