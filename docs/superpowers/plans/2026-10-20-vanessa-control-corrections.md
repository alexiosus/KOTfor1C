# Vanessa control corrections Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Preserve accumulated changes and the existing service/client sessions. No commit, push or release in this iteration.

**Goal:** Исправить перечисленные пользователем регрессии записи, языка, дерева, подсказок и исполнения; отдельно проработать объединение подключений с Infobase Manager.

**Architecture:** Существующие session/typed adapters остаются единственным транспортом. Источник формы общий для панели и редактора. Подготовка/проверка сохранённого feature выполняется по команде, без фонового сброса выполняющегося теста при навигации.

**Tech Stack:** TypeScript, native VS Code providers, existing webviews, Node tests, official local Vanessa .45 sources.

**Spec:** Уточнения пользователя 2026-10-20 (12 пунктов) и [исходная спецификация](../specs/2026-10-15-vanessa-control-design.md).

## Constraints and review focus

- Только собственный KOT_FORM_PROBE и отдельная служебная ИБ для live-проверок; никаких бизнес-сценариев/клиентов.
- Late replies, смена клиента/сеанса/исходника не должны вставлять текст или запускать чужой шаг.
- Сохранить относительные отступы таблиц/docstrings, исходный текст и Undo. Убрать автоматический перевод; язык передаётся самой Vanessa.
- Не считать progress доказательством pass/fail и не выводить статусы для неоднозначных совпадений строк.
- Не заменять отсутствующие capabilities приближённым исполнением или скрытыми кликами.

## Tasks

- [x] Запись: RED относительных отступов, прямая вставка после Stop из KOT и локальный сброс кнопки после подтверждённого внешнего Stop без второго RPC. Конфликт вставки остаётся восстанавливаемым.
  Files: src/vanessaControlAuthoring{,Commands}.ts; test/vanessaControlAuthoring{,Commands}.test.ts.
- [ ] Автоматическая вставка после Stop в Vanessa: `.45` не предоставляет read-only результат, повторный Stop очищает его. Заблокировано отсутствующим API, см. предложение следующего этапа.
- [x] Язык: RED сохранения explicit gherkinlanguage и согласованного Lang в launch JSON; убрать перевод при вставке и проверить реальный загрузчик .45.
  Files: src/vanessaControlLaunch.ts, src/phaseSwitcher.ts, src/extension.ts, tests launch/authoring.
- [x] Form Explorer: строки дерева с отдельными chevron/icon/label, единая ширина и отступ уровня; дополнить MCP tables/columns в общем кэше, проверить контекстный IntelliSense без нерелевантных значений.
  Files: media/formExplorer.{css,js}, src/vanessaControlForms.ts, src/completionProvider.ts; form/tree/completion tests.
- [x] Генерация: результат checks/current-element steps показывать в нижней панели с Copy/Insert, запись по-прежнему вставляется прямо в сценарий. Нет обязательного промежуточного файла.
  Files: native Output channel in authoring commands, extension, manifest/localization, tests.
- [x] Исполнение: сравнить loaded/scratch paths .45, исправить command-time sync сохранённого feature для breakpoints/F11, сохранять чужие точки и dirty editor. Сам execute_feature_step перезагружает feature внутри `.45`; эта задержка остаётся upstream.
  Files: session/protocol/feature/breakpoint commands, session tests; live own Delay-only probes.
- [x] Статусы: хранить подтверждённые результаты отдельных строк, сверять финальные results, завершать running-оформление после прогона со строки; отдельные проверки source changes/ambiguity/cancellation.
  Files: session/protocol/highlighting/control commands and tests.
- [x] Полный npm run vscode:prepublish, diff check, финальное ревью и live acceptance реализованных исправлений; актуализировать docs/status. Gate `/private/tmp/kot-control-final-safe-20261021.log`: 2263 tests, 2261 passed, 0 failed, 2 optional skips; types/lint/bundle passed. Reviewer подтвердил исправления late overlays и external-stop race.
- [x] Пункты 11–12: [предложение Connect/settings и базы → пользователи → live profiles](../specs/2026-10-21-vanessa-connections-and-current-element.md). Это проект следующего интерфейса, не реализованный экран. Секреты локально, модель Debug clients переиспользуется.
- [x] Уточнение 2026-10-21: проверить узкий запрос текущего элемента. В `.45` его нет; подтверждены полный обход, область действия max_depth и gherkin=false. API-предложение включено в документ выше.


## Проверки текущей итерации

- Recording/launch tests: common indentation, external Stop without any extra RPC, raw language and Lang consistency; active-profile launch integration proves VAParams contains both explicit `gherkinlanguage=en` and `Lang=en`. Regression protects prepared base/feature/global values from late profile overlays.
- Form completion: tables/columns are derived from the MCP hierarchy even with no captured UI rows; checkbox references remain contextual. Tree uses fixed chevron/icon/text columns and one-line rows.
- Session tests: command-time clean source reload preserves foreign points; dirty/missing editor content refuses overwrite; remote tab switch during breakpoint capture aborts before reload. Delayed pre-run state cannot add old passed lines to new history.
- Live acceptance: собственные Delay-only шаги — runFromLine вернул passed для строк 4 и 5; сохранённая правка/точка не требуют ручной перезагрузки. F11: execute_feature_step занял 5,0/3,5 с, остальные RPC — десятки/сотни миллисекунд. Native Form Explorer проверен в DevHost на дереве 571 элемента, Output с результатом также виден. Собственный клиент подтвердил потерю буфера на втором Stop; неподдержанная автовставка не объявляется работающей. Бизнес-сценарии/клиенты не использовались.

## Дополнительные регрессии 2026-10-21

- Feature: подключены Format Document и pre-save выравнивание таблиц через существующую настройку; docstrings/block comments не меняются, escaped pipes остаются в ячейке. RED/GREEN в commandHandlersParameterDefaults и gherkinTableUtils.
- MCP startup `.45`: регистрация библиотек обращается к ещё недоступному объекту VanessaExt.НайтиФайлы. Только конечная runtime-копия MCP запуска использует штатный поиск 1С; useaddin, исходный JSON и обычный Debug не изменяются. Явное unknown-подключение проверяется и при необходимости пересоздаётся через обнаружение сеансов, без принятия оставшихся capabilities за готовность.
- Form Explorer: поддержаны многострочные значения/представления, включая таблицы. Ошибка подробностей сохраняет ранее подтверждённое дерево; смена клиента/окна его очищает, в том числе при одновременно некорректном ответе. Ошибка запроса шагов не инвалидирует выполнение и не переводит весь сеанс в unknown. Полная parity остальных возможностей MCP не заявляется.
- Финальное ревью выявило гонку malformed detail + changed window: RED/GREEN, проверка identity перенесена в finally, важных замечаний не осталось. Полный gate и живая проверка завершены; результаты ниже.

- Полный `npm run vscode:prepublish` после всех исправлений: types, tools types, ESLint, bundle — PASS; 2274 tests, 2272 passed, 0 failed, 2 optional skips. Лог: `/private/tmp/kot-20261021-final-regressions.log`.
- Живой Windows DevHost: новый managed-сеанс Vanessa `.45` запущен через Control Vanessa from VS Code, достиг `Vanessa: Ready` без ошибки НайтиФайлы. В фактическом runtime JSON подтверждены native file search=false и generator/Lang=en; исходные настройки не менялись.
- Native Format Document (`Alt+Shift+F`) выровнял таблицу собственного `formatter-acceptance.feature`, сохранённый docstring побайтно не изменился. Собственный fixture перенесён в ignored native-helpers; пользовательские сценарии не запускались. При навигации случайный ввод в собственный KOTPARENT был немедленно отменён Undo; чистое исходное состояние визуально подтверждено.

## Исправления Form Explorer и обращения к upstream, 2026-10-21

- [x] Меню клиентов: один вызов команды завершает один workflow; отмена настройки не открывает скрытый повторный QuickPick, пассивное уведомление не держит guard. RED/GREEN command harness с реальным configuration flow; отмена, отказ connect и повторное открытие проверены.
- [x] Иерархия: глубина устанавливается через CSSOM после рендера; CSP не ослабляется. Старый HTML `style` блокировался политикой webview. Вложенность/поиск/сворачивание сохранены.
- [x] Native steps: сброс при смене элемента, поздние ответы прежнего элемента/формы отбрасываются; запросы не выполняются параллельно. В MCP-режиме локальные старые Suggested steps скрыты. Автозапрос — явная опция, изначально выключенная из-за полного обхода формы в .45; это подсказки активного элемента клиента, а не проверки выбранной строки KOT.
- [x] MCP form tools: версия-зависимое меню 13 проверенных инструментов формы/клиента и связанных данных по tools/list, typed параметры, проверка до отправки, session/mutation guards, локальный Output. Неизвестные/неподдержанные схемы не угадываются. get_table_data подписан как чтение БД, а не UI таблицы.
- [x] Язык form checks: отдельная совместимость для .45 через однозначные пары выбранного каталога; значения/таблицы/docstrings и неизвестные шаги сохраняются, о непереведённых сообщается. Запись не переводится. Причина upstream: MCP пропускает штатный вызов перевода.
- [x] Ошибки: парсер state учитывает вложенный Markdown ошибки; подтверждённый failed не превращается в unknown после MCP tool error. Отказ транспорта остаётся unknown и не маскируется Ready. Ошибка привязана к фактической строке, позднее сообщение обновляет hover без присвоения его соседним failed-строкам.
- [ ] Точный эквивалент UI «проверка только текущего элемента», read-only active element identity, узкие native suggestions, полный UI table snapshot и чтение внешне остановленной записи: прямого проверенного API .45 нет. Не подменены догадками; отдельные issue drafts подготовлены.
- [x] [11 русскоязычных черновиков issue](../issues/2026-10-21-vanessa-mcp/README.md); прежние 02 и 03 объединены в один запрос подсказок и проверок отдельного элемента. Баги KOT не объявлены багами Vanessa. Ничего не опубликовано. Экспортные breakpoints требуют самостоятельного минимального reproducer перед публикацией.

Проверки этой серии: полный `npm run vscode:prepublish` — 2304 tests, 2302 passed, 0 failed, 2 optional skips; types/tools types/lint/minified bundle PASS (`/private/tmp/kot-form-20261021-final.log`). Последнее добавление обновления дерева после явного действия: focused57/57, typecheck, scoped ESLint, compile и diff check PASS. Windows DevHost: новая панель загрузила дерево92 элементов с отступами и объявленное живой Vanessa меню MCP form tools. Полное повторное открытие клиентов после отмены подтверждено automated workflow/command tests; нативная повторная проверка осталась неокончательной. Действий над формой/подключениями не выполнялось.
