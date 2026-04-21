# Блок: AI Tools

## Задача блока

Помочь с живой документацией сценариев, AI-анализом продуктовых изменений и ревью измененных автотестов.

## Что входит в AI-блок

- AI-блок в KOT это не одна функция, а три отдельных режима работы.
- Описание текущего сценария в `KOTМетаданные.Описание`.
- Отчет для тестировщика по diff конфигурации.
- Ревью измененных автотестов с учетом diff конфигурации.
- Все три режима работают через подключаемую OpenAI-compatible LLM: локальную или облачную.

## 1. AI-описание сценария

- Запускается кнопкой `Описать с помощью ИИ` на строке `Описание:` или командой `KOT - Generate KOT metadata description with AI`.
- Нужен, когда надо быстро получить живое описание сценария для чтения человеком, а не технический diff.
- Результат записывается прямо в `KOTМетаданные.Описание` в едином формате:

```text
Проверяется: ...

Процесс: ...

Параметры и развилки: ...

(Что можно улучшить: ...)
```

- Блок с рекомендацией опционален: если модель не дала конкретного замечания, он не добавляется.
- Длинные строки автоматически переносятся, чтобы описание читалось в редакторе без горизонтального скролла.

### Какой контекст получает модель

При генерации описания KOT передает модели компактный контекст текущего сценария:

- `ТекстСценария`;
- объявленные `ПараметрыСценария`;
- placeholder-ы вида `[ParamName]`, найденные в тексте;
- вложенные сценарии, если они указаны в YAML.

### Когда это полезно

- быстро понять чужой сценарий без чтения всех шагов подряд;
- привести `KOTМетаданные.Описание` к одному формату;
- подсветить неочевидные развилки, параметры и потенциальные улучшения.

## 2. AI-отчет по diff конфигурации

- Запускается командой `KOT - Generate tester-friendly configuration diff report with AI`.
- В `Test Manager` то же действие доступно через меню `Thinking` как `Generate AI diff report`.
- Перед запуском KOT собирает `git diff` файловой выгрузки 1С из `kotTestToolkit.formExplorer.configurationSourceDirectory` относительно главной ветки.
- Дополнительно можно вставить необязательный `UserStory`, чтобы дать модели бизнес-контекст изменения.
- На выходе получается markdown-отчет именно для тестировщика, а не пересказ diff для разработчика.

### Что содержит отчет

- что изменение значит для тестировщика;
- что проверить руками в первую очередь;
- какие пользовательские сценарии прогнать;
- какие данные и роли подготовить;
- что может зацепить рядом;
- где вывод пока остается гипотезой, а не уверенным фактом.

### Где используется и как хранится

- После генерации KOT открывает отчет и сохраняет его для текущей ветки.
- Если изменений конфигурации относительно главной ветки нет, новый отчет не создается.
- Повторно открыть уже сохраненный отчет можно через `Open AI diff report` в `Test Manager`.
- По умолчанию файл лежит в `.vscode/kot-runtime/configuration-diff-ai-reports`.
- Если задан `kotTestToolkit.runtime.directory`, используется он вместо `.vscode/kot-runtime`.

### Когда это полезно

- оценить пользовательский эффект изменения конфигурации без ручного чтения всего diff;
- быстро составить чек-лист для ручного тестирования;
- понять, какие роли, данные и соседние бизнес-сценарии стоит подготовить до прогона.

## 3. AI-ревью измененных тестов

- Запускается командой `KOT - Review changed tests with AI`.
- В `Test Manager` то же действие доступно через меню `Thinking` как `Review changed tests with AI`.
- KOT сопоставляет diff измененных тестов с diff конфигурации и необязательным `UserStory`.
- Для ревью используются не только куски diff, но и актуальные фрагменты самих измененных тестов.
- На выходе получается markdown-ревью по качеству покрытия, пробелам и потенциально хрупким местам.

### Что содержит ревью

- соответствие diff конфигурации и `UserStory`;
- что уже покрыто хорошо;
- где есть пробелы и риски;
- что стоит добавить или переработать;
- вопросы и гипотезы, которые еще нужно подтвердить.

### Где используется и как хранится

- После генерации KOT сохраняет ревью для текущей ветки и предлагает сразу открыть его.
- Если изменений тестов относительно главной ветки нет, ревью не запускается.
- Повторно открыть сохраненный отчет можно через `Open AI test review` в `Test Manager`.
- По умолчанию файл лежит в `.vscode/kot-runtime/test-review-ai-reports`.
- Если задан `kotTestToolkit.runtime.directory`, используется он вместо `.vscode/kot-runtime`.

### Когда это полезно

- проверить, что новые или измененные тесты действительно покрывают продуктовые изменения;
- найти пропущенные проверки по ролям, данным, негативным сценариям и развилкам;
- заранее заметить хрупкие проверки и слепые зоны до code review или ручного прогона.

## Что нужно настроить заранее

- Секцию `AI` в Settings, чтобы KOT мог обращаться к модели.
- `kotTestToolkit.formExplorer.configurationSourceDirectory`, если вы хотите строить отчет по diff конфигурации или AI-ревью тестов.

Без `configurationSourceDirectory` генерация описания сценария работает, а два режима, которые опираются на diff конфигурации, не смогут собрать нужный контекст.

## Как использовать

### Для описания сценария

1. Настройте секцию `AI` в Settings.
2. Откройте YAML-сценарий с блоком `KOTМетаданные -> Описание`.
3. Нажмите `Описать с помощью ИИ` на строке `Описание:` или вызовите команду `KOT - Generate KOT metadata description with AI`.
4. Проверьте сгенерированный текст и при необходимости поправьте формулировки вручную.

### Для отчета по diff конфигурации

1. Убедитесь, что настроен `kotTestToolkit.formExplorer.configurationSourceDirectory`.
2. Переключитесь на нужную рабочую ветку с изменениями конфигурации.
3. Запустите `KOT - Generate tester-friendly configuration diff report with AI` или `Generate AI diff report` из `Test Manager`.
4. При необходимости вставьте `UserStory` и дождитесь markdown-отчета.
5. Откройте сохраненный отчет сразу или позднее через `Open AI diff report`.

### Для ревью измененных тестов

1. Убедитесь, что в ветке есть изменения автотестов относительно главной ветки.
2. Убедитесь, что настроен `kotTestToolkit.formExplorer.configurationSourceDirectory`, чтобы KOT мог подтянуть контекст diff конфигурации.
3. Запустите `KOT - Review changed tests with AI` или одноименное действие из `Test Manager`.
4. При необходимости вставьте `UserStory`, чтобы ревью опиралось не только на diff, но и на бизнес-замысел задачи.
5. Откройте итоговый markdown-отчет сразу или позднее через `Open AI test review`.

## Настройки

Основные настройки находятся в секции `AI`:

- `kotTestToolkit.ai.apiFormat`
- `kotTestToolkit.ai.baseUrl`
- `kotTestToolkit.ai.apiVersion`
- `kotTestToolkit.ai.apiKey`
- `kotTestToolkit.ai.model`
- `kotTestToolkit.ai.outputLanguage`
- `kotTestToolkit.ai.maxLineLength`
- `kotTestToolkit.ai.timeoutSeconds`
- `kotTestToolkit.ai.systemPrompt`

Подробные значения по умолчанию и описание каждого ключа: [`SETUP.md`](../SETUP.md#310-ai-settings)

## Как выбрать `apiFormat`

Практическое правило:

- `chatCompletions` это лучший дефолт для большинства локальных серверов, OpenAI-compatible прокси и случаев, когда вы не уверены, какой endpoint поддерживает провайдер.
- `responses` стоит выбирать тогда, когда провайдер явно поддерживает `POST /v1/responses` и вы хотите работать именно через OpenAI Responses API.

Обычно:

- `LM Studio` -> разумно начинать с `chatCompletions`, хотя сервер поддерживает и `responses`;
- `Ollama` -> разумно начинать с `chatCompletions`, хотя новые версии поддерживают и `responses`;
- `OpenAI API` -> обычно `responses`;
- `Azure OpenAI` -> зависит от совместимого endpoint, но обычно требует `apiVersion`;
- `Gemini OpenAI compatibility` -> `chatCompletions`.

Если сомневаетесь:

1. Сначала попробуйте `chatCompletions`.
2. Если провайдер в документации рекомендует `/v1/responses`, переключитесь на `responses`.
3. Если при `responses` получаете `404`, `405` или жалобу на неизвестный endpoint, вернитесь на `chatCompletions`.

## Шаблоны подключения

Ниже приведены готовые шаблоны для `settings.json`. Везде замените `YOUR_MODEL_ID` и, где нужно, ключ API.

### LM Studio

Подходит для локального сервера LM Studio на стандартном порту `1234`.

```json
{
  "kotTestToolkit.ai.apiFormat": "chatCompletions",
  "kotTestToolkit.ai.baseUrl": "http://localhost:1234/v1",
  "kotTestToolkit.ai.apiKey": "local",
  "kotTestToolkit.ai.model": "YOUR_MODEL_ID",
  "kotTestToolkit.ai.outputLanguage": "ru",
  "kotTestToolkit.ai.maxLineLength": 100,
  "kotTestToolkit.ai.timeoutSeconds": 180
}
```

Если хотите, для LM Studio можно попробовать и `responses`, потому что этот endpoint у него тоже поддерживается.

### Ollama

Подходит для локального сервера Ollama.

```json
{
  "kotTestToolkit.ai.apiFormat": "chatCompletions",
  "kotTestToolkit.ai.baseUrl": "http://localhost:11434/v1",
  "kotTestToolkit.ai.apiKey": "ollama",
  "kotTestToolkit.ai.model": "YOUR_MODEL_ID",
  "kotTestToolkit.ai.outputLanguage": "ru",
  "kotTestToolkit.ai.maxLineLength": 100,
  "kotTestToolkit.ai.timeoutSeconds": 180
}
```

Для новых версий Ollama можно попробовать и `responses`, но `chatCompletions` обычно остается самым предсказуемым стартовым вариантом.

### OpenAI API

Подходит для официального OpenAI API.

```json
{
  "kotTestToolkit.ai.apiFormat": "responses",
  "kotTestToolkit.ai.baseUrl": "https://api.openai.com/v1",
  "kotTestToolkit.ai.apiKey": "YOUR_OPENAI_API_KEY",
  "kotTestToolkit.ai.model": "YOUR_MODEL_ID",
  "kotTestToolkit.ai.outputLanguage": "ru",
  "kotTestToolkit.ai.maxLineLength": 100,
  "kotTestToolkit.ai.timeoutSeconds": 180
}
```

### Gemini API в OpenAI-compatible режиме

Подходит для Gemini через OpenAI-compatible endpoint.

```json
{
  "kotTestToolkit.ai.apiFormat": "chatCompletions",
  "kotTestToolkit.ai.baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
  "kotTestToolkit.ai.apiKey": "YOUR_GEMINI_API_KEY",
  "kotTestToolkit.ai.model": "YOUR_MODEL_ID",
  "kotTestToolkit.ai.outputLanguage": "ru",
  "kotTestToolkit.ai.maxLineLength": 100,
  "kotTestToolkit.ai.timeoutSeconds": 180
}
```

### Azure OpenAI

Подходит для Azure OpenAI через совместимый OpenAI endpoint.

```json
{
  "kotTestToolkit.ai.apiFormat": "chatCompletions",
  "kotTestToolkit.ai.baseUrl": "https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT",
  "kotTestToolkit.ai.apiVersion": "2024-12-01-preview",
  "kotTestToolkit.ai.apiKey": "YOUR_AZURE_OPENAI_KEY",
  "kotTestToolkit.ai.model": "YOUR_DEPLOYMENT",
  "kotTestToolkit.ai.outputLanguage": "ru",
  "kotTestToolkit.ai.maxLineLength": 100,
  "kotTestToolkit.ai.timeoutSeconds": 180
}
```

## Практические замечания

- Дефолты настроек ориентированы на локальный OpenAI-compatible сервер в LM Studio `http://localhost:1234/v1`.
- Для Ollama обычно достаточно поменять `baseUrl` на `http://localhost:11434/v1` и указать точный тег модели.
- Для легкой локальной работы разумный стартовый вариант: `qwen3:4b`.
- В качестве онлайн модели можно использовать `gemini-2.5-flash`, есть бесплатные тарифы API.
- Для Azure OpenAI важно согласовать `baseUrl`, deployment/model и `apiVersion`.
- Если модель дает слишком общий текст или что-то упускает из контекста сценария, обычно помогает более сильная instruction-модель.
- Для маленьких локальных моделей KOT старается сокращать контекст, чтобы уменьшить риск ошибок из-за малого контекстного окна.

## Где читать дальше

- Настройка секции `AI`: [`SETUP.md`](../SETUP.md#310-ai-settings)
- Работа с `KOTМетаданные`: [`metadata-and-cache.md`](./metadata-and-cache.md)
- Быстрый старт по ежедневному использованию: [`QUICK_START.md`](../QUICK_START.md)
