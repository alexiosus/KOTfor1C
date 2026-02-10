import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs'; // Используем для синхронной проверки существования локального бандла
import { getTranslator } from './localization';

// Ключ конфигурации для URL внешнего файла steps.htm
const EXTERNAL_STEPS_URL_CONFIG_KEY = 'kotTestToolkit.steps.externalUrl';
// URL по умолчанию, если в конфигурации не указан другой
const DEFAULT_EXTERNAL_STEPS_URL = ''; 
// Имя файла для локального кеша
const STEPS_CACHE_FILENAME = 'steps_cache.htm';
// Время жизни кеша в миллисекундах (например, 24 часа)
const CACHE_EXPIRY_DURATION_MS = 24 * 60 * 60 * 1000;
// Имя файла для временной метки кеша
const CACHE_TIMESTAMP_FILENAME = 'steps_cache_timestamp.txt';

/**
 * Получает URI для файла кеша.
 * @param context Контекст расширения.
 * @param filename Имя файла в кеше.
 * @returns vscode.Uri файла кеша.
 */
function getCacheFileUri(context: vscode.ExtensionContext, filename: string): vscode.Uri {
    if (!context.globalStorageUri) {
        // Этого не должно происходить в нормальных условиях, но для безопасности
        console.error("[StepsFetcher] Global storage URI is not available.");
        // В качестве крайнего случая, можно использовать extensionUri, но это не рекомендуется для кеша
        return vscode.Uri.joinPath(context.extensionUri, '.cache', filename);
    }
    return vscode.Uri.joinPath(context.globalStorageUri, filename);
}

/**
 * Загружает HTML-содержимое с указанного URL.
 * @param url URL для загрузки.
 * @returns Promise с HTML-строкой или null в случае ошибки.
 */
async function fetchStepsFromUrl(url: string): Promise<string | null> {
    console.log(`[StepsFetcher] Fetching steps from URL: ${url}`);
    return new Promise((resolve) => {
        https.get(url, (response) => {
            let data = '';
            if (response.statusCode !== 200) {
                console.error(`[StepsFetcher] Failed to fetch from URL. Status Code: ${response.statusCode}`);
                response.resume(); // Потребляем данные, чтобы освободить память
                resolve(null);
                return;
            }
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                console.log(`[StepsFetcher] Successfully fetched from URL.`);
                resolve(data);
            });
        }).on('error', (err) => {
            console.error(`[StepsFetcher] Error fetching from URL: ${err.message}`);
            resolve(null);
        }).setTimeout(15000, () => { // Таймаут 15 секунд
            console.error(`[StepsFetcher] Timeout fetching from URL: ${url}`);
            resolve(null);
        });
    });
}

/**
 * Загружает HTML-содержимое из локального кеша, если он валиден.
 * @param context Контекст расширения.
 * @returns Promise с HTML-строкой или null, если кеш отсутствует или невалиден.
 */
async function loadStepsFromCache(context: vscode.ExtensionContext): Promise<string | null> {
    const cacheFileUri = getCacheFileUri(context, STEPS_CACHE_FILENAME);
    const timestampFileUri = getCacheFileUri(context, CACHE_TIMESTAMP_FILENAME);

    try {
        // Проверяем временную метку
        const timestampBytes = await vscode.workspace.fs.readFile(timestampFileUri);
        const timestamp = parseInt(Buffer.from(timestampBytes).toString('utf-8'), 10);
        if (isNaN(timestamp) || (Date.now() - timestamp > CACHE_EXPIRY_DURATION_MS)) {
            console.log('[StepsFetcher] Cache expired or timestamp invalid.');
            return null;
        }

        // Читаем кешированный файл
        const cachedBytes = await vscode.workspace.fs.readFile(cacheFileUri);
        const cachedContent = Buffer.from(cachedBytes).toString('utf-8');
        console.log('[StepsFetcher] Loaded steps from cache.');
        return cachedContent;
    } catch (error) {
        // Ошибки чтения (файл не найден и т.д.) означают, что кеша нет или он поврежден
        console.log(`[StepsFetcher] Failed to load from cache or cache does not exist: ${error}`);
        return null;
    }
}

/**
 * Сохраняет HTML-содержимое в локальный кеш.
 * @param context Контекст расширения.
 * @param content HTML-строка для сохранения.
 */
async function saveStepsToCache(context: vscode.ExtensionContext, content: string): Promise<void> {
    const cacheFileUri = getCacheFileUri(context, STEPS_CACHE_FILENAME);
    const timestampFileUri = getCacheFileUri(context, CACHE_TIMESTAMP_FILENAME);

    try {
        // Убедимся, что директория для хранения существует
        const cacheDir = vscode.Uri.joinPath(context.globalStorageUri, '.'); // Получаем URI директории
        try {
            await vscode.workspace.fs.stat(cacheDir);
        } catch {
            console.log(`[StepsFetcher] Global storage directory does not exist, creating: ${cacheDir.fsPath}`);
            await vscode.workspace.fs.createDirectory(cacheDir);
        }
        
        await vscode.workspace.fs.writeFile(cacheFileUri, Buffer.from(content, 'utf-8'));
        await vscode.workspace.fs.writeFile(timestampFileUri, Buffer.from(Date.now().toString(), 'utf-8'));
        console.log('[StepsFetcher] Saved steps to cache.');
    } catch (error) {
        console.error(`[StepsFetcher] Failed to save to cache: ${error}`);
        // Не бросаем ошибку дальше, чтобы не прерывать основной поток, если кеширование не удалось
    }
}

/**
 * Загружает HTML-содержимое из локального файла в бандле расширения.
 * @param context Контекст расширения.
 * @returns Promise с HTML-строкой или null в случае ошибки.
 */
async function loadStepsFromBundle(context: vscode.ExtensionContext): Promise<string | null> {
    const localStepsPath = path.join(context.extensionPath, 'res', 'steps.htm');
    console.log(`[StepsFetcher] Attempting to load steps from local bundle: ${localStepsPath}`);
    try {
        // Используем синхронный fs.existsSync для быстрой проверки, т.к. это локальный файл
        if (fs.existsSync(localStepsPath)) {
            const contentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(localStepsPath));
            console.log('[StepsFetcher] Loaded steps from local bundle.');
            return Buffer.from(contentBytes).toString('utf-8');
        } else {
            console.error('[StepsFetcher] Local bundle steps.htm not found.');
            return null;
        }
    } catch (error) {
        console.error(`[StepsFetcher] Error loading from local bundle: ${error}`);
        return null;
    }
}

/**
 * Основная функция для получения HTML-содержимого steps.htm.
 * Реализует логику: внешний URL -> кеш -> локальный бандл.
 * @param context Контекст расширения.
 * @param forceRemote Если true, попытаться загрузить с URL, игнорируя свежий кеш (но кеш будет обновлен).
 * @returns Promise с HTML-строкой.
 * @throws Error если не удалось получить содержимое ни одним из способов.
 */
export async function getStepsHtml(context: vscode.ExtensionContext, forceRemote: boolean = false): Promise<string> {
    console.log(`[StepsFetcher:getStepsHtml] Acquiring steps. Force remote: ${forceRemote}`);
    let htmlContent: string | null = null;

    const userDefinedUrl = vscode.workspace.getConfiguration().get<string>(EXTERNAL_STEPS_URL_CONFIG_KEY);
    const externalUrl = userDefinedUrl && userDefinedUrl.trim() !== '' ? userDefinedUrl.trim() : DEFAULT_EXTERNAL_STEPS_URL;
    
    if (!forceRemote) {
        htmlContent = await loadStepsFromCache(context);
        if (htmlContent) {
            console.log('[StepsFetcher:getStepsHtml] Using fresh cache.');
            return htmlContent;
        }
        console.log('[StepsFetcher:getStepsHtml] Cache miss or expired.');
    } else {
        console.log('[StepsFetcher:getStepsHtml] Force remote fetch requested.');
    }

    // Попытка загрузки с URL
    if (externalUrl) {
        htmlContent = await fetchStepsFromUrl(externalUrl);
        if (htmlContent) {
            console.log('[StepsFetcher:getStepsHtml] Fetched from URL successfully.');
            await saveStepsToCache(context, htmlContent); // Обновляем кеш
            return htmlContent;
        }
        console.log('[StepsFetcher:getStepsHtml] Failed to fetch from URL or URL not configured.');
        // Если принудительная загрузка и она не удалась, не пытаемся грузить из кеша (т.к. он мог быть старым)
        // Но если это не принудительная, а просто кеш был старый, то после неудачной загрузки с URL можно попробовать кеш (уже сделано выше)
        // или бандл.
    }


    // Если URL не удался (или не был принудительным и кеш был старым/отсутствовал)
    // и это не был принудительный запрос, который уже должен был вернуть данные или ошибку,
    // попробуем кеш еще раз на случай, если forceRemote=true провалился, но кеш есть (хотя это маловероятно по логике выше)
    if (!htmlContent && !forceRemote) { // Только если не было forceRemote, т.к. кеш уже проверялся
        htmlContent = await loadStepsFromCache(context);
        if (htmlContent) {
            console.log('[StepsFetcher:getStepsHtml] Using cache after failed URL attempt (non-forced).');
            return htmlContent;
        }
    }
    
    // Попытка загрузки из локального бандла как последний вариант
    console.log('[StepsFetcher:getStepsHtml] Falling back to local bundle.');
    htmlContent = await loadStepsFromBundle(context);
    if (htmlContent) {
        return htmlContent;
    }

    throw new Error('Failed to load step definitions from external resource, cache, or local bundle.');
}

/**
 * Принудительно обновляет шаги с внешнего ресурса и сохраняет в кеш.
 * @param context Контекст расширения.
 */
export async function forceRefreshSteps(context: vscode.ExtensionContext): Promise<string> {
    console.log('[StepsFetcher:forceRefreshSteps] Force refreshing steps...');
    // getStepsHtml с forceRemote=true сделает всю работу: загрузит, сохранит в кеш.
    try {
        const htmlContent = await getStepsHtml(context, true);
        const t = await getTranslator(context.extensionUri);
        vscode.window.showInformationMessage(t('Steps library successfully updated.'));
        return htmlContent;
    } catch (error: any) {
        const t = await getTranslator(context.extensionUri);
        vscode.window.showErrorMessage(t('Error updating steps: {0}', error.message));
        throw error; // Передаем ошибку дальше, чтобы вызывающий код мог ее обработать
    }
}