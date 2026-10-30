# Vanessa: профили клиентов и управление отладкой из VS Code

Дата: 2026-10-14. Исследование для вопросов 4 и 7, без изменений продуктового кода, запуска 1С, изменения внешних проектов и коммитов.

## Вывод

Сохранённые наборы TestClient для ручной отладки полезны и поддерживаются обычным VAParams JSON. Их можно реализовать в KOT независимо от новой версии Vanessa.

Запуск со строки, отдельный шаг, реальные точки останова Gherkin и управление уже открытой Vanessa также технически доступны через официальный MCP-интерфейс Vanessa. Это подтверждено в опубликованном теге [1.2.043.45](https://github.com/Pr-Mex/vanessa-automation/releases/tag/1.2.043.45), а не только в develop. В KOT такого подключения сейчас нет. Для простых команд понадобится MCP-клиент в KOT, но не собственный новый сервер в Vanessa.

Полноценный VS Code Debug Adapter, непрерывная пауза/продолжение, step-over/step-in/step-out и точки останова BSL — отдельный объём работ. Они не следуют автоматически из наличия MCP.

## Проверенная база

- Текущий upstream develop: [167efad4f61ca227366264ea61f36ddaefcfba53](https://github.com/Pr-Mex/vanessa-automation/commit/167efad4f61ca227366264ea61f36ddaefcfba53), 2026-10-14 11:34:28 UTC.
- Последний опубликованный релиз по GitHub API во время проверки: 1.2.043.45 от 2026-10-06. Проверен реестр и обработчик MCP из этого тега.
- Локальный исходный checkout /Users/alexeremeev/Development/vanessa-automation: fb8b2b6a650e30a53f382fea31a531cb6fcd2743, 2026-03-01. В нём отсутствуют docs/AI и формы MCPVA. Он не подтверждает возможности новой поставки.
- /Users/alexeremeev/Development/vanessa — локальная распакованная поставка без Git-метаданных. Версия реально выбранного пользователем EPF и установленные расширения баз не проверены запуском 1С; нельзя обещать MCP на имеющемся окружении.

## Что сейчас делает KOT

1. Верхняя команда ручной отладки открывает новую Vanessa в общей базе менеджера. JSON создаётся из дополнительных параметров и глобальных переменных активного профиля. Параметры клиентов из buildParameters автоматически сюда не переносятся. См. [phaseSwitcher.ts:6535](../../../src/phaseSwitcher.ts:6535), [создание JSON:6598](../../../src/phaseSwitcher.ts:6598).
2. Ручная отладка собранного сценария берёт его JSON без обработки выбора базы и без подмены параметров. См. [createVanessaDebugLaunchContext:11465](../../../src/phaseSwitcher.ts:11465).
3. Командная строка включает ShowMainForm, QuietInstallVanessaExt, VAParams, WithoutSendingStatistics, UseEditor, /TESTMANAGER. В ручном режиме не добавляет StartFeaturePlayer; процесс запускается detached. Подключения к запущенному процессу и регистрации VS Code debugger в исходниках не найдено. См. [параметры:11601](../../../src/phaseSwitcher.ts:11601), [запуск:11656](../../../src/phaseSwitcher.ts:11656).
4. Генератор standalone feature заполняет только первый элемент datatestclients; дополнительные элементы исходного JSON могут сохраниться, но интерфейса набора клиентов нет. См. [selectedClient:122](../../../src/standaloneFeatureLaunch.ts:122), [параметры первого клиента:232](../../../src/standaloneFeatureLaunch.ts:232).
5. Учётные данные Infobase Manager кешируются в Map в памяти; перезапуск Extension Host их теряет. Это ещё не постоянное защищённое хранилище. См. [infobaseManager.ts:180](../../../src/infobaseManager.ts:180), [кеширование:1629](../../../src/infobaseManager.ts:1629).

При добавлении профилей нужен runtime overlay для manual debug: запрет автозапуска/автозакрытия независимо от исходного JSON. Сейчас standalone генератор задаёт ExecuteScenarios=true и CloseSystemOnComplete=true, а ручной запуск сохраняет JSON. Простого отсутствия StartFeaturePlayer недостаточно как общего контракта. См. [defaults:186](../../../src/standaloneFeatureLaunch.ts:186). Поведение конфликтующего JSON не проверялось на живой Vanessa.

## Минимальный UX для клиентов

Рекомендация: один локальный набор «Клиенты отладки» рядом с существующей командой Debug, с кнопкой «Настроить». При первом использовании открыть небольшой редактор набора; далее применять последний сохранённый выбор автоматически. В заголовке показать понятное имя набора и число клиентов. Отдельный вопрос перед каждым запуском не нужен.

Каждая строка набора:

- Имя профиля, которым пользуются шаги Vanessa. У основного клиента сохранить ожидаемое сценарием имя, часто TestClient.
- База: «Из менеджера баз» либо «Своё подключение». Поддержать файловую папку и серверную строку подключения.
- Пользователь необязателен; пароль необязателен и скрыт.
- «Добавить клиента» для второго пользователя/базы. Тип клиента, адрес машины, порт, дополнительные ключи — в раскрываемых дополнительных настройках.
- Сохранять набор после редактирования и использовать при следующей отладке; возможность «Использовать параметры сценария» остаётся отдельным вариантом.

Сохранение списка в JSON Vanessa лишь регистрирует профили; оно не гарантирует запуска всех клиентов сразу. Подключение выбирают шаги сценария, ручная команда Vanessa либо MCP manage_test_client. Сохранение нескольких клиентов имеет смысл для сценариев с несколькими ролями; их имена и порты должны различаться.

Определённые Vanessa поля: КлиентТестирования.ДанныеКлиентовТестирования / TestClient.datatestclients; внутри — Имя/Name, Синоним/Synonym, ПутьКИнфобазе/PathToInfobase, ТипКлиента/ClientType, ДопПараметры/AddItionalParameters, ИмяКомпьютера/ComputerName, ПортЗапускаТестКлиента/PortTestClient. Таблица списка клиентов подтверждена [официальными параметрами JSON](https://github.com/Pr-Mex/vanessa-automation/blob/167efad4f61ca227366264ea61f36ddaefcfba53/docs/JsonParams/JsonParamsEN.md#test-clients), структура экспорта — [исходником Vanessa](https://github.com/Pr-Mex/vanessa-automation/blob/167efad4f61ca227366264ea61f36ddaefcfba53/VanessaAutomation/Forms/УправляемаяФорма/Ext/Form/Module.bsl#L40044-L40058).

Пути, локальные ссылки на базу, имя пользователя и выбранный набор хранить в workspaceState/globalState расширения; пароли и секреты внутри строк подключения — в VS Code SecretStorage. Не помещать их в versioned YAML/JSON/settings. Перед запуском собрать временный локальный VAParams JSON с ограниченными правами и жизненным циклом очистки. Маскировать секреты также в connection string и ДопПараметры, не только отдельный аргумент /P. MCP get_list профилей возвращает полные строки подключения и дополнительные параметры; не отправлять такой ответ в обычные логи без очистки.

## Реальные возможности

| Возможность | Обычный JSON/текущий KOT | Через официальный MCP | Остаток работ в KOT |
| --- | --- | --- | --- |
| Сохранить один/несколько клиентов до запуска | JSON поддерживает datatestclients; KOT не имеет отдельного UX | Не требуется | Локальная модель набора, SecretStorage, runtime overlay |
| Изменить профили в открытой Vanessa | JSON следующего запуска не изменит текущий сеанс | manage_test_client_profiles: get_list/add/edit | MCP-клиент; синхронизация по имени, не дублировать профили |
| Подключить клиент в открытой Vanessa | Через её UI/шаги | manage_test_client: connect(profileName)/disconnect | Команда выбора профиля |
| Запустить feature с выбранной строки | Прямого параметра шага в изученных launch JSON/команде KOT нет | run_scenario(mode=reloadAndRunFromLine, filePath, lineNumber) | Команда редактора; сохранение файла; проверить исполняемую строку |
| Запустить с текущего выбранного шага | Через UI Vanessa | select_step(lineNumber), затем run_scenario(mode=fromCurrentStep) | Не перезагружать текущий контекст без причины |
| Выполнить один шаг | Через UI Vanessa | execute_feature_step(filePath, lineNumber) | Команда редактора; это не универсальный step-over |
| Поставить реальную точку останова Gherkin | Внутри Vanessa Editor | manage_breakpoints: list/toggle(line)/remove_all | Открыть правильную вкладку; синхронизировать F9 по пути и строке |
| Остановить сценарий | Текущий KOT не отправляет live команду ручному сеансу | stop_scenario | Обрабатывать отложенную остановку; не убивать процесс вместо команды |
| Узнать текущий шаг/результаты/переменные | Логи KOT дают часть сведений | get_vanessa_automation_state, get_test_results, get_editor_state, manage_variables | Показывать состояние выбранного сеанса |
| Продолжение, pause, step-over/in/out как DAP | Не реализовано | Отдельных pause/continue/step-over/in/out инструментов в проверенном реестре нет | DAP-адаптер с честной ограниченной семантикой; для полного контроля расширить API Vanessa |
| Отладка кода 1С и BSL breakpoint | Не относится к шаговым breakpoint Vanessa | MCP Gherkin не заменяет BSL debugger | Отдельный отладчик платформы 1С |

Реестр API и параметры: [MCPVA_Служебный, строки 315–404](https://github.com/Pr-Mex/vanessa-automation/blob/167efad4f61ca227366264ea61f36ddaefcfba53/VanessaAutomation/Forms/MCPVA_Служебный/Ext/Form/Module.bsl#L315-L404), [профили, строки 491–517](https://github.com/Pr-Mex/vanessa-automation/blob/167efad4f61ca227366264ea61f36ddaefcfba53/VanessaAutomation/Forms/MCPVA_Служебный/Ext/Form/Module.bsl#L491-L517). Эти команды также проверены в [релизном теге](https://github.com/Pr-Mex/vanessa-automation/blob/1.2.043.45/VanessaAutomation/Forms/MCPVA_Служебный/Ext/Form/Module.bsl#L322-L404).

manage_breakpoints требует включённого Vanessa Editor и активной feature-вкладки, а toggle не является операцией «установить в состояние». После повторного attach нельзя слепо переотправлять все точки: это снимет существующие. Проверять list и синхронизировать разницу. [Проверки обработчика](https://github.com/Pr-Mex/vanessa-automation/blob/167efad4f61ca227366264ea61f36ddaefcfba53/VanessaAutomation/Forms/MCPVA/Ext/Form/Module.bsl#L2012-L2136).

Остановка на Gherkin breakpoint прекращает текущую последовательность, выбирает соответствующую строку и завершает выполнение. Повторный запуск fromCurrentStep пропускает breakpoint на текущей стартовой строке и сбрасывает счётчики циклов. Это не приостановленный BSL стек. Для циклов и вложенных сценариев нельзя обещать семантику обычного Continue без отдельной проверки. [Остановка](https://github.com/Pr-Mex/vanessa-automation/blob/167efad4f61ca227366264ea61f36ddaefcfba53/VanessaAutomation/Forms/УправляемаяФорма/Ext/Form/Module.bsl#L25372-L25405), [повторный запуск](https://github.com/Pr-Mex/vanessa-automation/blob/167efad4f61ca227366264ea61f36ddaefcfba53/VanessaAutomation/Forms/УправляемаяФорма/Ext/Form/Module.bsl#L6756-L6799).

Запуск со строки не создаёт состояние базы, окна и переменные, которые должны были подготовить пропущенные шаги. Для штатной воспроизводимой отладки предпочтительнее запуск сначала до breakpoint. Для уже подготовленного сеанса — запуск со строки.

Для исходного YAML нужен перевод строки через свежую карту СППР: sourceBodyLineNumber относится к телу ТекстСценария, а не к номеру YAML-строки; один исходный шаг может соответствовать нескольким строкам сборки. Начать разумно с standalone .feature; для YAML подключать .str и проверку актуальности сборки. См. [compilerArtifacts.ts:1](../../../src/compilerArtifacts.ts:1), [парсер:92](../../../src/compilerArtifacts.ts:92).

## Что необходимо для MCP

Официальная инструкция требует расширение [onec-client-mcp-devkit](https://github.com/1c-neurofish/onec-client-mcp-devkit/releases) в базе менеджера, VanessaExt и VAExtension в базе TestClient. Vanessa регистрирует инструменты, MCP-сервер запускается в том же менеджере. Документирован streamable-http endpoint /mcp на localhost. Сервер можно запускать параметрами /C runMcp;mcpPort=9876. Существующий ручной сеанс можно подключить, если в нём уже доступен MCP-сервер; обычная открытая Vanessa без endpoint не становится управляемой от JSON другого процесса. [Быстрый старт](https://github.com/Pr-Mex/vanessa-automation/blob/167efad4f61ca227366264ea61f36ddaefcfba53/docs/AI/index.md#быстрый-старт), [пример клиента](https://github.com/Pr-Mex/vanessa-automation/blob/167efad4f61ca227366264ea61f36ddaefcfba53/docs/AI/index.md#плагин-continue-для-vscode).

MCP — программный интерфейс; реализация кнопок KOT может обращаться к нему детерминированно без LLM/Cline/Continue. Перед использованием проверять tools/list, потому что используемая EPF может быть старее. Зависимость onec-client-mcp-devkit предупреждает об отсутствии стабильного релиза и изменяемости API: лучше проверять доступные capabilities, а не только номер версии. [README зависимости](https://github.com/1c-neurofish/onec-client-mcp-devkit#1c-client-mcp-server).

Поля JSON testclientdebug/testclientdebugaddress/testclientdebugkeys передают платформе /debug и /debuggerURL. Они относятся к подключению отладчика к клиенту 1С и не являются списком breakpoint шагов Gherkin. [Официальные параметры](https://github.com/Pr-Mex/vanessa-automation/blob/167efad4f61ca227366264ea61f36ddaefcfba53/docs/JsonParams/JsonParamsRU.md#L201-L210).

## Предлагаемая последовательность

1. Сохранённые локальные наборы клиентов и безопасный runtime overlay ручного запуска.
2. Подключение KOT к MCP-серверу открытой Vanessa: «Выполнить с этой строки», «Выполнить шаг», «Остановить», состояние и результаты.
3. Синхронизация Gherkin breakpoint из редактора и корректное отображение остановки.
4. Только после проверки фактической семантики — VS Code debug toolbar/DAP, карты исходного YAML и согласованное поведение продолжения в циклах/подсценариях.

Проверка была статической: локальные исходники KOT, первичные upstream исходники и документация/API GitHub. Живое исполнение MCP или 1С не проводилось.

## Перепроверка 2026-10-15

Живой read-only GitHub API подтвердил прежний последний опубликованный релиз: [1.2.043.45](https://github.com/Pr-Mex/vanessa-automation/releases/tag/1.2.043.45), опубликован 2026-10-06 17:15:38 UTC. Текущий develop — [167efad4f61ca227366264ea61f36ddaefcfba53](https://github.com/Pr-Mex/vanessa-automation/commit/167efad4f61ca227366264ea61f36ddaefcfba53), 2026-10-14 11:34:28 UTC. Web-проверка выполнена; недоступные/кешированные страницы дополнены чтением официального GitHub API. Выбранные файлы реестра, обработчиков MCP и основной формы в релизном теге и develop совпадают целиком. Исходники скачивались только как временные исследовательские копии.

Сохранённые клиенты и безопасный runtime overlay обычного ручного Debug теперь реализованы в текущем рабочем дереве KOT. Этот механизм использует VAParams; MCP-клиент не добавлен. Описание исходного состояния выше относится к аудиту 2026-10-14.

### Подтверждённый контракт опубликованной Vanessa

| Действие KOT | Официальный инструмент и параметры |
| --- | --- |
| Запуск сначала | `run_scenario(mode=reloadAndRun, filePath)`; также есть `all` и `selected` |
| Перезагрузка и запуск со строки | `run_scenario(mode=reloadAndRunFromLine, filePath, lineNumber)` |
| Запуск с выбранного шага | `select_step(lineNumber)`, затем `run_scenario(mode=fromCurrentStep)` |
| Один шаг | `execute_feature_step(filePath, lineNumber)` |
| Остановить | `stop_scenario()` |
| Читать состояние/результаты | `get_vanessa_automation_state`, `get_editor_state`, `get_test_results(scenarioId?)` |
| Точки останова | `manage_breakpoints(action=list/toggle/remove_all, line?)` |
| Подключить профиль | `manage_test_client(action=connect, profileName)`; отключение — `disconnect` |

Номера строк feature начинаются с 1. В реестре нет отдельных pause, continue, step-over, step-in, step-out и BSL breakpoint. Имена режимов не являются обещанием восстановления стека выполнения. У `manage_test_client_profiles` есть add/edit/get_list, но в опубликованной схеме add/edit отсутствует поле порта: нельзя автоматически переносить все возможности VAParams в live-команду. Основание: [релизный реестр, команды выполнения](https://github.com/Pr-Mex/vanessa-automation/blob/1.2.043.45/VanessaAutomation/Forms/MCPVA_Служебный/Ext/Form/Module.bsl#L314-L405), [профили клиентов](https://github.com/Pr-Mex/vanessa-automation/blob/1.2.043.45/VanessaAutomation/Forms/MCPVA_Служебный/Ext/Form/Module.bsl#L491-L518).

### Ограничения исполнения и подключения

Breakpoint прекращает последовательность до выполнения помеченного шага и выбирает его в редакторе. `fromCurrentStep` начинает новое выполнение, сбрасывает счётчики циклов и пропускает breakpoint на стартовой строке. Поэтому безопасный текст действия — «Выполнить с выбранного шага»; полную семантику Continue для циклов и вложенных вызовов нужно исследовать отдельно. Основание: [начало выполнения с текущего шага](https://github.com/Pr-Mex/vanessa-automation/blob/1.2.043.45/VanessaAutomation/Forms/УправляемаяФорма/Ext/Form/Module.bsl#L6756-L6802), [обработка точки останова](https://github.com/Pr-Mex/vanessa-automation/blob/1.2.043.45/VanessaAutomation/Forms/УправляемаяФорма/Ext/Form/Module.bsl#L25358-L25407).

Toggle требует включённого Vanessa Editor и активной feature-вкладки. List/toggle не принимают путь файла; перед синхронизацией нужно активировать нужный документ. Ответы состояния, breakpoint и результатов формируются как Markdown. Stop посылает запрос остановки; его ответ не подтверждает, что текущий шаг уже завершён. Заголовок ответа run выбирается по отсутствию описаний ошибок: он сам по себе не доказывает полного выполнения после остановки. Основание: [обработчики breakpoint и stop](https://github.com/Pr-Mex/vanessa-automation/blob/1.2.043.45/VanessaAutomation/Forms/MCPVA/Ext/Form/Module.bsl#L2012-L2212), [формирование состояния](https://github.com/Pr-Mex/vanessa-automation/blob/1.2.043.45/VanessaAutomation/Forms/MCPVA/Ext/Form/Module.bsl#L2334-L2423), [завершение run](https://github.com/Pr-Mex/vanessa-automation/blob/1.2.043.45/VanessaAutomation/Forms/MCPVA/Ext/Form/Module.bsl#L8499-L8543).

Для подключения нужен MCP devkit в базе менеджера, Vanessa в этом же `/TESTMANAGER` сеансе, включённая VanessaExt и VAExtension в базе клиента. Инструкция показывает streamable-http endpoint `/mcp` и запуск через `runMcp;mcpPort=...`. Обычный уже открытый сеанс без MCP endpoint не становится управляемым от нового JSON. [Официальная инструкция релиза](https://github.com/Pr-Mex/vanessa-automation/blob/1.2.043.45/docs/AI/index.md#быстрый-старт).

Текущий master devkit — [8d7fe150f9d6ac7385266acf438d7aebc2215c0c](https://github.com/1c-neurofish/onec-client-mcp-devkit/commit/8d7fe150f9d6ac7385266acf438d7aebc2215c0c), 2026-10-05. Его README предупреждает об изменяемости API; значение порта по умолчанию — 8080. В примерах Vanessa используются другие порты. Будущий запуск должен задавать порт явно, attach — хранить выбранный endpoint и проверять `initialize`/`tools/list`; номер EPF не заменяет проверку доступных инструментов. [README devkit](https://github.com/1c-neurofish/onec-client-mcp-devkit/blob/8d7fe150f9d6ac7385266acf438d7aebc2215c0c/README.md#запуск-из-командной-строки-1с).

### Требования к будущему дизайну KOT

- Сначала работать с сохранённой standalone `.feature` и проверять реальную исполняемую строку. Учитывать, что пропущенные шаги могли готовить базу, окна и переменные. Не показывать idle как достоверную паузу или полный успех.
- Breakpoint синхронизировать через list и разницу наборов; после таймаута снова читать list, чтобы повторный toggle не снял уже установленную точку. Не использовать remove_all для чужого сеанса. Это вывод из проверенной семантики API, а не дополнительный инструмент Vanessa.
- Сериализовать изменяющие действия. Длительный run ждёт завершения и использует общий идентификатор MCP-задачи; select_step и другие асинхронные действия меняют этот идентификатор. Stop и чтение состояния должны оставаться доступными во время ожидающего run. Проверить эту модель на совместимом живом окружении до обещания удобного пошагового управления.
- Для YAML переводить строку через свежую `.str`: VS Code строка YAML с индексом 0 равна `body.startLine + sourceBodyLineNumber - 1`; строка `.feature` в карте начинается с 1. Обратный перевод UID/строки тела может дать несколько развернутых вхождений; для запуска нужен явный выбор неоднозначного вхождения. Сейчас [парсер карты](../../../src/compilerArtifacts.ts) не предоставляет checksum, а [навигация](../../../src/phaseSwitcher.ts) не проверяет digest карты. Будущий manifest должен связывать hash исходных YAML/зависимостей/профиля с hash feature и `.str`; устаревшие карты нельзя применять для выполнения.
- При attach показывать совместимость и доступные действия; хранить endpoint локально, секреты — в SecretStorage. Ответы со строками подключения/параметрами/бизнес-данными очищать перед логами. Применение набора к уже открытой Vanessa — отдельное явное действие, а не следствие сохранения обычного Debug JSON.

Это повторная статическая проверка и рекомендации для будущего дизайна. MCP-код, DAP, запуск 1С, установка расширений в базы и live-проверка управления не выполнялись. Подробный spec/implementation plan в рамках этого уточнения не создавался.
