# Подключить AI-сервис

Откройте **Настройки KOT → AI**. Для каждого примера замените `YOUR_MODEL_ID` на точный идентификатор доступной модели, `YOUR_API_KEY` — на свой ключ. Это поля настроек KOT, не переменные окружения: значения-заглушки автоматически не подставляются.

Примеры описывают контракт KOT 3.0.0 и проверены по официальной документации сервисов 25 октября 2026 года. Платный inference с этими примерами не выполнялся. Наличие модели, доступ и лимиты определяются вашим сервисом.

## Выбрать формат API

| Сервис | С чего начать | Базовый адрес |
|---|---|---|
| LM Studio | `chatCompletions` | `http://localhost:1234/v1` |
| Локальная Ollama | `chatCompletions` | `http://localhost:11434/v1` |
| OpenAI | `responses` | `https://api.openai.com/v1` |
| Gemini OpenAI compatibility | `chatCompletions` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Azure OpenAI v1 | `responses` для поддерживающего его deployment | `https://YOUR_RESOURCE.openai.azure.com/openai/v1` |

KOT сам добавляет `/chat/completions` либо `/responses`. Не дописывайте этот хвост в `baseUrl`. Он отправляет обычный текстовый запрос с `Authorization: Bearer …`; нативные API Ollama `/api/chat` и LM Studio `/api/v1/chat` имеют другой контракт.

LM Studio и Ollama также объявляют Responses API в текущей документации. Если используете этот режим, проверьте его поддержку установленной версией сервера. Выбор в таблице — простой маршрут настройки KOT, а не ограничение всех возможностей сервисов.

## LM Studio

Запустите сервер в разделе Developer и загрузите модель. Скопируйте её ID из LM Studio. Если аутентификация выключена, KOT всё равно требует непустой ключ, например `local`; при включённой используйте настоящий токен сервера.

```json
{
  "kotTestToolkit.ai.apiFormat": "chatCompletions",
  "kotTestToolkit.ai.baseUrl": "http://localhost:1234/v1",
  "kotTestToolkit.ai.apiVersion": "",
  "kotTestToolkit.ai.apiKey": "local",
  "kotTestToolkit.ai.model": "YOUR_MODEL_ID",
  "kotTestToolkit.ai.outputLanguage": "ru",
  "kotTestToolkit.ai.timeoutSeconds": 180
}
```

Контракт: [OpenAI-compatible endpoints LM Studio](https://lmstudio.ai/docs/developer/openai-compat).

## Ollama

Запустите локальную Ollama, установите модель и укажите её точное имя с тегом. Ключ `ollama` подходит локальному серверу без проверки авторизации; для защищённого шлюза нужны его учётные данные.

```json
{
  "kotTestToolkit.ai.apiFormat": "chatCompletions",
  "kotTestToolkit.ai.baseUrl": "http://localhost:11434/v1",
  "kotTestToolkit.ai.apiVersion": "",
  "kotTestToolkit.ai.apiKey": "ollama",
  "kotTestToolkit.ai.model": "YOUR_MODEL_ID",
  "kotTestToolkit.ai.outputLanguage": "ru",
  "kotTestToolkit.ai.timeoutSeconds": 180
}
```

Контракт: [совместимость Ollama с OpenAI API](https://docs.ollama.com/api/openai-compatibility).

## OpenAI

Используйте ключ API и модель, доступную вашему API-проекту. Подписка пользовательского приложения и доступ к API настраиваются отдельно.

```json
{
  "kotTestToolkit.ai.apiFormat": "responses",
  "kotTestToolkit.ai.baseUrl": "https://api.openai.com/v1",
  "kotTestToolkit.ai.apiVersion": "",
  "kotTestToolkit.ai.apiKey": "YOUR_API_KEY",
  "kotTestToolkit.ai.model": "YOUR_MODEL_ID",
  "kotTestToolkit.ai.outputLanguage": "ru",
  "kotTestToolkit.ai.timeoutSeconds": 180
}
```

Источники: [генерация текста](https://developers.openai.com/api/docs/guides/text), [авторизация API](https://developers.openai.com/api/reference/overview). KOT использует текстовый ответ; настройка этого подключения не включает управление Vanessa через AI.

## Gemini

Укажите ключ Gemini API и поддерживаемую модель. Используется слой совместимости с OpenAI, а не нативный `generateContent`.

```json
{
  "kotTestToolkit.ai.apiFormat": "chatCompletions",
  "kotTestToolkit.ai.baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
  "kotTestToolkit.ai.apiVersion": "",
  "kotTestToolkit.ai.apiKey": "YOUR_API_KEY",
  "kotTestToolkit.ai.model": "YOUR_MODEL_ID",
  "kotTestToolkit.ai.outputLanguage": "ru",
  "kotTestToolkit.ai.timeoutSeconds": 180
}
```

Контракт: [официальная инструкция Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai).

## Azure OpenAI v1

Для v1 укажите ресурс и **имя развёртывания** в `model`. Параметр `apiVersion` оставьте пустым. Если deployment не поддерживает Responses, выберите `chatCompletions` с тем же базовым адресом.

```json
{
  "kotTestToolkit.ai.apiFormat": "responses",
  "kotTestToolkit.ai.baseUrl": "https://YOUR_RESOURCE.openai.azure.com/openai/v1",
  "kotTestToolkit.ai.apiVersion": "",
  "kotTestToolkit.ai.apiKey": "YOUR_RESOURCE_API_KEY",
  "kotTestToolkit.ai.model": "YOUR_DEPLOYMENT_NAME",
  "kotTestToolkit.ai.outputLanguage": "ru",
  "kotTestToolkit.ai.timeoutSeconds": 180
}
```

Microsoft документирует v1 с Bearer-авторизацией ключом ресурса и без обязательной датированной версии API. [Endpoint и авторизация](https://learn.microsoft.com/en-za/azure/foundry/foundry-models/concepts/endpoints?view=foundry), [переход на v1](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle).

Старый адрес `/openai/deployments/…` с датированным `api-version` — другой маршрут. KOT умеет добавить query-параметр версии, но не меняет заголовок Bearer на `api-key`. Поэтому простой перенос старого примера с ключом ресурса может не работать. KOT также не получает и не обновляет Entra-токены автоматически; для такой корпоративной авторизации нужен совместимый шлюз или отдельно подготовленный действующий токен.

## Проверить подключение

Сохраните настройки и вызовите **Описать с помощью ИИ** на небольшом учебном сценарии. Проверьте результат перед сохранением. `outputLanguage` меняет язык ответа, `maxLineLength` — перенос строк описания, `systemPrompt` полностью заменяет встроенный prompt; начинайте без его переопределения.

| Симптом | Что проверить |
|---|---|
| `AI settings are incomplete` | Адрес, модель и непустой ключ; даже локальный сервер требует заполнения поля в KOT |
| Нет соединения | Запущен ли сервер и совпадают ли компьютер/порт; `localhost` относится к компьютеру Extension Host |
| `404` / `405` | Базовый путь, отсутствие двойного хвоста и поддержку выбранного API |
| `401` / `403` | Ключ, тип авторизации и права на модель/ресурс |
| Модель не найдена | Точный ID или имя Azure deployment; загрузку локальной модели |
| Таймаут | Доступность сервера, размер контекста и `timeoutSeconds` |
| `429` | Лимиты и квоту вашего сервиса |
| Пустой или неожиданный ответ | Совместимость текстового ответа сервиса с выбранным API; собственный system prompt |

Ключ хранится в настройках VS Code; для личного подключения выбирайте пользовательскую область. Передача текста зависит от адреса сервиса. [Какие данные входят в запрос](../technical/ai-data.md) · [Три AI-задачи](ai-description.md).
