# Блок: AI Description

## Задача блока

Помочь быстро заполнить и поддерживать `KOTМетаданные.Описание` без ручного пересказа длинного сценария.

## Что умеет AI-описание

- По кнопке `Описать с помощью ИИ` на строке `Описание:` генерирует описание текущего сценария.
- То же действие доступно командой `KOT - Generate KOT metadata description with AI`.
- Работает с подключаемой OpenAI-compatible LLM: локальной или облачной.
- Записывает результат в `KOTМетаданные.Описание` в едином формате:

```text
Проверяется: ...

Процесс: ...

Параметры и развилки: ...

(Что можно улучшить: ...)
```

- Блок с рекомендацией опционален: если модель не дала конкретного замечания, он не добавляется.
- Длинные строки автоматически переносятся, чтобы описание читалось в редакторе без горизонтального скролла.
- Если после `Описание` в YAML уже был служебный маркер `-`, KOT сохраняет его при обновлении текста.

## Как KOT понимает сценарий

При генерации KOT передает модели компактный контекст текущего сценария:

- `ТекстСценария`;
- объявленные `ПараметрыСценария`;
- placeholder-ы вида `[ParamName]`, найденные в тексте;
- вложенные сценарии, если они указаны в YAML.

Важный момент:

- если placeholder объявлен в `ПараметрыСценария`, он трактуется как параметр сценария, а не как буквальная часть названия окна, отчета или команды.

Поэтому строка вроде:

```gherkin
Then "Accounts [ReportType] aging (contract currency)" window is opened
```

должна интерпретироваться как проверка окна отчета, где `[ReportType]` это переменный параметр сценария.

## Как использовать

1. Настройте секцию `AI` в Settings.
2. Откройте YAML-сценарий с блоком `KOTМетаданные -> Описание`.
3. Нажмите `Описать с помощью ИИ` на строке `Описание:` или вызовите команду `KOT - Generate KOT metadata description with AI`.
4. Проверьте сгенерированный текст и при необходимости поправьте формулировки вручную.

## Настройки

Основные настройки находятся в секции `AI`:

- `kotTestToolkit.ai.apiFormat`
- `kotTestToolkit.ai.baseUrl`
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

## Практические замечания

- Дефолты настроек ориентированы на локальный OpenAI-compatible сервер в LM Studio `http://localhost:1234/v1`.
- Для Ollama обычно достаточно поменять `baseUrl` на `http://localhost:11434/v1` и указать точный тег модели.
- Для легкой локальной работы разумный стартовый вариант: `qwen3:4b`.
- В качестве онлайн модели можно использовать `gemini-2.5-flash`, есть бесплатные тарифы API.
- Если модель дает слишком общий текст, обычно помогает более сильная instruction-модель.
- Для маленьких локальных моделей KOT старается сокращать контекст, чтобы уменьшить риск ошибок из-за малого контекстного окна.

## Где читать дальше

- Настройка секции `AI`: [`SETUP.md`](../SETUP.md#310-ai-settings)
- Работа с `KOTМетаданные`: [`metadata-and-cache.md`](./metadata-and-cache.md)
- Быстрый старт по ежедневному использованию: [`QUICK_START.md`](../QUICK_START.md)
