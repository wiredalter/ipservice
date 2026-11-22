const axios = require("axios");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { LRUCache } = require("lru-cache");

const appUrl = process.env.APP_URL || "https://github.com/wiredalter/ipservice";
const adminEmail = process.env.ADMIN_EMAIL || "open-source-user@example.com";
const customUserAgent = `Threat-Intel-API/1.0 (${appUrl}; ${adminEmail})`;

const IANA_RDAP_URLS = {
  ipv4: "https://data.iana.org/rdap/ipv4.json",
  ipv6: "https://data.iana.org/rdap/ipv6.json",
};

const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for in-memory IANA fetch
const CIRCUIT_BREAKER_MS = 60 * 60 * 1000; // 1 hour per-host pause on 429

function getBootstrapPath(family) {
  if (family === "ipv6") {
    return (
      process.env.RDAP_IPV6_DB_PATH ||
      path.join(__dirname, "..", "db", "rdap-ipv6.json")
    );
  }
  return (
    process.env.RDAP_IPV4_DB_PATH ||
    path.join(__dirname, "..", "db", "rdap-ipv4.json")
  );
}

// Bounded LRU cache to keep memory low on small servers (~<1MB max)
const whoisCache = new LRUCache({
  max: 500,
  ttl: 6 * 60 * 60 * 1000, // 6 hours
});

// Per-host circuit breakers: host -> reset timestamp (ms)
const hostCircuitBreakers = new Map();

// Parsed IANA RDAP bootstrap tables
const bootstrapState = {
  ipv4: {
    entries: [],
    source: null, // "disk" | "remote"
    loadedAt: 0,
    watcher: null,
    inflight: null,
  },
  ipv6: {
    entries: [],
    source: null,
    loadedAt: 0,
    watcher: null,
    inflight: null,
  },
};

let bootstrapInitialized = false;

// --- IP PARSING & CIDR MATCHING (PURE JS, ZERO DEPS) ---

function ipv4ToBigInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let val = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    val = (val << 8n) | BigInt(num);
  }
  return val;
}

function ipv6ToBigInt(ip) {
  let addr = ip.toLowerCase();

  // Convert trailing embedded IPv4 (e.g. ::ffff:8.8.8.8) to two 16-bit hex groups
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes(".")) {
    const v4Part = addr.slice(lastColon + 1);
    const v4Val = ipv4ToBigInt(v4Part);
    if (v4Val === null) return null;
    const high = Number((v4Val >> 16n) & 0xffffn).toString(16);
    const low = Number(v4Val & 0xffffn).toString(16);
    addr = `${addr.slice(0, lastColon)}:${high}:${low}`;
  }

  const doubleColonParts = addr.split("::");
  if (doubleColonParts.length > 2) return null;

  let groups;
  if (doubleColonParts.length === 2) {
    const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
    const right = doubleColonParts[1] ? doubleColonParts[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = addr.split(":");
  }

  if (groups.length !== 8) return null;

  let val = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    val = (val << 16n) | BigInt(parseInt(g, 16));
  }
  return val;
}

function normalizeQueryIp(rawIp) {
  if (typeof rawIp !== "string") return null;
  let ip = rawIp.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1).trim();
  }
  const ipVersion = net.isIP(ip);
  if (!ipVersion) return null;

  // Unwrap IPv4-mapped IPv6 addresses (::ffff:a.b.c.d or ::ffff:xxxx:xxxx)
  if (ipVersion === 6) {
    const v6Val = ipv6ToBigInt(ip);
    if (v6Val !== null && v6Val >> 32n === 0xffffn) {
      const v4 = Number(v6Val & 0xffffffffn);
      return {
        ip: `${(v4 >>> 24) & 255}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`,
        version: 4,
      };
    }
  }

  return { ip, version: ipVersion };
}

function parseCidr(cidr, isV6) {
  if (typeof cidr !== "string" || !cidr.includes("/")) return null;
  const [addr, lenStr] = cidr.split("/");
  const bits = isV6 ? 128n : 32n;
  const prefixLen = Number(lenStr);
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > Number(bits)) {
    return null;
  }
  const ipVal = isV6 ? ipv6ToBigInt(addr) : ipv4ToBigInt(addr);
  if (ipVal === null) return null;

  const shift = bits - BigInt(prefixLen);
  const fullMask = (1n << bits) - 1n;
  const mask = prefixLen === 0 ? 0n : (fullMask << shift) & fullMask;
  return {
    network: ipVal & mask,
    mask,
    prefixLen,
  };
}

function normalizeRdapBaseUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://")) return null;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function parseBootstrapServices(json, isV6) {
  if (!json || !Array.isArray(json.services)) return [];
  const entries = [];

  for (const service of json.services) {
    if (!Array.isArray(service) || service.length < 2) continue;
    const [cidrs, rawUrls] = service;
    if (!Array.isArray(cidrs) || !Array.isArray(rawUrls)) continue;

    // HTTPS-only per deployment security preference
    const urls = [...new Set(rawUrls.map(normalizeRdapBaseUrl).filter(Boolean))];
    if (urls.length === 0) continue;

    for (const cidr of cidrs) {
      const parsed = parseCidr(cidr, isV6);
      if (parsed) {
        entries.push({ ...parsed, urls });
      }
    }
  }

  // Sort by longest prefix first for deterministic longest-prefix match
  entries.sort((a, b) => b.prefixLen - a.prefixLen);
  return entries;
}

function matchBootstrapUrls(ip, version, entries) {
  if (!entries || entries.length === 0) return [];
  const isV6 = version === 6;
  const ipVal = isV6 ? ipv6ToBigInt(ip) : ipv4ToBigInt(ip);
  if (ipVal === null) return [];

  for (const entry of entries) {
    if ((ipVal & entry.mask) === entry.network) {
      return entry.urls;
    }
  }
  return [];
}

// --- IANA BOOTSTRAP LOADING & HOT-RELOAD ---

function loadBootstrapFromDisk(family, filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    const entries = parseBootstrapServices(json, family === "ipv6");
    if (entries.length === 0) {
      console.warn(`⚠️ RDAP ${family.toUpperCase()} bootstrap at ${filePath} had no valid entries.`);
      return false;
    }
    bootstrapState[family].entries = entries;
    bootstrapState[family].source = "disk";
    bootstrapState[family].loadedAt = Date.now();
    return true;
  } catch (err) {
    console.warn(`⚠️ Failed to load RDAP ${family.toUpperCase()} bootstrap from ${filePath}:`, err.message);
    return false;
  }
}

function watchBootstrapFile(family, filePath) {
  const state = bootstrapState[family];
  if (state.watcher) {
    try {
      state.watcher.close();
    } catch (_) {}
    state.watcher = null;
  }

  if (!fs.existsSync(filePath)) return;

  let debounceTimer;
  try {
    state.watcher = fs.watch(filePath, (event) => {
      if (event === "rename" || event === "change") {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log(`♻️ Update detected for RDAP-${family.toUpperCase()} bootstrap. Reloading...`);
          if (loadBootstrapFromDisk(family, filePath)) {
            console.log(`✅ RDAP-${family.toUpperCase()} bootstrap Hot-Reload Complete.`);
          }
          // Re-attach watcher after atomic rename (new inode)
          if (event === "rename") {
            watchBootstrapFile(family, filePath);
          }
        }, 2000);
      }
    });
  } catch (err) {
    console.warn(`⚠️ Could not watch ${filePath}:`, err.message);
  }
}

function initWhoisBootstrap() {
  if (bootstrapInitialized) return;
  bootstrapInitialized = true;

  for (const family of ["ipv4", "ipv6"]) {
    const filePath = getBootstrapPath(family);
    if (loadBootstrapFromDisk(family, filePath)) {
      console.log(`✅ RDAP ${family.toUpperCase()} bootstrap loaded (${bootstrapState[family].entries.length} prefixes)`);
      watchBootstrapFile(family, filePath);
    }
  }
}

async function ensureBootstrapEntries(family) {
  const state = bootstrapState[family];
  const filePath = getBootstrapPath(family);

  // If loaded from disk (hot-reloaded via fs.watch), always use it
  if (state.source === "disk" && state.entries.length > 0) {
    return state.entries;
  }

  // Check if the file appeared on disk after startup (e.g. cron script ran)
  if (fs.existsSync(filePath) && loadBootstrapFromDisk(family, filePath)) {
    watchBootstrapFile(family, filePath);
    return state.entries;
  }

  // Reuse in-memory remote copy if still fresh
  if (
    state.source === "remote" &&
    state.entries.length > 0 &&
    Date.now() - state.loadedAt < BOOTSTRAP_TTL_MS
  ) {
    return state.entries;
  }

  // Deduplicate concurrent fetches to IANA
  if (state.inflight) {
    return state.inflight;
  }

  state.inflight = (async () => {
    try {
      const res = await axios.get(IANA_RDAP_URLS[family], {
        timeout: 8000,
        headers: {
          Accept: "application/json",
          "User-Agent": customUserAgent,
        },
      });
      const entries = parseBootstrapServices(res.data, family === "ipv6");
      if (entries.length > 0) {
        state.entries = entries;
        state.source = "remote";
        state.loadedAt = Date.now();
        console.log(`✅ RDAP ${family.toUpperCase()} bootstrap fetched from IANA (${entries.length} prefixes)`);
      }
      return state.entries;
    } catch (err) {
      console.warn(`⚠️ Failed to fetch IANA RDAP ${family.toUpperCase()} bootstrap: ${err.message}`);
      return state.entries; // Return stale cache if any, else []
    } finally {
      state.inflight = null;
    }
  })();

  return state.inflight;
}

// --- CIRCUIT BREAKER HELPERS ---

function getUrlHost(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch (_) {
    return url;
  }
}

function isHostBlocked(host) {
  const resetTime = hostCircuitBreakers.get(host);
  if (!resetTime) return false;
  if (Date.now() > resetTime) {
    hostCircuitBreakers.delete(host);
    console.log(`🟢 Circuit Breaker Reset for ${host} - Trying again.`);
    return false;
  }
  return true;
}

function tripHostBreaker(host) {
  console.warn(`⚠️ Rate limit (429) on ${host}. Pausing queries to this host for 1 hour.`);
  hostCircuitBreakers.set(host, Date.now() + CIRCUIT_BREAKER_MS);
}

// --- RDAP RESPONSE PARSING ---

function formatIsoDate(dateStr) {
  if (!dateStr) return "N/A";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "N/A";
  return d.toISOString().split("T")[0];
}

function parseVcard(vcardArray) {
  const parsed = { fn: null, org: null, emails: [] };
  if (!Array.isArray(vcardArray) || !Array.isArray(vcardArray[1])) {
    return parsed;
  }

  for (const prop of vcardArray[1]) {
    if (!Array.isArray(prop) || prop.length < 4) continue;
    const key = typeof prop[0] === "string" ? prop[0].toLowerCase() : "";
    const value = prop[3];

    if (key === "fn" && typeof value === "string" && value.trim()) {
      parsed.fn = value.trim();
    } else if (key === "org") {
      if (typeof value === "string" && value.trim()) {
        parsed.org = value.trim();
      } else if (Array.isArray(value)) {
        const joined = value
          .filter((v) => typeof v === "string" && v.trim())
          .join(" ")
          .trim();
        if (joined) parsed.org = joined;
      }
    } else if (key === "email" && typeof value === "string" && value.trim()) {
      parsed.emails.push(value.trim());
    }
  }

  return parsed;
}

function extractEmailsFromRemarks(remarks, requireAbuseContext = false) {
  if (!Array.isArray(remarks)) return [];
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const found = [];

  for (const remark of remarks) {
    const title = typeof remark?.title === "string" ? remark.title : "";
    const desc = Array.isArray(remark?.description)
      ? remark.description.filter((d) => typeof d === "string").join(" ")
      : "";
    const combined = `${title} ${desc}`;
    if (!requireAbuseContext || /abuse/i.test(combined)) {
      const matches = combined.match(emailRegex);
      if (matches) found.push(...matches);
    }
  }

  return found;
}

function extractNetworkRange(data) {
  if (data.startAddress && data.endAddress) {
    return `${data.startAddress} - ${data.endAddress}`;
  }
  if (Array.isArray(data.cidr0_cidrs) && data.cidr0_cidrs.length > 0) {
    const cidrs = data.cidr0_cidrs
      .map((c) => {
        const prefix = c?.v6prefix || c?.v4prefix;
        return prefix && c.length !== undefined ? `${prefix}/${c.length}` : null;
      })
      .filter(Boolean);
    if (cidrs.length > 0) return cidrs.join(", ");
  }
  return "N/A";
}

function parseRdapResponse(data, ip) {
  if (!data || typeof data !== "object") return null;

  const result = {
    ip,
    network_name: data.name || data.handle || "N/A",
    handle: data.handle || "N/A",
    country: data.country || "N/A",
    type: data.type || "N/A",
    network_range: extractNetworkRange(data),
    organization: "N/A",
    abuse_contacts: [],
    registration_date: "N/A",
    updated_date: "N/A",
    is_raw: false,
  };

  // Extract registration & last-changed dates
  if (Array.isArray(data.events)) {
    const regEvent = data.events.find((e) => e?.eventAction === "registration");
    const updEvent =
      data.events.find((e) => e?.eventAction === "last changed") ||
      data.events.find((e) => e?.eventAction === "last update of RDAP database");
    if (regEvent) result.registration_date = formatIsoDate(regEvent.eventDate);
    if (updEvent) result.updated_date = formatIsoDate(updEvent.eventDate);
  }

  // Recursively collect organization name (with role priority) and abuse emails
  const orgCandidates = {
    registrant: null,
    administrative: null,
    technical: null,
    abuse: null,
    other: null,
  };

  const visited = new Set();

  function walkEntities(entities, underAbuse = false) {
    if (!Array.isArray(entities)) return;

    for (const entity of entities) {
      if (!entity || typeof entity !== "object" || visited.has(entity)) continue;
      visited.add(entity);

      const roles = Array.isArray(entity.roles)
        ? entity.roles.map((r) => String(r).toLowerCase())
        : [];
      const isAbuse = underAbuse || roles.includes("abuse");
      const vcard = parseVcard(entity.vcardArray);
      const displayName = vcard.fn || vcard.org;

      if (displayName) {
        if (roles.includes("registrant") && !orgCandidates.registrant) {
          orgCandidates.registrant = displayName;
        } else if (roles.includes("administrative") && !orgCandidates.administrative) {
          orgCandidates.administrative = displayName;
        } else if (roles.includes("technical") && !orgCandidates.technical) {
          orgCandidates.technical = displayName;
        } else if (roles.includes("abuse") && !orgCandidates.abuse) {
          orgCandidates.abuse = displayName;
        } else if (!orgCandidates.other) {
          orgCandidates.other = displayName;
        }
      }

      if (isAbuse) {
        if (vcard.emails.length > 0) {
          result.abuse_contacts.push(...vcard.emails);
        }
        const remarkEmails = extractEmailsFromRemarks(entity.remarks, false);
        if (remarkEmails.length > 0) {
          result.abuse_contacts.push(...remarkEmails);
        }
      }

      if (Array.isArray(entity.entities)) {
        walkEntities(entity.entities, isAbuse);
      }
    }
  }

  walkEntities(data.entities, false);

  result.organization =
    orgCandidates.registrant ||
    orgCandidates.administrative ||
    orgCandidates.technical ||
    orgCandidates.abuse ||
    orgCandidates.other ||
    "N/A";

  // Fallback: extract abuse contact emails from top-level remarks if none found in vCards
  if (result.abuse_contacts.length === 0) {
    result.abuse_contacts.push(...extractEmailsFromRemarks(data.remarks, true));
  }

  result.abuse_contacts = [...new Set(result.abuse_contacts)];

  return result;
}

function isBrokenRdapResult(result) {
  if (!result) return true;
  const upperName = (result.network_name || "").toUpperCase();
  const isIanaPlaceholder =
    upperName === "IANA-BLOCK" ||
    upperName === "IANA" ||
    upperName.startsWith("IANA-");
  const isUnspecified =
    result.network_range.includes("0.0.0.0") ||
    result.network_range.startsWith("::/0") ||
    /^::\s*-\s*ffff:/i.test(result.network_range);
  const isEmpty =
    result.network_name === "N/A" &&
    result.handle === "N/A" &&
    result.organization === "N/A";

  return isIanaPlaceholder || isUnspecified || isEmpty;
}

// --- MAIN LOOKUP FUNCTION ---

async function queryRdapUrl(url, displayIp) {
  const host = getUrlHost(url);
  if (isHostBlocked(host)) {
    return { status: "rate_limited" };
  }

  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        Accept: "application/rdap+json, application/json",
        "User-Agent": customUserAgent,
      },
    });
    const parsed = parseRdapResponse(res.data, displayIp);
    if (!isBrokenRdapResult(parsed)) {
      return { status: "ok", data: parsed };
    }
    console.warn(`RDAP (${host}) returned unusable data for ${displayIp}, trying next source...`);
    return { status: "broken" };
  } catch (err) {
    if (err.response && err.response.status === 429) {
      tripHostBreaker(host);
      return { status: "rate_limited" };
    }
    console.warn(
      `RDAP (${host}) failed for ${displayIp} (${err.response?.status || err.code || err.message}), trying next source...`,
    );
    return { status: "error" };
  }
}

async function queryRipeStatFallback(queryIp, displayIp) {
  const ripeHost = "stat.ripe.net";
  if (isHostBlocked(ripeHost)) {
    return {
      error: "WHOIS services temporarily unavailable due to rate limits.",
    };
  }

  try {
    const statRes = await axios.get("https://stat.ripe.net/data/whois/data.json", {
      params: { resource: queryIp },
      timeout: 10000,
      headers: {
        Accept: "application/json",
        "User-Agent": customUserAgent,
      },
    });

    const statData = statRes.data?.data;
    let rawText = "";

    const appendRecordGroups = (groups) => {
      if (!Array.isArray(groups)) return;
      for (const record of groups) {
        if (!Array.isArray(record)) continue;
        for (const entry of record) {
          if (entry && entry.key !== undefined && entry.value !== undefined) {
            rawText += `${entry.key}: ${entry.value}\n`;
          }
        }
        rawText += "\n";
      }
    };

    appendRecordGroups(statData?.records);
    if (!rawText.trim()) {
      appendRecordGroups(statData?.irr_records);
    }

    const hasRecords = Boolean(rawText.trim());
    return {
      ip: displayIp,
      is_raw: true,
      raw_whois: hasRecords ? rawText.trim() : "No WHOIS records found for this IP.",
      _cacheable: hasRecords,
    };
  } catch (fallbackErr) {
    if (fallbackErr.response && fallbackErr.response.status === 429) {
      tripHostBreaker(ripeHost);
      return {
        error: "WHOIS services temporarily unavailable due to rate limits.",
      };
    }
    console.error("WHOIS Fallback Error:", fallbackErr.message);
    return { error: "Registry lookup failed entirely." };
  }
}

async function getWhois(rawIp) {
  const normalized = normalizeQueryIp(rawIp);
  if (!normalized) return { error: "Invalid IP" };

  const { ip: queryIp, version } = normalized;
  const displayIp = rawIp.trim();
  const cacheKey = queryIp.toLowerCase();

  // 1. Check LRU cache
  const cached = whoisCache.get(cacheKey);
  if (cached) {
    return { ...cached, ip: displayIp };
  }

  if (!bootstrapInitialized) {
    initWhoisBootstrap();
  }

  // 2. Build ordered HTTPS RDAP candidate URLs (unencoded literal IPv6 colons per RFC 9082)
  const family = version === 6 ? "ipv6" : "ipv4";
  const entries = await ensureBootstrapEntries(family);
  const bootstrapBaseUrls = matchBootstrapUrls(queryIp, version, entries);

  const rdapCandidates = [];
  for (const baseUrl of bootstrapBaseUrls) {
    rdapCandidates.push(`${baseUrl}ip/${queryIp}`);
  }
  const rdapOrgUrl = `https://rdap.org/ip/${queryIp}`;
  if (!rdapCandidates.includes(rdapOrgUrl)) {
    rdapCandidates.push(rdapOrgUrl);
  }

  // 3. Try direct authoritative RIR RDAP first, then rdap.org fallback
  let sawRateLimit = false;
  for (const url of rdapCandidates) {
    const attempt = await queryRdapUrl(url, displayIp);
    if (attempt.status === "ok") {
      whoisCache.set(cacheKey, attempt.data);
      return attempt.data;
    }
    if (attempt.status === "rate_limited") {
      sawRateLimit = true;
    }
  }

  // 4. Final HTTPS fallback: RIPEstat raw WHOIS
  const fallbackResult = await queryRipeStatFallback(queryIp, displayIp);
  if (fallbackResult.error) {
    if (sawRateLimit && fallbackResult.error === "Registry lookup failed entirely.") {
      return {
        error: "WHOIS services temporarily unavailable due to rate limits.",
      };
    }
    return fallbackResult;
  }

  const { _cacheable, ...cleanFallback } = fallbackResult;
  if (_cacheable) {
    whoisCache.set(cacheKey, cleanFallback);
  }
  return cleanFallback;
}

getWhois.initWhoisBootstrap = initWhoisBootstrap;
getWhois._internals = {
  ipv4ToBigInt,
  ipv6ToBigInt,
  normalizeQueryIp,
  parseCidr,
  parseBootstrapServices,
  matchBootstrapUrls,
  parseVcard,
  extractEmailsFromRemarks,
  extractNetworkRange,
  parseRdapResponse,
  isBrokenRdapResult,
  whoisCache,
  hostCircuitBreakers,
  bootstrapState,
  resetForTests: () => {
    whoisCache.clear();
    hostCircuitBreakers.clear();
    for (const family of ["ipv4", "ipv6"]) {
      if (bootstrapState[family].watcher) {
        try {
          bootstrapState[family].watcher.close();
        } catch (_) {}
      }
      bootstrapState[family].entries = [];
      bootstrapState[family].source = null;
      bootstrapState[family].loadedAt = 0;
      bootstrapState[family].watcher = null;
      bootstrapState[family].inflight = null;
    }
    bootstrapInitialized = false;
  },
};

module.exports = getWhois;
