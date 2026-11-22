const test = require("node:test");
const assert = require("node:assert/strict");

const { getGeoData, _internals } = require("../src/geoip");

test.afterEach(() => {
  _internals.setLookupsForTests({});
});

test("cleanValue filters placeholder tokens and IP2Location/IP2Proxy error strings", () => {
  assert.equal(_internals.cleanValue("London"), "London");
  assert.equal(_internals.cleanValue("  UK  "), "UK");
  assert.equal(_internals.cleanValue("-"), null);
  assert.equal(_internals.cleanValue("?"), null);
  assert.equal(_internals.cleanValue("N/A"), null);
  assert.equal(_internals.cleanValue("Unknown"), null);
  assert.equal(_internals.cleanValue("IPV6 ADDRESS MISSING IN IPV4 BIN"), null);
  assert.equal(_internals.cleanValue("INVALID IP ADDRESS"), null);
  assert.equal(_internals.cleanValue(null), null);
});

test("getGeoData detects local, reserved, and Docker bridge ranges accurately", () => {
  for (const localIp of [
    "127.0.0.1",
    "::1",
    "192.168.1.10",
    "10.0.0.5",
    "169.254.1.1",
    "fc00::1",
    "fd00::1234",
    "172.16.0.1",
    "172.31.255.254",
  ]) {
    const res = getGeoData(localIp);
    assert.equal(res.country, "Reserved", `Expected Reserved for ${localIp}`);
    assert.equal(res.city, "Local Network", `Expected Local Network for ${localIp}`);
    assert.equal(res.proxy_type, "Local");
  }

  // 172.15.x.x and 172.32.x.x are public, NOT Docker private space
  assert.notEqual(getGeoData("172.15.0.1").country, "Reserved");
  assert.notEqual(getGeoData("172.32.0.1").country, "Reserved");

  // Non-string input does not throw
  assert.equal(getGeoData(null).country, "Unknown");
});

test("getGeoData classifies VPNs, proxies, hosting providers, and ignores WAP", () => {
  // 1. IP2Proxy VPN detection
  _internals.setLookupsForTests({
    asnLookup: {
      getWithPrefixLength: () => [{ autonomous_system_number: 12345, autonomous_system_organization: "Some Net" }, 24],
    },
    proxyLookup: {
      getAll: () => ({
        isProxy: 1,
        proxyType: "VPN",
        usageType: "DCH",
        provider: "NordVPN",
        threat: "None",
      }),
    },
  });
  const vpnRes = getGeoData("203.0.113.42");
  assert.equal(vpnRes.is_proxy, true);
  assert.equal(vpnRes.proxy_type, "VPN Service");
  assert.equal(vpnRes.usage_type, "Datacenter");
  assert.equal(vpnRes.provider, "NordVPN");
  assert.equal(vpnRes.network, "203.0.113.0/24");

  // 2. WAP (Wireless Access Point) is NOT flagged as proxy risk
  _internals.setLookupsForTests({
    proxyLookup: {
      getAll: () => ({ isProxy: 1, proxyType: "WAP", usageType: "MOB" }),
    },
  });
  const wapRes = getGeoData("198.51.100.10");
  assert.equal(wapRes.is_proxy, false);
  assert.equal(wapRes.usage_type, "Mobile Data");

  // 3. IPinfo hosting classification flags Cloud/VPS Provider
  _internals.setLookupsForTests({
    ipinfoAsnLookup: {
      get: () => ({ asn: "AS14061", name: "DigitalOcean, LLC", type: "hosting" }),
    },
  });
  const hostRes = getGeoData("198.51.100.20");
  assert.equal(hostRes.is_proxy, true);
  assert.equal(hostRes.proxy_type, "Cloud/VPS Provider");
  assert.equal(hostRes.usage_type, "Datacenter");
  assert.equal(hostRes.asn, "AS14061");

  // 4. High-risk VPN ASN match (AS9009 = M247)
  _internals.setLookupsForTests({
    asnLookup: {
      getWithPrefixLength: () => [{ autonomous_system_number: 9009, autonomous_system_organization: "Unlisted Name" }, 24],
    },
  });
  const asnRes = getGeoData("198.51.100.30");
  assert.equal(asnRes.is_proxy, true);
  assert.equal(asnRes.proxy_type, "VPN ASN Match");
  assert.equal(asnRes.threat, "High (VPN Hosting)");
});

test("getGeoData merges MaxMind and DB11 cleanly without mixing cities and prefers IANA timezone", () => {
  // MaxMind has country/timezone but no city; DB11 fills city/region/coords while keeping MaxMind IANA timezone
  _internals.setLookupsForTests({
    cityLookup: {
      get: () => ({
        country: { names: { en: "United Kingdom" }, iso_code: "GB" },
        location: { time_zone: "Europe/London", latitude: 0, longitude: 0 },
      }),
    },
    db11Lookup: {
      getAll: () => ({
        countryLong: "United Kingdom",
        countryShort: "GB",
        region: "England",
        city: "Manchester",
        zipCode: "M1",
        timeZone: "+00:00",
        latitude: "53.4808",
        longitude: "-2.2426",
      }),
    },
  });

  const merged = getGeoData("2001:db8::1");
  assert.equal(merged.city, "Manchester");
  assert.equal(merged.region, "England");
  assert.equal(merged.zip, "M1");
  assert.equal(merged.timezone, "Europe/London");
  assert.equal(merged.latitude, 53.4808);
  assert.equal(merged.longitude, -2.2426);
});
