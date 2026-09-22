import {parseFilterList} from "./maintenance-filters.js";

export const SITE_FIX_LIMITS = Object.freeze({bytes: 256 * 1024, network: 200, cosmetics: 200});
export function validateSiteFixes(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > SITE_FIX_LIMITS.bytes) throw new Error("Site fixes exceed the 256 KB limit.");
  if (!/^\[Adblock Plus 2\.0\]\r?\n/.test(text)) throw new Error("Site fixes must start with [Adblock Plus 2.0].");
  const version = text.match(/^! Version: ([0-9]{8}\.[0-9]+)\s*$/m)?.[1];
  if (!version) throw new Error("Site fixes need a ! Version: YYYYMMDD.number line.");
  let network = 0, cosmetics = 0;
  const rules = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || index === 0) continue;
    const fail = reason => { throw new Error(`Line ${index + 1}: ${reason}`); };
    const parsed = parseFilterList(line, "scrollFixes");
    if (parsed.statistics.rejected || parsed.statistics.badfilters || parsed.statistics.metadata) fail("unsupported rule. Use site-scoped hostname blocks or standard CSS hiding/exceptions.");
    if (parsed.network.length) {
      const rule = parsed.network[0].rule;
      if (!/^(?:@@)?\|\|[a-z0-9.-]+\^(?:\$|$)/i.test(line)) fail("network patterns must use ||advertising-host.example^ with $domain=affected-site.example.");
      if (!rule.condition.initiatorDomains?.length || rule.condition.initiatorDomains.some(domain => !domain.includes("."))) fail("network rules need an explicit $domain=affected-site.example scope.");
      if (rule.condition.resourceTypes.includes("main_frame")) fail("site fixes cannot block or whitelist entire pages; omit document/all options.");
      network++;
      rules.push({line: index + 1, text: line, kind: rule.action.type, sites: rule.condition.initiatorDomains});
    } else {
      const rule = [...parsed.cosmetics, ...parsed.cosmeticExceptions][0];
      if (!rule || !rule.included.length || rule.included.some(domain => !domain.includes("."))) fail("cleanup rules need an explicit site before ## or #@#.");
      cosmetics++;
      rules.push({line: index + 1, text: line, kind: rule.exception ? "cleanup exception" : "cleanup", sites: rule.included, selector: rule.selector});
    }
  }
  if (network > SITE_FIX_LIMITS.network || cosmetics > SITE_FIX_LIMITS.cosmetics) throw new Error("Site fixes are limited to 200 network rules and 200 cleanup rules. Keep the list small and reviewed.");
  return {version, network, cosmetics, rules};
}
