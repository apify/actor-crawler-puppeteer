/**
 * Represents the key under which internal metadata
 * such as crawling depth are stored on the Request object.
 * @type {string}
 */
exports.META_KEY = '_crawler-puppeteer-run-metadata_';

/**
 * The default resolution to be used by the browser instances.
 * @type {{width: number, height: number}}
 */
exports.DEFAULT_VIEWPORT = {
    width: 1920,
    height: 1080,
};

/**
 * Name of file that holds Page Function in local development.
 * @type {string}
 */
exports.PAGE_FUNCTION_FILENAME = 'page_function.js';

/**
 * Just a handlePageFunction timeout value for when DevTools are used
 * so the user has time to browse the DevTools console.
 * @type {number}
 */
exports.DEVTOOLS_TIMEOUT_SECS = 3600;
