import { retryInterval } from 'asyncbox';
import { util, timing } from 'appium-support';
import log from '../logger';
import _ from 'lodash';
import B from 'bluebird';
import { errors, isErrorType } from 'appium-base-driver';
import cookieUtils from '../cookies';

const IPHONE_TOP_BAR_HEIGHT = 71;
const IPHONE_SCROLLED_TOP_BAR_HEIGHT = 41;
const IPHONE_X_SCROLLED_OFFSET = 55;
const IPHONE_X_NOTCH_OFFSET_IOS = 24;
const IPHONE_X_NOTCH_OFFSET_IOS_13 = 20;

const IPHONE_LANDSCAPE_TOP_BAR_HEIGHT = 51;
const IPHONE_BOTTOM_BAR_OFFSET = 49;
const TAB_BAR_OFFSET = 33;
const IPHONE_WEB_COORD_SMART_APP_BANNER_OFFSET = 84;
const IPAD_WEB_COORD_SMART_APP_BANNER_OFFSET = 95;

const NOTCHED_DEVICE_SIZES = [
  {w: 1125, h: 2436}, // 11 Pro, X, Xs
  {w: 828, h: 1792}, // 11, Xr
  {w: 1242, h: 2688}, // 11 Pro Max, Xs Max
];

const { W3C_WEB_ELEMENT_IDENTIFIER } = util;

const ATOM_WAIT_TIMEOUT_MS = 2 * 60000;
const ATOM_INITIAL_WAIT_MS = 1000;

const commands = {}, helpers = {}, extensions = {};

function isValidElementIdentifier (id) {
  if (!_.isString(id) && !_.isNumber(id)) {
    return false;
  }
  if (_.isString(id) && _.isEmpty(id)) {
    return false;
  }
  if (_.isNumber(id) && isNaN(id)) {
    return false;
  }
  return true;
}

commands.setFrame = async function setFrame (frame) {
  if (!this.isWebContext()) {
    throw new errors.NotImplementedError();
  }

  if (_.isNull(frame)) {
    this.curWebFrames = [];
    log.debug('Leaving web frame and going back to default content');
    return;
  }

  if (helpers.hasElementId(frame)) {
    const atomsElement = this.getAtomsElement(frame);
    const value = await this.executeAtom('get_frame_window', [atomsElement]);
    log.debug(`Entering new web frame: '${value.WINDOW}'`);
    this.curWebFrames.unshift(value.WINDOW);
  } else {
    const atom = _.isNumber(frame) ? 'frame_by_index' : 'frame_by_id_or_name';
    const value = await this.executeAtom(atom, [frame]);
    if (_.isNull(value) || _.isUndefined(value.WINDOW)) {
      throw new errors.NoSuchFrameError();
    }
    log.debug(`Entering new web frame: '${value.WINDOW}'`);
    this.curWebFrames.unshift(value.WINDOW);
  }
};

commands.getCssProperty = async function getCssProperty (propertyName, el) {
  if (!this.isWebContext()) {
    throw new errors.NotImplementedError();
  }

  const atomsElement = this.getAtomsElement(el);
  return await this.executeAtom('get_value_of_css_property', [atomsElement, propertyName]);
};

commands.submit = async function submit (el) {
  if (!this.isWebContext()) {
    throw new errors.NotImplementedError();
  }

  const atomsElement = this.getAtomsElement(el);
  await this.executeAtom('submit', [atomsElement]);
};

commands.refresh = async function refresh () {
  if (!this.isWebContext()) {
    throw new errors.NotImplementedError();
  }

  await this.executeAtom('refresh', []);
};

commands.getUrl = async function getUrl () {
  if (!this.isWebContext()) {
    throw new errors.NotImplementedError();
  }

  return await this.remote.execute('window.location.href');
};

commands.title = async function title () {
  if (!this.isWebContext()) {
    throw new errors.NotImplementedError();
  }

  return await this.executeAtom('title', [], true);
};

commands.getCookies = async function getCookies () {
  if (!this.isWebContext()) {
    throw new errors.NotImplementedError();
  }

  log.debug('Retrieving all cookies');

  let script = 'return document.cookie';
  let jsCookies = await this.executeAtom('execute_script', [script, []]);

  let cookies = [];
  try {
    for (let [name, value] of _.toPairs(cookieUtils.createJWPCookie(undefined, jsCookies))) {
      cookies.push({name, value});
    }
    return cookies;
  } catch (err) {
    log.error(err);
    throw new errors.UnknownError(`Error parsing cookies from result: '${jsCookies}'`);
  }
};

commands.setCookie = async function setCookie (cookie) {
  if (!this.isWebContext()) {
    throw new errors.NotImplementedError();
  }

  cookie = _.clone(cookie);

  // if `path` field is not specified, Safari will not update cookies as expected; eg issue #1708
  if (!cookie.path) {
    cookie.path = '/';
  }

  const jsCookie = cookieUtils.createJSCookie(cookie.name, cookie.value, {
    expires: _.isNumber(cookie.expiry) ? (new Date(cookie.expiry * 1000)).toUTCString() :
      cookie.expiry,
    path: cookie.path,
    domain: cookie.domain,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure
  });
  let script = `document.cookie = ${JSON.stringify(jsCookie)}`;
  await this.executeAtom('execute_script', [script, []]);
};

commands.deleteCookie = async function deleteCookie (cookieName) {
  if (!this.isWebContext()) {
    throw new errors.NotImplementedError();
  }

  // check cookie existence
  let cookies = await this.getCookies();
  if (_.indexOf(_.map(cookies, 'name'), cookieName) === -1) {
    log.debug(`Cookie '${cookieName}' not found. Ignoring.`);
    return true;
  }

  return await this._deleteCookie(cookieName);
};

commands.deleteCookies = async function deleteCookies () {
  if (!this.isWebContext()) {
    throw new errors.NotImplementedError();
  }

  let cookies = await this.getCookies();
  if (cookies.length) {
    for (let cookie of cookies) {
      await this._deleteCookie(cookie.name);
    }
  }
  return true;
};

helpers._deleteCookie = async function _deleteCookie (cookieName) {
  log.debug(`Deleting cookie '${cookieName}'`);
  let webCookie = cookieUtils.expireCookie(cookieName, {path: '/'});
  let script = `document.cookie = ${JSON.stringify(webCookie)}`;
  await this.executeAtom('execute_script', [script, []]);
};

helpers.cacheWebElements = function cacheWebElements (rawElements) {
  if (!(_.isArray(rawElements) || _.isPlainObject(rawElements))) {
    throw new errors.UnknownError(`Web element identifiers cannot be parsed from ` +
      JSON.stringify(rawElements));
  }

  const cacheElement = (el) => {
    const elId = util.unwrapElement(el);
    if (!isValidElementIdentifier(elId)) {
      throw new errors.UnknownError(`The web element identifier ${JSON.stringify(elId)} cannot be parsed`);
    }
    // In newer debugger releases element identifiers look like `:wdc:1628151649325`
    // We assume it is safe to use these to identify cached elements
    const cacheId = _.includes(elId, ':') ? elId : util.uuidV4();
    this.webElementsCache.set(cacheId, elId);
    return util.wrapElement(cacheId);
  };

  return _.isArray(rawElements) ? rawElements.map(cacheElement) : cacheElement(rawElements);
};

extensions.findWebElementOrElements = async function findWebElementOrElements (strategy, selector, many, ctx) {
  const contextElement = _.isNil(ctx) ? null : this.getAtomsElement(ctx);
  let element;
  let doFind = async () => {
    element = await this.executeAtom(`find_element${many ? 's' : ''}`, [strategy, selector, contextElement]);
    return !_.isNull(element);
  };
  try {
    await this.implicitWaitForCondition(doFind);
  } catch (err) {
    if (err.message && _.isFunction(err.message.match) && err.message.match(/Condition unmet/)) {
      // condition was not met setting res to empty array
      element = [];
    } else {
      throw err;
    }
  }

  if (many) {
    return this.cacheWebElements(element);
  }
  if (!element || _.size(element) === 0) {
    throw new errors.NoSuchElementError();
  }
  return this.cacheWebElements(element);
};

extensions.clickWebCoords = async function clickWebCoords () {
  let coords = await this.translateWebCoords(this.curWebCoords);
  await this.clickCoords(coords);
};

helpers.executeAtom = async function executeAtom (atom, args, alwaysDefaultFrame = false) {
  let frames = alwaysDefaultFrame === true ? [] : this.curWebFrames;
  let promise = this.remote.executeAtom(atom, args, frames);
  return await this.waitForAtom(promise);
};

helpers.executeAtomAsync = async function executeAtomAsync (atom, args, responseUrl) {
  // save the resolve and reject methods of the promise to be waited for
  let promise = new B((resolve, reject) => {
    this.asyncPromise = {resolve, reject};
  });
  await this.remote.executeAtomAsync(atom, args, this.curWebFrames, responseUrl);
  return await this.waitForAtom(promise);
};

helpers.getAtomsElement = function getAtomsElement (elOrId) {
  const elId = util.unwrapElement(elOrId);
  if (!this.webElementsCache.has(elId)) {
    throw new errors.StaleElementReferenceError();
  }
  return {ELEMENT: this.webElementsCache.get(elId)};
};

helpers.convertElementsForAtoms = function convertElementsForAtoms (args = []) {
  return args.map((arg) => {
    if (helpers.hasElementId(arg)) {
      try {
        return this.getAtomsElement(arg);
      } catch (err) {
        if (!isErrorType(err, errors.StaleElementReferenceError)) {
          throw err;
        }
      }
      return arg;
    }
    return _.isArray(arg) ? this.convertElementsForAtoms(arg) : arg;
  });
};

helpers.getElementId = function getElementId (element) {
  return element.ELEMENT || element[W3C_WEB_ELEMENT_IDENTIFIER];
};

helpers.hasElementId = function hasElementId (element) {
  return util.hasValue(element) && (util.hasValue(element.ELEMENT) || util.hasValue(element[W3C_WEB_ELEMENT_IDENTIFIER]));
};

extensions.getSafariIsIphone = _.memoize(async function getSafariIsIphone () {
  try {
    const userAgent = await this.execute('return navigator.userAgent');
    return userAgent.toLowerCase().includes('iphone');
  } catch (err) {
    log.warn(`Unable to find device type from useragent. Assuming iPhone`);
    log.debug(`Error: ${err.message}`);
  }
  return true;
});

extensions.getSafariDeviceSize = _.memoize(async function getSafariDeviceSize () {
  const script = 'return {height: window.screen.availHeight * window.devicePixelRatio, width: window.screen.availWidth * window.devicePixelRatio};';
  const {width, height} = await this.execute(script);
  const [normHeight, normWidth] = height > width ? [height, width] : [width, height];
  return {
    width: normWidth,
    height: normHeight,
  };
});

extensions.getSafariIsNotched = _.memoize(async function getSafariIsNotched () {
  try {
    const {width, height} = await this.getSafariDeviceSize();
    for (const device of NOTCHED_DEVICE_SIZES) {
      if (device.w === width && device.h === height) {
        return true;
      }
    }
  } catch (err) {
    log.warn(`Unable to find device type from dimensions. Assuming the device is not notched`);
    log.debug(`Error: ${err.message}`);
  }
  return false;
});

extensions.getExtraTranslateWebCoordsOffset = async function getExtraTranslateWebCoordsOffset (wvPos, realDims) {
  let topOffset = 0;
  let bottomOffset = 0;

  const isIphone = await this.getSafariIsIphone();
  const isNotched = isIphone && await this.getSafariIsNotched();

  const orientation = realDims.h > realDims.w ? 'PORTRAIT' : 'LANDSCAPE';

  const notchOffset = isNotched
    ? util.compareVersions(this.opts.platformVersion, '=', '13.0')
      ? IPHONE_X_NOTCH_OFFSET_IOS_13
      : IPHONE_X_NOTCH_OFFSET_IOS
    : 0;

  const isScrolled = await this.execute('return document.documentElement.scrollTop > 0');
  if (isScrolled) {
    topOffset = IPHONE_SCROLLED_TOP_BAR_HEIGHT + notchOffset;

    if (isNotched) {
      topOffset -= IPHONE_X_SCROLLED_OFFSET;
    }

    // If the iPhone is landscape then there is no top bar
    if (orientation === 'LANDSCAPE' && isIphone) {
      topOffset = 0;
    }
  } else {
    topOffset = IPHONE_TOP_BAR_HEIGHT + notchOffset;

    if (isIphone) {
      if (orientation === 'PORTRAIT') {
        // The bottom bar is only visible when portrait
        bottomOffset = IPHONE_BOTTOM_BAR_OFFSET;
      } else {
        topOffset = IPHONE_LANDSCAPE_TOP_BAR_HEIGHT;
      }
    }

    if (orientation === 'LANDSCAPE' || !isIphone) {
      // Tabs only appear if the device is landscape or if it's an iPad so we only check visibility in this case
      const tabs = await this.findNativeElementOrElements('-ios predicate string', `name LIKE '*, Tab' AND visible = 1`, true);
      if (tabs.length > 0) {
        topOffset += TAB_BAR_OFFSET;
      }
    }
  }

  topOffset += await this.getExtraNativeWebTapOffset();

  wvPos.y += topOffset;
  realDims.h -= (topOffset + bottomOffset);
};

extensions.getExtraNativeWebTapOffset = async function getExtraNativeWebTapOffset () {
  let offset = 0;

  // try to see if there is an Smart App Banner
  const banners = await this.findNativeElementOrElements('accessibility id', 'Close app download offer', true);
  if (banners.length > 0) {
    offset += await this.getSafariIsIphone() ?
      IPHONE_WEB_COORD_SMART_APP_BANNER_OFFSET :
      IPAD_WEB_COORD_SMART_APP_BANNER_OFFSET;
  }

  log.debug(`Additional native web tap offset computed: ${offset}`);
  return offset;
};

async function tapWebElementNatively (driver, atomsElement) {
  // try to get the text of the element, which will be accessible in the
  // native context
  try {
    let text = await driver.executeAtom('get_text', [atomsElement]);
    if (!text) {
      text = await driver.executeAtom('get_attribute_value', [atomsElement, 'value']);
    }

    if (text) {
      const els = await driver.findNativeElementOrElements('accessibility id', text, true);
      if (els.length === 1 || els.length === 2) {
        const el = els[0];
        // use tap because on iOS 11.2 and below `nativeClick` crashes WDA
        const rect = await driver.proxyCommand(`/element/${util.unwrapElement(el)}/rect`, 'GET');
        if (els.length === 2) {
          const el2 = els[1];
          const rect2 = await driver.proxyCommand(`/element/${util.unwrapElement(el2)}/rect`, 'GET');

          if ((rect.x !== rect2.x || rect.y !== rect2.y) ||
          (rect.width !== rect2.width || rect.height !== rect2.height)) {
            // These 2 native elements are not referring to the same web element
            return false;
          }
        }
        const coords = {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        };
        await driver.clickCoords(coords);
        return true;
      }
    }
  } catch (err) {
    // any failure should fall through and trigger the more elaborate
    // method of clicking
    log.warn(`Error attempting to click: ${err.message}`);
  }
  return false;
}

extensions.nativeWebTap = async function nativeWebTap (el) {
  const atomsElement = this.getAtomsElement(el);

  // if strict native tap, do not try to do it with WDA directly
  if (!(await this.settings.getSettings()).nativeWebTapStrict && await tapWebElementNatively(this, atomsElement)) {
    return;
  }
  log.warn('Unable to do simple native web tap. Attempting to convert coordinates');

  // `get_top_left_coordinates` returns the wrong value sometimes,
  // unless we pre-call both of these functions before the actual calls
  await this.executeAtom('get_size', [atomsElement]);
  await this.executeAtom('get_top_left_coordinates', [atomsElement]);

  const {width, height} = await this.executeAtom('get_size', [atomsElement]);
  let {x, y} = await this.executeAtom('get_top_left_coordinates', [atomsElement]);
  x += width / 2;
  y += height / 2;

  this.curWebCoords = {x, y};
  await this.clickWebCoords();
};

extensions.clickCoords = async function clickCoords (coords) {
  await this.performTouch([
    {
      action: 'tap',
      options: coords,
    },
  ]);
};

extensions.translateWebCoords = async function translateWebCoords (coords) {
  log.debug(`Translating coordinates (${JSON.stringify(coords)}) to web coordinates`);

  // absolutize web coords
  let webview = await retryInterval(5, 100, async () => {
    const webviews = await this.findNativeElementOrElements('class name', 'XCUIElementTypeWebView', true);
    if (webviews.length === 0) {
      throw new Error(`No webviews found. Unable to translate web coordinates for native web tap`);
    }
    return webviews[0];
  });
  webview = util.unwrapElement(webview);

  const rect = await this.proxyCommand(`/element/${webview}/rect`, 'GET');
  const wvPos = {x: rect.x, y: rect.y};
  const realDims = {w: rect.width, h: rect.height};

  const cmd = '(function () { return {w: window.innerWidth, h: window.innerHeight}; })()';
  const wvDims = await this.remote.execute(cmd);

  // keep track of implicit wait, and set locally to 0
  // https://github.com/appium/appium/issues/14988
  const implicitWaitMs = this.implicitWaitMs;
  await this.setImplicitWait(0);
  try {
    await this.getExtraTranslateWebCoordsOffset(wvPos, realDims);
  } finally {
    await this.setImplicitWait(implicitWaitMs);
  }

  if (wvDims && realDims && wvPos) {
    let xRatio = realDims.w / wvDims.w;
    let yRatio = realDims.h / wvDims.h;
    let newCoords = {
      x: wvPos.x + Math.round(xRatio * coords.x),
      y: wvPos.y + Math.round(yRatio * coords.y),
    };

    // additional logging for coordinates, since it is sometimes broken
    //   see https://github.com/appium/appium/issues/9159
    log.debug(`Converted coordinates: ${JSON.stringify(newCoords)}`);
    log.debug(`    rect: ${JSON.stringify(rect)}`);
    log.debug(`    wvPos: ${JSON.stringify(wvPos)}`);
    log.debug(`    realDims: ${JSON.stringify(realDims)}`);
    log.debug(`    wvDims: ${JSON.stringify(wvDims)}`);
    log.debug(`    xRatio: ${JSON.stringify(xRatio)}`);
    log.debug(`    yRatio: ${JSON.stringify(yRatio)}`);

    log.debug(`Converted web coords ${JSON.stringify(coords)} ` +
              `into real coords ${JSON.stringify(newCoords)}`);
    return newCoords;
  }
};

extensions.checkForAlert = async function checkForAlert () {
  return _.isString(await this.getAlertText());
};

extensions.waitForAtom = async function waitForAtom (promise) {
  const timer = new timing.Timer().start();

  // need to check for alert while the atom is being executed.
  // so notify ourselves when it happens
  const timedAtomPromise = B.resolve(promise).timeout(ATOM_WAIT_TIMEOUT_MS);
  const handlePromiseError = async (p) => {
    try {
      return await p;
    } catch (err) {
      const originalError = (err instanceof B.AggregateError) ? err[0] : err;
      log.debug(`Error received while executing atom: ${originalError.message}`);
      if (originalError instanceof B.TimeoutError) {
        throw new Error(`Did not get any response for atom execution after ` +
          `${timer.getDuration().asMilliSeconds.toFixed(0)}ms`);
      }
      throw originalError;
    }
  };

  // if the atom promise is fulfilled within ATOM_INITIAL_WAIT_MS
  // then we don't need to check for an alert presence
  await handlePromiseError(B.any([B.delay(ATOM_INITIAL_WAIT_MS), timedAtomPromise]));

  // otherwise make sure there is no unexpected alert covering the element
  if (timedAtomPromise.isPending()) {
    if (!this._webAlertChecker || !this._webAlertChecker.isPending()) {
      this._webAlertChecker = B.resolve((async () => {
        while (timedAtomPromise.isPending()) {
          try {
            if (await this.checkForAlert()) {
              return true;
            }
          } catch (ign) {}
        }
        return false;
      })());
    }
    await handlePromiseError(B.any([this._webAlertChecker, timedAtomPromise]));
    if (timedAtomPromise.isPending() && await this._webAlertChecker) {
      // To avoid unhandled exception error
      timedAtomPromise.catch(() => {});
      throw new errors.UnexpectedAlertOpenError();
    }
  }

  // at this point, all that can be done is wait for the atom promise
  // to be fulfilled
  return await handlePromiseError(timedAtomPromise);
};

extensions.mobileWebNav = async function mobileWebNav (navType) {
  this.remote.allowNavigationWithoutReload = true;
  try {
    await this.executeAtom('execute_script', [`history.${navType}();`, null]);
  } finally {
    this.remote.allowNavigationWithoutReload = false;
  }
};

Object.assign(commands, extensions, helpers);

export default commands;
