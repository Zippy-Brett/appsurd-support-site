const RESOURCE_TYPES = ["sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "media", "websocket", "other"];
const TYPE_MAP = {document: "main_frame", subdocument: "sub_frame", stylesheet: "stylesheet", css: "stylesheet", script: "script", image: "image", font: "font", object: "object", xmlhttprequest: "xmlhttprequest", xhr: "xmlhttprequest", ping: "ping", media: "media", websocket: "websocket", other: "other"};
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PROCEDURAL = ["+js(", ":has-text(", ":-abp-", ":matches-css(", ":xpath(", ":remove(", ":style(", ":matches-path(", ":upward(", ":watch-attr(", ":others(", ":matches-attr(", ":matches-prop("];

export function domainMatches(host, domain) {
  host = host.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}
export function scopeMatches(host, {included = [], excluded = []}) {
  return (!included.length || included.some(domain => domainMatches(host, domain)))
    && !excluded.some(domain => domainMatches(host, domain));
}
export function safeSelector(selector) {
  return typeof selector === "string" && selector.length > 0 && selector.length <= 4096
    && !/[{};@\u0000-\u001f]/.test(selector) && !selector.includes("/*") && !selector.includes("*/")
    && !PROCEDURAL.some(token => selector.toLowerCase().includes(token));
}
function domains(text, separator) {
  const included = [], excluded = [];
  for (let value of text.split(separator)) {
    value = value.trim().toLowerCase();
    const negate = value.startsWith("~");
    if (negate) value = value.slice(1);
    if (!DOMAIN.test(value)) throw new Error("unsupported-domain");
    (negate ? excluded : included).push(value);
  }
  return {included: [...new Set(included)].sort(), excluded: [...new Set(excluded)].sort()};
}
function cosmetic(line) {
  const separator = line.includes("#@#") ? "#@#" : "##";
  const offset = line.indexOf(separator);
  const selector = line.slice(offset + separator.length).trim();
  if (!safeSelector(selector)) throw new Error("unsupported-cosmetic-selector");
  const domainText = line.slice(0, offset);
  return {selector, ...(domainText ? domains(domainText, ",") : {included: [], excluded: []}), exception: separator === "#@#"};
}
function splitNetwork(line) {
  const exception = line.startsWith("@@");
  const body = exception ? line.slice(2) : line;
  const offset = body.indexOf("$");
  const pattern = offset < 0 ? body : body.slice(0, offset);
  const options = offset < 0 ? [] : body.slice(offset + 1).toLowerCase().split(",").sort();
  if (options.some(option => !option)) throw new Error("invalid-option");
  return {pattern, options, exception};
}
function networkKey({pattern, options, exception}) {
  return `${exception}|${pattern}|${options.filter(option => option !== "badfilter").join(",")}`;
}
function convertNetwork(parsed) {
  const {pattern, options, exception} = parsed;
  if (!pattern || pattern.length > 2000 || /[^\x20-\x7e]/.test(pattern)) throw new Error("invalid-pattern");
  if (pattern.startsWith("/") && pattern.endsWith("/")) throw new Error("unsupported-regex");
  const condition = {urlFilter: pattern};
  const included = new Set(), excluded = new Set();
  let explicitTypes = false, important = false;
  for (let option of options) {
    if (option === "badfilter") continue;
    if (option === "important") { important = true; continue; }
    if (option === "match-case") { condition.isUrlFilterCaseSensitive = true; continue; }
    if (["third-party", "3p", "~first-party", "~1p", "first-party", "1p", "~third-party", "~3p"].includes(option)) {
      const type = ["third-party", "3p", "~first-party", "~1p"].includes(option) ? "thirdParty" : "firstParty";
      if (condition.domainType && condition.domainType !== type) throw new Error("conflicting-party-options");
      condition.domainType = type; continue;
    }
    if (option.startsWith("domain=")) {
      if (condition.initiatorDomains || condition.excludedInitiatorDomains) throw new Error("duplicate-domain-option");
      const scope = domains(option.slice(7), "|");
      if (scope.included.length) condition.initiatorDomains = scope.included;
      if (scope.excluded.length) condition.excludedInitiatorDomains = scope.excluded;
      continue;
    }
    const negate = option.startsWith("~");
    if (negate) option = option.slice(1);
    if (option === "all") {
      explicitTypes = true;
      (negate ? excluded : included).add("main_frame");
      for (const type of RESOURCE_TYPES) (negate ? excluded : included).add(type);
      continue;
    }
    const type = TYPE_MAP[option];
    if (!type) throw new Error(`unsupported-option:${negate ? "~" : ""}${option.split("=")[0]}`);
    explicitTypes = true; (negate ? excluded : included).add(type);
  }
  const types = included.size ? [...included] : [...RESOURCE_TYPES];
  condition.resourceTypes = types.filter(type => !excluded.has(type)).sort();
  if (!condition.resourceTypes.length) throw new Error("empty-resource-types");
  // An ABP document exception whitelists the frame and its subrequests.
  // Do not broaden other exception kinds into frame-level allowAllRequests.
  const documentException = exception && options.includes("document") && explicitTypes && condition.resourceTypes.every(type => ["main_frame", "sub_frame"].includes(type));
  return {priority: important ? (exception ? 40 : 30) : (exception ? 20 : 10), action: {type: documentException ? "allowAllRequests" : exception ? "allow" : "block"}, condition};
}

export function parseFilterList(text, source) {
  const network = [], cosmetics = [], cosmeticExceptions = [], rejects = {};
  let metadata = 0, duplicates = 0, badfilters = 0;
  const seen = new Set(), parsedNetworks = [];
  const reject = reason => { rejects[reason] = (rejects[reason] || 0) + 1; };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) { metadata++; continue; }
    try {
      if (["#@?#", "#@$#", "#@%#", "#?#", "#$#", "#%#"].some(separator => line.includes(separator))) throw new Error("unsupported-procedural-cosmetic");
      if (line.includes("##") || line.includes("#@#")) {
        const rule = cosmetic(line), key = JSON.stringify(rule);
        if (seen.has(key)) { duplicates++; continue; }
        seen.add(key);
        (rule.exception ? cosmeticExceptions : cosmetics).push({...rule, source});
      } else {
        const rule = splitNetwork(line), key = `${networkKey(rule)}|${rule.options.includes("badfilter")}`;
        if (seen.has(key)) { duplicates++; continue; }
        seen.add(key); parsedNetworks.push(rule);
      }
    } catch (error) { reject(error.message); }
  }
  const disabled = new Set(parsedNetworks.filter(rule => rule.options.includes("badfilter")).map(networkKey));
  for (const rule of parsedNetworks) {
    if (rule.options.includes("badfilter") || disabled.has(networkKey(rule))) { badfilters++; continue; }
    try { network.push({rule: convertNetwork(rule), source, abpKey: networkKey(rule)}); }
    catch (error) { reject(error.message); }
  }
  return {network, cosmetics, cosmeticExceptions, disabledKeys: [...disabled], statistics: {source, lines: lines.length, network: network.length, cosmetics: cosmetics.length, cosmeticExceptions: cosmeticExceptions.length, duplicates, badfilters, rejected: Object.values(rejects).reduce((a, b) => a + b, 0), reasons: rejects}};
}

function ruleScore(entry) {
  const condition = entry.rule.condition;
  // Prefer explicit site scope and third-party rules, then anchored host rules.
  return (condition.initiatorDomains ? 400 : 0) + (condition.domainType === "thirdParty" ? 200 : 0)
    + (condition.urlFilter.startsWith("||") ? 100 : 0) + (entry.rule.priority >= 30 ? 50 : 0)
    + (condition.resourceTypes.length < RESOURCE_TYPES.length ? 20 : 0);
}
export function selectNetworkRules(entries, capacity) {
  const unique = new Map();
  for (const entry of entries) {
    const key = JSON.stringify(entry.rule);
    // Assign shared rules to the same source regardless of download/input order.
    const existing = unique.get(key);
    if (!existing || (entry.source === "scrollFixes" && existing.source !== "scrollFixes") || (entry.source !== "scrollFixes" && existing.source !== "scrollFixes" && entry.source < existing.source)) unique.set(key, {...entry, key});
  }
  const all = [...unique.values()];
  const exceptions = all.filter(entry => entry.rule.action.type !== "block");
  if (exceptions.length > capacity) throw new Error("Supported exceptions exceed the browser rule budget. Previous protection was retained.");
  exceptions.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const groups = ["easyList", "easyPrivacy"].map(source => all.filter(entry => entry.source === source && entry.rule.action.type === "block"));
  for (const group of groups) group.sort((a, b) => ruleScore(b) - ruleScore(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const fixes = all.filter(entry => entry.source === "scrollFixes" && entry.rule.action.type === "block").sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  if (exceptions.length + fixes.length > capacity) throw new Error("Site fixes and supported exceptions exceed the browser rule budget. Previous protection was retained.");
  const selected = [...exceptions, ...fixes], positions = [0, 0];
  while (selected.length < capacity && groups.some((group, i) => positions[i] < group.length)) {
    for (let i = 0; i < groups.length && selected.length < capacity; i++) {
      if (positions[i] < groups[i].length) selected.push(groups[i][positions[i]++]);
    }
  }
  const perSource = {};
  for (const source of ["scrollFixes", "easyList", "easyPrivacy"]) {
    const supported = all.filter(entry => entry.source === source).length;
    const installed = selected.filter(entry => entry.source === source).length;
    perSource[source] = {supported, selected: installed, omitted: supported - installed};
  }
  return {rules: selected.map(entry => entry.rule), supported: all.length, selected: selected.length, omitted: all.length - selected.length, duplicates: entries.length - all.length, perSource};
}

export function selectorsForHost(host, rules, exceptions) {
  const exemptions = new Set(exceptions.filter(rule => scopeMatches(host, rule)).map(rule => rule.selector));
  return [...new Set(rules.filter(rule => scopeMatches(host, rule) && !exemptions.has(rule.selector)).map(rule => rule.selector))];
}
