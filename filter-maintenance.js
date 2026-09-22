import {validateSiteFixes} from "./maintenance-validation.js";
import {parseFilterList, selectorsForHost} from "./maintenance-filters.js";
import {websiteZIP} from "./maintenance-zip.js";
const $ = id => document.getElementById(id);
async function websiteFiles() {
  const manifest = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(await getFile("maintenance-manifest.json")));
  const names = manifest.files;
  if (!Array.isArray(names) || names.length > 32 || new Set(names).size !== names.length || !names.includes("maintenance-manifest.json") || !names.includes("filters/scroll-fixes.txt") || names.some(name => typeof name !== "string" || !/^(?:index\.html|support\.html|privacy\.html|filter-maintenance\.(?:html|js)|maintenance-(?:filters|validation|zip)\.js|maintenance-manifest\.json|filters\/scroll-fixes\.txt|downloads\/scroll-in-peace-[a-z0-9.-]+\.(?:zip|xpi))$/.test(name))) throw new Error("Unexpected website file manifest. No ZIP was created.");
  return names;
}
let busy = false;
function status(message, error = false) { $("status").textContent = message; $("status").classList.toggle("error", error); }
function controls(disabled) { busy = disabled; $("list").disabled = disabled; for (const id of ["reload", "validate", "preview", "download"]) $(id).disabled = disabled; }
async function getFile(name) {
  const url = new URL(name, location.href);
  const response = await fetch(url, {credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000)});
  if (!response.ok || response.url !== url.href) throw new Error(`Cannot read ${name}: HTTP ${response.status}. No ZIP was created.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 20 * 1024 * 1024) throw new Error(`Unexpectedly large website file: ${name}.`);
  return bytes;
}
function check(text) {
  const result = validateSiteFixes(text);
  for (const rule of result.rules) {
    if (rule.selector && !CSS.supports(`selector(${rule.selector})`)) throw new Error(`Line ${rule.line}: this browser cannot parse the CSS selector.`);
    if (rule.selector && rule.selector.split(",").some(selector => /^(?:\*|html|body|main|article)$/i.test(selector.trim()))) throw new Error(`Line ${rule.line}: selector would hide essential page content. Choose the ad container.`);
  }
  $("validation").textContent = `Version ${result.version}\n${result.network} network rules · ${result.cosmetics} cleanup rules\n\n${result.rules.map(rule => `Line ${rule.line}: ${rule.kind} on ${rule.sites.join(", ")}`).join("\n") || "Empty list is valid. No site fixes will be applied."}`;
  return result;
}
async function load() {
  controls(true);
  try { $("list").value = new TextDecoder("utf-8", {fatal: true}).decode(await getFile("filters/scroll-fixes.txt")); check($("list").value); status("Published list loaded. Edits are local until you upload a website ZIP to Netlify."); }
  catch (error) { status(error.message, true); }
  finally { controls(false); }
}
$("reload").addEventListener("click", () => { if ($("list").value && !confirm("Reloading discards unsaved edits in this tab. Continue?")) return; load(); });
$("validate").addEventListener("click", () => { try { check($("list").value); status("Syntax validated. Test the real site before publishing."); } catch (error) { $("validation").textContent = error.message; status(error.message, true); } });
$("preview").addEventListener("click", () => {
  try {
    check($("list").value); const url = new URL($("site").value);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Enter an http or https site address.");
    if ($("markup").value.length > 500000) throw new Error("Paste a smaller HTML snippet (under 500 KB).");
    const template = document.createElement("template"); template.innerHTML = $("markup").value;
    const parsed = parseFilterList($("list").value, "scrollFixes");
    const selectors = selectorsForHost(url.hostname, parsed.cosmetics, parsed.cosmeticExceptions);
    $("matches").textContent = selectors.map(selector => `${selector}: ${template.content.querySelectorAll(selector).length} matching elements`).join("\n") || "No active cleanup rules apply to this website. Network rules need a real browser test.";
    status("Selector matches checked locally. No markup was executed or sent.");
  } catch (error) { $("matches").textContent = error.message; status(error.message, true); }
});
$("download").addEventListener("click", async () => {
  if (busy) return;
  controls(true);
  try {
    check($("list").value);
    const now = new Date(), day = `${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,"0")}${String(now.getUTCDate()).padStart(2,"0")}`;
    const text = $("list").value.replace(/^! Version: .+$/m, `! Version: ${day}.${Date.now()}`);
    check(text); status("Reading current website files. Nothing has been published yet…");
    const files = await websiteFiles();
    const entries = await Promise.all(files.map(async name => ({name, bytes: name === "filters/scroll-fixes.txt" ? new TextEncoder().encode(text) : await getFile(name)})));
    const blob = websiteZIP(entries), download = document.createElement("a"), objectURL = URL.createObjectURL(blob);
    download.href = objectURL; download.download = `Scroll-Site-Fixes-${day}.zip`; download.click(); setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
    $("list").value = text;
    status("Website ZIP downloaded. Upload it to the existing Netlify project to publish this version; this page has not changed the live website.");
  } catch (error) { status(error.message, true); }
  finally { controls(false); }
});
load();
