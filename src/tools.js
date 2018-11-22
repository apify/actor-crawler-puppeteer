const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { promisify, inspect } = require('util');

const Apify = require('apify');
const _ = require('underscore');
const Ajv = require('ajv');

const { META_KEY, RESOURCE_LOAD_ERROR_MESSAGE, PAGE_FUNCTION_FILENAME } = require('./consts');
const schema = require('../INPUT_SCHEMA.json');

const { utils: { log, puppeteer } } = Apify;

exports.evalPageFunctionOrThrow = (funcString) => {
    let func;

    try {
        func = vm.runInThisContext(funcString);
    } catch (err) {
        throw new Error(`Compilation of pageFunction failed.\n${err.stack.substr(err.stack.indexOf('\n'))}`);
    }

    if (!_.isFunction(func)) throw new Error('Input parameter "pageFunction" is not a function!');

    return func;
};

/**
 * Wraps Apify.utils.puppeteer.enqueueLinks with metadata-adding logic
 * to enable depth tracking in requests.
 *
 * @param {Page} page
 * @param {string} linkSelector
 * @param {Object[]} pseudoUrls
 * @param {RequestQueue} requestQueue
 * @param {Request} parentRequest
 * @return {Promise}
 */
exports.enqueueLinks = async (page, linkSelector, pseudoUrls, requestQueue, parentRequest) => {
    const pseudoUrlsWithMeta = exports.addDepthMetadataToPurls(pseudoUrls, parentRequest);
    const queueOperationInfos = await puppeteer.enqueueLinks(
        page,
        linkSelector,
        requestQueue,
        pseudoUrlsWithMeta,
    );

    queueOperationInfos.forEach(({ requestId }) => {
        parentRequest.userData[META_KEY].childRequestIds[requestId] = 1;
    });
};

exports.checkInputOrThrow = (input) => {
    const ajv = new Ajv({ allErrors: true, useDefaults: true });
    const valid = ajv.validate(schema, input);
    if (!valid) throw new Error(`Invalid input:\n${JSON.stringify(ajv.errors, null, 2)}`);
};

/**
 * MODIFIES the provided Request by attaching necessary metadata.
 * Currently it only adds depth metadata, but it may be extended
 * as needed.
 *
 * @param {Request} request
 */
exports.ensureMetaData = ({ id, userData }) => {
    const metadata = userData[META_KEY];
    if (!metadata) {
        userData[META_KEY] = {
            depth: 0,
            parentRequestId: null,
            childRequestIds: {},
        };
        return;
    }
    if (typeof metadata !== 'object') throw new Error(`Request ${id} contains invalid metadata value.`);
};

/**
 * Merges the result of the page function, that may be a single object
 * or an array objects, with request metadata and a flag, whether
 * an error occured. This would typically be used after the page
 * had been retried and the handleFailedRequestFunction was called.
 *
 * If an Object[] is returned from the page function, each of the objects
 * will have the metadata appended for consistency, since the dataset
 * will flatten the results.
 *
 * @param {Request} request
 * @param {Object|Object[]} pageFunctionResult
 * @param {Boolean} [isError]
 * @returns {Object[]}
 */
exports.createDatasetPayload = (request, pageFunctionResult, isError = false) => {
    // Null and undefined do not prevent the payload
    // from being saved to dataset. It will just contain
    // the relevant metadata.
    let result = pageFunctionResult || {};

    // Validate the result.
    const type = typeof result;
    if (type !== 'object') {
        throw new Error(`Page function must return Object | Object[], but it returned ${type}.`);
    }

    // Metadata need to be appended to each item
    // to match results with dataset "lines".
    if (!Array.isArray(result)) result = [result];
    const meta = {
        '#error': isError,
        '#debug': _.pick(request, ['url', 'method', 'retryCount', 'errorMessages']),
    };
    meta['#debug'].requestId = request.id;

    return result.map(item => Object.assign({}, item, meta));
};

const randomBytes = promisify(crypto.randomBytes);

/**
 * Creates a 12 byte random hash encoded as base64
 * to be used as identifier.
 *
 * @return {Promise<string>}
 */
exports.createRandomHash = async () => {
    return (await randomBytes(12))
        .toString('base64')
        .replace(/[+/=]/g, 'x') // Remove invalid chars.
        .replace(/^\d/, 'a'); // Ensure first char is not a digit.
};
/**
 * Attaches the provided function to the Browser context
 * by exposing it via page.exposeFunction. Returns a string
 * handle to be used to reference the exposed function in
 * the browser context.
 *
 * @param {Page} page
 * @param {Function} func
 * @returns {string}
 */
exports.createBrowserHandle = async (page, func) => {
    const handle = await exports.createRandomHash();
    await page.exposeFunction(handle, func);
    return handle;
};

/**
 * Exposes selected methods of an instance (of a Class or just an Object)
 * in the Browser context and returns their mapping.
 *
 * @param {Page} page
 * @param {Object} instance
 * @param {string[]} methods
 * @return {Promise<Object>}
 */
exports.createBrowserHandlesForObject = async (page, instance, methods) => {
    const selectedMethods = _.pick(instance, methods);
    const promises = Object
        .entries(selectedMethods)
        .map(async ([name, method]) => {
            const handle = await exports.createBrowserHandle(page, method.bind(instance));
            return { name, handle };
        });
    const props = await Promise.all(promises);
    return props.reduce((mappings, prop) => {
        mappings[prop.name] = prop.handle;
        return mappings;
    }, {});
};

/**
 * Attaches a console listener to page's console that
 * mirrors all console messages to the Node context.
 *
 * This is used instead of the "dumpio" launch option
 * to prevent cluttering the STDOUT with unnecessary
 * Chromium messages, usually internal errors, occuring in page.
 * @param {Page} page
 * @param {Object} [options]
 * @param {boolean} [options.logErrors=false]
 *   Prevents Browser context errors from being logged by default,
 *   since there are usually a lot of errors produced by scraping
 *   due to blocking resources, running headless, etc.
 */
exports.dumpConsole = (page, options = {}) => {
    page.on('console', async (msg) => {
        if (msg.type() === 'error' && !options.logErrors) return;

        // Do not ever log "Failed to load resource" errors, because they flood the log.
        if (msg.text() === RESOURCE_LOAD_ERROR_MESSAGE) return;

        // Check for JSHandle tags in .text(), since .args() will
        // always include JSHandles, even for strings.
        const hasJSHandles = msg.text().includes('JSHandle@');

        // If there are any unresolved JSHandles, get their JSON representations.
        // Otherwise, just use the text immediately.
        let message;
        if (hasJSHandles) {
            const msgPromises = msg.args().map((jsh) => {
                return jsh.jsonValue()
                    .catch(e => log.exception(e, `Stringification of console.${msg.type()} in browser failed.`));
            });
            message = (await Promise.all(msgPromises))
                .map(m => inspect(m))
                .join(' '); // console.log('a', 'b') produces 'a b'
        } else {
            message = msg.text();
        }
        if (log[msg.type()]) log[msg.type()](message);
        else log.info(message);
    });
};

/**
 * Checks whether an item is a plain object,
 * i.e. not a function or array as _.isObject()
 * would check for.
 * @param {*} item
 * @return {boolean}
 */
exports.isPlainObject = item => item && typeof item === 'object' && !Array.isArray(item);

/**
 * Apify.utils.puppeteer.enqueueLinks does not support appending information
 * to the Requests it creates and neither does it support depth metadata
 * so we stick the metadata to the Pseudo URL objects we received on INPUT
 * and enqueueLinks will then construct PseudoURLs with relevant requestTemplates,
 * which in turn will make sure the metadata are available on the Requests
 * in the RequestQueue.
 *
 * @param {Object[]} pseudoUrls
 * @param {Request} parentRequest
 */
exports.addDepthMetadataToPurls = (pseudoUrls, parentRequest) => {
    // Make a deep copy since we must not modify original pseudo URLs.
    pseudoUrls = JSON.parse(JSON.stringify(pseudoUrls));

    const parentDepth = parentRequest.userData[META_KEY].depth || 0;
    const depthMeta = {
        depth: parentDepth + 1,
        parentRequestId: parentRequest.id,
        childRequestIds: {},
    };

    return pseudoUrls.map((purlObj) => {
        purlObj.userData = !purlObj.userData // eslint-disable-line no-nested-ternary
            ? { [META_KEY]: depthMeta }
            : purlObj.userData[META_KEY]
                ? Object.assign(purlObj.userData[META_KEY], depthMeta)
                : Object.assign(purlObj.userData, { [META_KEY]: depthMeta });
        return purlObj;
    });
};

/**
 * Helper that throws after timeout secs with the error message.
 * @param {number} timeoutSecs
 * @param {string} errorMessage
 * @return {Promise}
 */
exports.createTimeoutPromise = async (timeoutSecs, errorMessage) => {
    await new Promise(res => setTimeout(res, timeoutSecs * 1000));
    throw new Error(errorMessage);
};

/**
 * Enables the use of legacy willFinishLater by resolving a Promise
 * from within the browser context using the provided finish function.
 * @return {{finish: (function(): void), finished: boolean, resolve: (function(): void), createFinishPromise: (function(): Promise)}}
 */
exports.createWillFinishLaterWrapper = () => {
    const wrapper = {
        finished: false,
        finish: () => {
            log.debug('context.finish() was called!');
            wrapper.resolve();
        },
        resolve: () => { wrapper.finished = true; },
        createFinishPromise: () => new Promise((res) => { wrapper.resolve = res; }),
    };
    return wrapper;
};

/**
 * Add label to request for backwards compatibility with
 * Crawler code.
 *
 * @param request
 */
exports.copyLabelToRequest = (request) => {
    if (request.userData && request.userData.label) {
        const requestCopy = JSON.parse(JSON.stringify(request));
        requestCopy.label = request.userData.label;
        return requestCopy;
    }
    return request;
};

/**
 * Attempts to load Page Function from disk if it's not available
 * on INPUT.
 *
 * @param {Input} input
 */
exports.maybeLoadPageFunctionFromDisk = (input) => {
    if (input.pageFunction) return;
    const pageFunctionPath = path.join(__dirname, PAGE_FUNCTION_FILENAME);
    log.debug(`Loading Page Function from disk: ${path}`);
    try {
        input.pageFunction = fs.readFileSync(pageFunctionPath, 'utf8');
    } catch (err) {
        log.debug('Page Function load from disk failed.');
    }
};
