const maxmind = require("maxmind");
const { IP2Location } = require("ip2location-nodejs");
const { IP2Proxy } = require("ip2proxy-nodejs");
const path = require("path");
const fs = require("fs");
const { vpnHostingProviders, vpnASNs } = require("./providers.js");

// --- DATABASE PATHS ---
function getDbPath(envVar, defaultFilename, fallbackCandidate) {
  if (envVar) return envVar;
  const basePath = path.join(__dirname, "..", "db");
  const defaultPath = path.join(basePath, defaultFilename);
  if (fs.existsSync(defaultPath)) return defaultPath;
  if (fallbackCandidate) {
    const candidatePath = path.join(basePath, fallbackCandidate);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }
  return defaultPath;
}

const cityDbPath =
  process.env.CITY_DB_PATH ||
  path.join(__dirname, "..", "db", "GeoLite2-City.mmdb");
const asnDbPath =
  process.env.ASN_DB_PATH ||
  path.join(__dirname, "..", "db", "GeoLite2-ASN.mmdb");
const proxyDbPath = getDbPath(
  process.env.PROXY_DB_PATH,
  "IP2PROXY-LITE-PX11.BIN",
  "IP2PROXY-LITE-PX11.IPV6.BIN",
);
const db11Path = getDbPath(
  process.env.DB11_PATH,
  "IP2LOCATION-LITE-DB11.IPV6.BIN",
  "IP2LOCATION-LITE-DB11.BIN",
);
const ipinfoAsnDbPath =
  process.env.IPINFO_ASN_DB_PATH ||
  path.join(__dirname, "..", "db", "ipinfo-asn.mmdb");

function cleanValue(val) {
  if (!val || typeof val !== "string") return null;
  const trimmed = val.trim();
  if (
    !trimmed ||
    trimmed === "-" ||
    trimmed === "?" ||
    trimmed === "N/A" ||
    trimmed === "RP" ||
    trimmed === "Unknown"
  ) {
    return null;
  }
  const upper = trimmed.toUpperCase();
  if (
    upper.includes("INVALID IP") ||
    upper.includes("MISSING") ||
    upper.includes("NOT SUPPORTED") ||
    upper.includes("IPV6 ADDRESS MISSING") ||
    upper.includes("UNAVAILABLE") ||
    upper.includes("INCORRECT IP2PROXY")
  ) {
    return null;
  }
  return trimmed;
}

let cityLookup, asnLookup, proxyLookup, db11Lookup, ipinfoAsnLookup;

function watchDatabase(filePath, reloadCallback, dbName) {
  if (!fs.existsSync(filePath)) return;

  let debounceTimer;
  fs.watch(filePath, (event) => {
    if (event === "rename" || event === "change") {
      clearTimeout(debounceTimer);

      debounceTimer = setTimeout(async () => {
        console.log(
          `♻️ Update detected for ${dbName}. Reloading into memory...`,
        );
        try {
          await reloadCallback();
          console.log(`✅ ${dbName} Hot-Reload Complete.`);
        } catch (err) {
          console.error(
            `❌ FAILED to hot-reload ${dbName}. Keeping previous version in memory. Error:`,
            err.message,
          );
        }
      }, 2000);
    }
  });
}

async function initGeoDb() {
  try {
    if (fs.existsSync(cityDbPath)) {
      const loadCity = async () => {
        cityLookup = await maxmind.open(cityDbPath);
      };
      await loadCity();
      console.log(`✅ City DB loaded`);
      watchDatabase(cityDbPath, loadCity, "GeoLite2-City");
    } else {
      console.warn(`⚠️ City DB missing at ${cityDbPath}`);
    }
  } catch (e) {
    console.warn(`⚠️ City DB error:`, e.message);
  }

  try {
    if (fs.existsSync(asnDbPath)) {
      const loadAsn = async () => {
        asnLookup = await maxmind.open(asnDbPath);
      };
      await loadAsn();
      console.log(`✅ ASN DB loaded`);
      watchDatabase(asnDbPath, loadAsn, "GeoLite2-ASN");
    } else {
      console.warn(`⚠️ ASN DB missing at ${asnDbPath}`);
    }
  } catch (e) {
    console.warn(`⚠️ ASN DB error:`, e.message);
  }

  try {
    if (fs.existsSync(ipinfoAsnDbPath)) {
      const loadIpInfo = async () => {
        ipinfoAsnLookup = await maxmind.open(ipinfoAsnDbPath);
      };
      await loadIpInfo();
      console.log(`✅ IPinfo ASN DB loaded`);
      watchDatabase(ipinfoAsnDbPath, loadIpInfo, "IPinfo-ASN");
    } else {
      console.warn(`⚠️ IPinfo ASN DB missing at ${ipinfoAsnDbPath}`);
    }
  } catch (e) {
    console.warn(`⚠️ IPinfo ASN DB error:`, e.message);
  }

  try {
    if (fs.existsSync(db11Path)) {
      const loadDb11 = () => {
        const newDb11 = new IP2Location();
        newDb11.open(db11Path);
        db11Lookup = newDb11;
      };
      loadDb11();
      console.log(`✅ DB11 (Fallback) loaded`);
      watchDatabase(db11Path, loadDb11, "IP2Location-DB11");
    } else {
      console.warn(`⚠️ DB11 DB missing at ${db11Path}`);
    }
  } catch (e) {
    console.warn(`⚠️ DB11 error:`, e.message);
  }

  try {
    if (fs.existsSync(proxyDbPath)) {
      const loadProxy = () => {
        const newProxy = new IP2Proxy();
        if (newProxy.open(proxyDbPath) === 0) {
          proxyLookup = newProxy;
        }
      };
      loadProxy();
      if (proxyLookup) {
        console.log(`✅ Proxy DB loaded`);
        watchDatabase(proxyDbPath, loadProxy, "IP2Proxy");
      } else {
        console.warn(`⚠️ Proxy DB failed to open at ${proxyDbPath}`);
      }
    } else {
      console.warn(`⚠️ Proxy DB missing at ${proxyDbPath}`);
    }
  } catch (e) {
    console.warn(`⚠️ Proxy DB error:`, e.message);
  }
}

function getGeoData(ip) {
  if (typeof ip !== "string") {
    return {
      ip: String(ip || ""),
      country: "Unknown",
      country_code: "XX",
      city: "Unknown",
      region: "Unknown",
      timezone: "Unknown",
      coordinates: "0, 0",
      latitude: 0,
      longitude: 0,
      zip: "N/A",
      asn: "Unknown",
      org: "Unknown",
      network: "N/A",
      is_proxy: false,
      proxy_type: "No",
      usage_type: "Standard ISP",
      threat: "None",
      provider: "N/A",
    };
  }

  // 1. Reserved / Local / Docker IP Checks
  const isLocal =
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    ip.startsWith("169.254.") ||
    ip.startsWith("fc00:") ||
    ip.startsWith("fd00:");
  let isDocker = false;
  if (ip.startsWith("172.")) {
    const secondOctet = parseInt(ip.split(".")[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) isDocker = true;
  }
  if (isLocal || isDocker) {
    return {
      ip,
      country: "Reserved",
      country_code: "XX",
      city: "Local Network",
      region: "Local Network",
      timezone: "Local",
      coordinates: "0, 0",
      latitude: 0,
      longitude: 0,
      zip: "N/A",
      asn: "N/A",
      org: "Localhost",
      network: "N/A",
      is_proxy: false,
      proxy_type: "Local",
      usage_type: "RES",
      threat: "None",
      provider: "N/A",
    };
  }

  try {
    // --- DATA LOOKUPS ---
    let cityData = null;
    if (cityLookup) {
      try {
        cityData = cityLookup.get(ip);
      } catch (e) {
        cityData = null;
      }
    }

    let asnData = null;
    let asnPrefix = null;
    if (asnLookup) {
      try {
        if (typeof asnLookup.getWithPrefixLength === 'function') {
          const result = asnLookup.getWithPrefixLength(ip);
          if (result) {
            asnData = result[0];
            asnPrefix = result[1];
          }
        } else {
          asnData = asnLookup.get(ip);
        }
      } catch (e) {
        asnData = null;
      }
    }

    let proxyData = {};
    if (proxyLookup) {
      try {
        proxyData = proxyLookup.getAll(ip) || {};
      } catch (e) {
        proxyData = {};
      }
    }

    let ipinfoData = null;
    if (ipinfoAsnLookup) {
      try {
        ipinfoData = ipinfoAsnLookup.get(ip);
      } catch (e) {
        ipinfoData = null;
      }
    }

    // DB11 Fallback
    let db11Data = {};
    if (db11Lookup) {
      try {
        db11Data = db11Lookup.getAll(ip) || {};
      } catch (e) {
        db11Data = {};
      }
    }

    const orgName =
      cleanValue(asnData?.autonomous_system_organization) ||
      cleanValue(ipinfoData?.name) ||
      cleanValue(db11Data.isp) ||
      cleanValue(proxyData.isp) ||
      "Unknown ISP";

    let asnNumber = "Unknown";
    if (asnData && asnData.autonomous_system_number) {
      asnNumber = `AS${asnData.autonomous_system_number}`;
    } else if (cleanValue(ipinfoData?.asn)) {
      asnNumber = cleanValue(ipinfoData.asn);
    } else if (cleanValue(db11Data.asn)) {
      asnNumber = cleanValue(db11Data.asn);
    }

    let networkCidr = "N/A";
    if (cityData?.traits?.network) networkCidr = cityData.traits.network;
    else if (asnData?.network) networkCidr = asnData.network;
    else if (cleanValue(ipinfoData?.route)) networkCidr = cleanValue(ipinfoData.route);
    else if (cleanValue(ipinfoData?.network)) networkCidr = cleanValue(ipinfoData.network);
    else if (asnPrefix !== null && asnPrefix !== undefined) {
      if (ip.includes(":")) {
        networkCidr = `${ip}/${asnPrefix}`; // IPv6 approx
      } else {
        // basic IPv4 cidr masking
        const parts = ip.split('.').map(Number);
        const shift = 32 - asnPrefix;
        if (shift >= 32) {
          networkCidr = `0.0.0.0/${asnPrefix}`;
        } else {
          const ipInt = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
          const mask = (~0 << shift) >>> 0;
          const baseInt = (ipInt & mask) >>> 0;
          const baseIp = [ (baseInt >>> 24) & 255, (baseInt >>> 16) & 255, (baseInt >>> 8) & 255, baseInt & 255 ].join('.');
          networkCidr = `${baseIp}/${asnPrefix}`;
        }
      }
    }

    // Helper: Prioritize Primary -> Secondary -> Fallback
    const pick = (primary, secondary, fallback = "Unknown") => {
      return cleanValue(primary) || cleanValue(secondary) || fallback;
    };

    // --- SANITIZE IP2PROXY DATA ---
    const rawProxyType = cleanValue(proxyData.proxyType);
    const rawUsage = cleanValue(proxyData.usageType);
    const rawThreat = cleanValue(proxyData.threat);
    const rawProvider = cleanValue(proxyData.provider);
    const rawIsProxy = proxyData.isProxy === 1 || proxyData.isProxy === 2;

    // --- USAGE TYPE DETECTION ---
    const usageMap = {
      ISP: "Residential",
      MOB: "Mobile Data",
      COM: "Commercial",
      ORG: "Organization",
      EDU: "University",
      GOV: "Government",
      DCH: "Datacenter",
      CDN: "CDN",
      SES: "Search Engine Spider",
    };

    let usageType = null;
    if (rawUsage && usageMap[rawUsage]) {
      usageType = usageMap[rawUsage];
    } else if (rawUsage && rawUsage !== "Standard" && rawUsage !== "Standard ISP") {
      usageType = rawUsage;
    }

    // Fallback: Check IPinfo ASN classification if usageType is still unknown
    if (!usageType && ipinfoData && ipinfoData.type) {
      const ipinfoTypeMap = {
        isp: "Residential",
        hosting: "Datacenter",
        business: "Commercial",
        education: "University",
      };
      if (ipinfoTypeMap[ipinfoData.type]) {
        usageType = ipinfoTypeMap[ipinfoData.type];
      }
    }

    // Default if still unknown
    if (!usageType) {
      usageType = "Standard ISP";
    }

    // If it's a "Standard ISP" (unknown) but matches a Cloud Provider, rename it.
    if (usageType === "Standard ISP") {
      if (
        vpnHostingProviders.low.some((p) =>
          orgName.toLowerCase().includes(p.toLowerCase()),
        )
      ) {
        usageType = "Cloud Infrastructure";
      }
    }

    // --- PROXY DETECTION LOGIC ---
    let isProxy = false;
    let riskLabel = "No";

    // A) Check Database First (IP2Proxy LITE)
    if (rawIsProxy && rawProxyType) {
      const typeMap = {
        VPN: "VPN Service",
        DCH: "Datacenter",
        TOR: "Tor Node",
        PUB: "Public Proxy",
        WEB: "Web Proxy",
        SES: "Search Engine Spider",
        RES: "Residential Proxy",
        CPX: "Consumer Privacy Network",
        EPX: "Enterprise Proxy",
      };
      // WAP (Wireless Access Point) is not considered a proxy risk
      if (rawProxyType !== "WAP") {
        isProxy = true;
        riskLabel = typeMap[rawProxyType] || rawProxyType;
      }
    }

    // B) Check IPinfo ASN Database (Hosting / Cloud)
    if (!isProxy && ipinfoData && ipinfoData.type === "hosting") {
      isProxy = true;
      riskLabel = "Cloud/VPS Provider";
      usageType = "Datacenter";
    }

    // C) Fallback: Check Provider Lists against orgName
    if (!isProxy && orgName !== "Unknown ISP") {
      if (
        vpnHostingProviders.high.some((p) =>
          orgName.toLowerCase().includes(p.toLowerCase()),
        )
      ) {
        isProxy = true;
        riskLabel = "VPN Hosting (High Confidence)";
      } else if (
        vpnHostingProviders.medium.some((p) =>
          orgName.toLowerCase().includes(p.toLowerCase()),
        )
      ) {
        isProxy = true;
        riskLabel = "VPN Hosting (Medium Confidence)";
      } else if (
        vpnHostingProviders.low.some((p) =>
          orgName.toLowerCase().includes(p.toLowerCase()),
        )
      ) {
        if (
          usageType === "DCH" ||
          usageType === "Datacenter" ||
          usageType === "Cloud Infrastructure"
        ) {
          isProxy = true;
          riskLabel = "Cloud Hosting (Low Confidence)";
        }
      }
    }

    // D) ASN-based detection (High-Risk Networks ONLY)
    if (!isProxy && vpnASNs.includes(asnNumber)) {
      isProxy = true;
      riskLabel = "VPN ASN Match";
    }

    // --- THREAT & PROVIDER SANITIZATION ---
    let threat = "None";
    let provider = "N/A";

    if (isProxy && riskLabel !== "No") {
      if (usageType === "Standard ISP" || usageType === "Standard") {
        usageType = "Datacenter";
      }
      provider = rawProvider || orgName;

      if (rawThreat && rawThreat !== "None") {
        threat = rawThreat;
      } else {
        if (riskLabel.includes("High") || riskLabel === "VPN ASN Match") {
          threat = "High (VPN Hosting)";
        } else if (riskLabel.includes("Medium")) {
          threat = "Medium (Hosting Provider)";
        } else {
          threat = "Low (Cloud Provider)";
        }
      }
    }

    // --- FINAL MERGE ---
    const cityDataCity = cleanValue(cityData?.city?.names?.en);
    const db11DataCity = cleanValue(db11Data.city);

    let finalCountry, finalCountryCode, finalCity, finalRegion, finalTimezone, lat, long, finalZip;

    if (!cityDataCity && db11DataCity) {
      // Use DB11 primarily for location to avoid mixing different providers' data
      finalCountry = pick(db11Data.countryLong, cityData?.country?.names?.en);
      finalCountryCode = pick(db11Data.countryShort, cityData?.country?.iso_code, "XX");
      finalCity = db11DataCity;
      finalRegion = cleanValue(db11Data.region) || cleanValue(cityData?.subdivisions?.[0]?.names?.en) || "Unknown";
      // MaxMind IANA timezone (e.g. Europe/London) is preferred over DB11 offset (e.g. +00:00) if available
      finalTimezone = cleanValue(cityData?.location?.time_zone) || cleanValue(db11Data.timeZone) || "Unknown";
      lat = parseFloat(db11Data.latitude) || cityData?.location?.latitude || 0;
      long = parseFloat(db11Data.longitude) || cityData?.location?.longitude || 0;
      finalZip = cleanValue(db11Data.zipCode) || cleanValue(cityData?.postal?.code) || "N/A";
    } else {
      // Use CityData (MaxMind) primarily, with DB11 as fallback
      finalCountry = pick(cityData?.country?.names?.en, db11Data.countryLong);
      finalCountryCode = pick(cityData?.country?.iso_code, db11Data.countryShort, "XX");
      finalCity = pick(cityData?.city?.names?.en, db11Data.city);
      finalRegion = pick(cityData?.subdivisions?.[0]?.names?.en, db11Data.region);
      finalTimezone = pick(cityData?.location?.time_zone, db11Data.timeZone);

      lat = cityData?.location?.latitude || 0;
      long = cityData?.location?.longitude || 0;
      if (lat === 0 && long === 0 && cleanValue(db11Data.latitude) && db11Data.latitude !== "0.000000") {
        lat = parseFloat(db11Data.latitude) || 0;
        long = parseFloat(db11Data.longitude) || 0;
      }

      finalZip = cleanValue(cityData?.postal?.code) || cleanValue(db11Data.zipCode) || "N/A";
    }

    return {
      ip,
      country: finalCountry,
      country_code: finalCountryCode,
      city: finalCity,
      region: finalRegion,
      timezone: finalTimezone,
      coordinates: `${lat}, ${long}`,
      latitude: lat,
      longitude: long,
      zip: finalZip,
      asn: asnNumber,
      org: orgName,
      network: networkCidr,
      is_proxy: isProxy,
      proxy_type: riskLabel,
      usage_type: usageType,
      threat: threat,
      provider: provider,
    };
  } catch (err) {
    console.error("Geo lookup failed for IP:", ip, err);
    return { ip, error: "Lookup Failed" };
  }
}

module.exports = { initGeoDb, getGeoData };
