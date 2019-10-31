import deepEqual from 'fast-deep-equal';
import {createAxiosConfig} from './utils';
import {API_REQUEST_TYPE, API_CANCEL_TYPE, SEND_LATEST, IGNORE, SEND_ALL} from './types';
import {
  createRequest,
  cancelRequest,
  completeRequest,
  resetRequests,
  getSavedRequest,
  clearSavedRequests,
  getRequestCount,
  saveRequest,
  getLatestRequest
} from './requestStatus';

// Instance set in getMiddleware. The isCancel and CancelToken properties
// are also set on the instance.
let axios = null;

// For tests, cancels everything and removes requests
// each time configureMiddleware is called.
function reset() {
  resetRequests();
}

let enableTracing = false;
function log(message) {
  if (enableTracing) {
    // eslint-disable-next-line
    console.log(`restMiddleware: ${message}`);
  }
}

function handleSuccess(name, store, res, successAction) {
  log(`dispatching success action for ${name}`);
  const action = successAction((res && res.data) || null);
  if (!action.meta) {
    action.meta = res;
  }
  store.dispatch(action);
}

function handleSuccessMultiple(name, store, results, successAction, spread) {
  log(`dispatching success action for multiple results ${name}`);
  const combined = results.map(res => res.data);
  let action = null;
  if (spread) {
    action = successAction(...combined, results);
  } else {
    action = successAction(combined, results);
  }
  if (!action.meta) {
    action.meta = results;
  }
  store.dispatch(action);
  return combined;
}

function handleError(name, store, err, errorAction) {
  // Don't throw errors for cancellations, cancelled actions can be used.
  if (axios.isCancel(err)) {
    // request status already deleted
    log(`Ignoring error due to CANCELATION for ${name}`);
    return true;
  }
  if (errorAction) {
    log(`dispatching error action for ${name}`);
    const action = errorAction(err);
    action.error = true;
    store.dispatch(action);
  }
  return false;
}

async function sendAxiosRequest(url, apiConfig, requestConfig, store) {
  const cfg = {...requestConfig, url};
  let res = null;
  try {
    res = await axios(cfg);
    handleSuccess(apiConfig.name, store, res, apiConfig.successAction);
    return res && res.data ? res.data : null;
  } catch (err) {
    const isCancel = handleError(apiConfig.name, store, err, apiConfig.errorAction);
    // If caller used api.requestAction.then() handler, the undefined
    // return value can be used to detect that the api request was
    // canceled vs returning data or null
    // eslint-disable-next-line
    return isCancel ? undefined : null;
  }
}

async function sendAxiosRequests(urls, apiConfig, requestConfig, store) {
  const allRequests = urls.map(url => {
    const cfg = {...requestConfig, url};
    return axios(cfg);
  });

  try {
    let results = await Promise.all(allRequests);
    const spread = apiConfig.spread ? true : false;
    results = handleSuccessMultiple(
      apiConfig.name,
      store,
      results,
      apiConfig.successAction,
      spread
    );
    return results;
  } catch (err) {
    const isCancel = handleError(apiConfig.name, store, err, apiConfig.errorAction);
    // If caller used api.requestAction.then() handler, the undefined
    // return value can be used to detect that the api request was
    // canceled vs returning data or null
    // eslint-disable-next-line
    return isCancel ? undefined : null;
  }
}

function handleOverlappingRequest(apiConfig, requestAction, requestConfig) {
  if (apiConfig.overlappingRequests === SEND_LATEST) {
    saveRequest(apiConfig.name, requestAction, requestConfig);
    log(`Overlapping request for ${apiConfig.name}, storing latest axios config`);
    // Don't send request, latestConfig will be checked when first
    // response is recieved.
    return false;
  } else if (apiConfig.overlappingRequests === SEND_ALL) {
    log(`Sending overlapping request for ${apiConfig.name}`);
    return true;
  } else if (apiConfig.overlappingRequests === IGNORE) {
    log(`Ignoring overlapping request for ${apiConfig.name}`);
    return false;
  } else {
    // CANCEL_PENDING
    // eslint-disable-next-line
    const [lastRequest, lastConfig] = getLatestRequest(apiConfig.name);
    log(`Canceling current request for ${apiConfig.name} and sending new request`);
    cancelRequest(apiConfig.name, lastConfig);
    return true;
  }
}

// This function is used to send all requests via apiConfig[name].sendRequest.
// It is exported because confgureApi either inserts it directly or inserts
// a debounced version with the configured properties into the apiConfig.
export async function sendRequest(
  store,
  apiConfig,
  action,
  requestAction,
  requestUrls,
  requestConfig,
  cancelSource
) {
  const config = apiConfig[action.name];

  // store axios config and cancel source
  log(`created new request status for ${action.name}`);
  createRequest(action.name, requestAction, requestConfig, cancelSource);

  log(`dispatching requestAction for ${action.name}`);
  store.dispatch(requestAction);

  let res;
  if (requestUrls.length === 1) {
    res = await sendAxiosRequest(requestUrls[0], config, requestConfig, store);
  } else {
    res = await sendAxiosRequests(requestUrls, config, requestConfig, store);
  }

  // This only occurs when overlap mode is SEND_LATEST
  const [latestRequest, latestConfig] = getSavedRequest(action.name);
  if (latestConfig && !deepEqual(latestConfig, requestConfig)) {
    log(`===> requestConfig for ${action.name} has changed, sending latest request`);
    // completeAction has been dispatched with first result, need to
    // dispatch the latest requestAction with the latest axios config.
    store.dispatch(latestRequest);
    const newPromise =
      requestUrls.length === 1
        ? sendAxiosRequest(requestUrls[0], config, latestConfig, store)
        : sendAxiosRequests(requestUrls, config, latestConfig, store);
    clearSavedRequests(action.name);
    return newPromise;
  }
  completeRequest(action.name, requestConfig);
  return res;
}

// Configure axios instance and return the middleware accessor function.
export function getMiddleware(apiConfig, axiosInstance, enableTracingFlag = false) {
  axios = axiosInstance;
  enableTracing = enableTracingFlag;

  // Reset for testing, when invoked configuring middleware multiple times.
  reset();

  // return the actual middleware
  return store => next => action => {
    // eslint-disable-next-line
    if (!(action.type === API_REQUEST_TYPE || action.type == API_CANCEL_TYPE)) {
      return next(action);
    }

    const config = apiConfig[action.name];

    let requestAction, requestConfig, requestUrls, cancelSource;
    try {
      [requestAction, requestConfig, requestUrls, cancelSource] = createAxiosConfig(
        config,
        action,
        store,
        axios
      );
    } catch (err) {
      // These are errors like missing URL param values that can't be
      // detected when validating the api config.
      if (config.errorAction) {
        const errorAction = config.errorAction(err);
        log(`dispatching runtime error for ${action.name}: ${err.toString()}`);
        store.dispatch(errorAction);
      }
      return Promise.resolve(null);
    }

    if (action.type === API_CANCEL_TYPE) {
      const canceled = cancelRequest(action.name, action.token);

      if (typeof config.sendRequest.cancel === 'function') {
        log(`canceled debounced function for ${action.name}`);
        config.sendRequest.cancel();
      }
      if (!canceled) return;

      log(`canceled request for ${action.name}`);
      if (config.canceledAction) {
        log(`dispatched CANCELED action for ${action.name}`);
        store.dispatch(config.canceledAction(action.reason));
      }
      return;
    }

    return (async () => {
      if (getRequestCount(action.name)) {
        if (!handleOverlappingRequest(config, requestAction, requestConfig)) {
          // Not dispatching this request
          return;
        }
      }
      return config.sendRequest(
        store,
        apiConfig,
        action,
        requestAction,
        requestUrls,
        requestConfig,
        cancelSource
      );
    })();
  };
}