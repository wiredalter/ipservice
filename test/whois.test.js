const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const axios = require("axios");

const getWhois = require("../src/whois");
const {
  ipv4ToBigInt,
  ipv6ToBigInt,
  normalizeQueryIp,
  parseBootstrapServices,
  matchBootstrapUrls,
  parseRdapResponse,
  isBrokenRdapResult,
  resetForTests,
} = getWhois._internals;

const SAMPLE_IPV6_BOOTSTRAP = {
  version: "1.0",
  publication: "2026-11-01T00:00:00Z",
  services: [
    [["2001:0400::/23", "2001:4800::/23", "2600::/12"], ["https://rdap.arin.net/registry/"]],
    [["2a00::/12", "2001:0600::/23"], ["https://rdap.db.ripe.net/"]],
    [["2400::/12"], ["http://rdap.apnic.net/", "https://rdap.apnic.net/"]],
    [["2001:4860::/32"], ["https://rdap-specific.example.net/"]],
  ],
};

const SAMPLE_IPV4_BOOTSTRAP = {
  version: "1.0",
  publication: "2026-11-01T00:00:00Z",
  services: [
    [["8.0.0.0/8"], ["https://rdap.arin.net/registry/"]],
    [["1.0.0.0/8"], ["https://rdap.apnic.net/"]],
  ],
};

test.beforeEach(() => {
  resetForTests();
  delete process.env.RDAP_IPV4_DB_PATH;
  delete process.env.RDAP_IPV6_DB_PATH;
});

test("IP parsing & IPv4-mapped IPv6 normalization", () => {
  assert.equal(ipv4ToBigInt("8.8.8.8"), 0x08080808n);
  assert.equal(ipv6ToBigInt("::"), 0n);
  assert.equal(ipv6ToBigInt("::1"), 1n);
  assert.equal(
    ipv6ToBigInt("2001:4860:4860::8888"),
    ipv6ToBigInt("2001:4860:4860:0000:0000:0000:0000:8888"),
  );

  assert.deepEqual(normalizeQueryIp("  2001:4860:4860::8888 "), {
    ip: "2001:4860:4860::8888",
    version: 6,
  });
  assert.deepEqual(normalizeQueryIp("[2a00:1450:4009:820::200e]"), {
    ip: "2a00:1450:4009:820::200e",
    version: 6,
  });
  assert.deepEqual(normalizeQueryIp("::ffff:8.8.8.8"), {
    ip: "8.8.8.8",
    version: 4,
  });
  assert.equal(normalizeQueryIp("not-an-ip"), null);
});

test("IANA IPv6 bootstrap performs longest-prefix match and enforces HTTPS-only URLs", () => {
  const entries = parseBootstrapServices(SAMPLE_IPV6_BOOTSTRAP, true);

  // /32 beats /23 for 2001:4860:4860::8888
  assert.deepEqual(matchBootstrapUrls("2001:4860:4860::8888", 6, entries), [
    "https://rdap-specific.example.net/",
  ]);

  // /23 ARIN block
  assert.deepEqual(matchBootstrapUrls("2001:4801:7825::1", 6, entries), [
    "https://rdap.arin.net/registry/",
  ]);

  // /12 RIPE block
  assert.deepEqual(matchBootstrapUrls("2a00:1450:4009:820::200e", 6, entries), [
    "https://rdap.db.ripe.net/",
  ]);

  // /12 APNIC block strips plain http:// and keeps https://
  assert.deepEqual(matchBootstrapUrls("2400:cb00:2048:1::6814:155", 6, entries), [
    "https://rdap.apnic.net/",
  ]);
});

test("parseRdapResponse handles deeply nested abuse contacts, org vCard, remarks, and cidr0_cidrs", () => {
  const ripeIpv6Payload = {
    handle: "2a00:1450:4000::/37",
    country: "IE",
    type: "ALLOCATED-BY-RIR",
    cidr0_cidrs: [{ v6prefix: "2a00:1450:4000::", length: 37 }],
    events: [
      { eventAction: "registration", eventDate: "2012-03-14T10:20:30Z" },
      { eventAction: "last changed", eventDate: "2025-11-01T08:00:00Z" },
    ],
    entities: [
      {
        roles: ["registrant"],
        vcardArray: ["vcard", [["org", {}, "text", ["Google Ireland Limited"]]]],
        entities: [
          {
            roles: ["administrative"],
            vcardArray: ["vcard", [["fn", {}, "text", "Admin Team"]]],
            entities: [
              {
                roles: ["abuse"],
                vcardArray: [
                  "vcard",
                  [
                    ["fn", {}, "text", "Abuse Desk"],
                    ["email", {}, "text", "network-abuse@google.com"],
                  ],
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const parsed = parseRdapResponse(ripeIpv6Payload, "2a00:1450:4009:820::200e");
  assert.equal(parsed.network_name, "2a00:1450:4000::/37");
  assert.equal(parsed.network_range, "2a00:1450:4000::/37");
  assert.equal(parsed.organization, "Google Ireland Limited");
  assert.deepEqual(parsed.abuse_contacts, ["network-abuse@google.com"]);
  assert.equal(parsed.registration_date, "2012-03-14");
  assert.equal(parsed.updated_date, "2025-11-01");
  assert.equal(isBrokenRdapResult(parsed), false);
});

test("parseRdapResponse extracts abuse email from remarks and keeps valid IPv6 records without abuse contacts", () => {
  const remarksPayload = {
    name: "APNIC-V6-NET",
    handle: "2400:cb00::/32",
    startAddress: "2400:cb00::",
    endAddress: "2400:cb00:ffff:ffff:ffff:ffff:ffff:ffff",
    remarks: [
      {
        title: "Abuse contact",
        description: ["Please report abuse to abuse@cloudflare.com"],
      },
    ],
  };
  const parsedWithRemarks = parseRdapResponse(remarksPayload, "2400:cb00::1");
  assert.deepEqual(parsedWithRemarks.abuse_contacts, ["abuse@cloudflare.com"]);
  assert.equal(isBrokenRdapResult(parsedWithRemarks), false);

  const noAbusePayload = {
    name: "ISP-V6-ALLOC",
    handle: "NET6-2600-1",
    startAddress: "2600:1000::",
    endAddress: "2600:1000:ffff::",
    entities: [
      {
        roles: ["registrant"],
        vcardArray: ["vcard", [["fn", {}, "text", "Example Telecom"]]],
      },
    ],
  };
  const parsedNoAbuse = parseRdapResponse(noAbusePayload, "2600:1000::1");
  assert.deepEqual(parsedNoAbuse.abuse_contacts, []);
  assert.equal(isBrokenRdapResult(parsedNoAbuse), false);

  // IANA placeholder or unspecified ::/0 must still be flagged as broken
  assert.equal(
    isBrokenRdapResult(parseRdapResponse({ name: "IANA-BLOCK", handle: "IANA" }, "2001:db8::1")),
    true,
  );
  assert.equal(
    isBrokenRdapResult(
      parseRdapResponse(
        { name: "UNSPEC", startAddress: "::", endAddress: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
        "2001:db8::1",
      ),
    ),
    true,
  );
});

test("getWhois loads local IANA bootstrap, sends unencoded IPv6 path, and caches results", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipsearch-rdap-"));
  const v4Path = path.join(tmpDir, "rdap-ipv4.json");
  const v6Path = path.join(tmpDir, "rdap-ipv6.json");
  fs.writeFileSync(v4Path, JSON.stringify(SAMPLE_IPV4_BOOTSTRAP));
  fs.writeFileSync(
    v6Path,
    JSON.stringify({
      version: "1.0",
      services: [[["2001:4800::/23"], ["https://rdap.arin.net/registry/"]]],
    }),
  );

  process.env.RDAP_IPV4_DB_PATH = v4Path;
  process.env.RDAP_IPV6_DB_PATH = v6Path;

  const originalGet = axios.get;
  const calledUrls = [];

  axios.get = async (url) => {
    calledUrls.push(url);
    return {
      data: {
        name: "GOOGLE-IPV6",
        handle: "NET6-2001-4860-1",
        country: "US",
        type: "DIRECT ALLOCATION",
        startAddress: "2001:4860::",
        endAddress: "2001:4860:ffff:ffff:ffff:ffff:ffff:ffff",
        events: [{ eventAction: "registration", eventDate: "2005-03-14T00:00:00Z" }],
        entities: [
          {
            roles: ["registrant"],
            vcardArray: ["vcard", [["fn", {}, "text", "Google LLC"]]],
            entities: [
              {
                roles: ["abuse"],
                vcardArray: ["vcard", [["email", {}, "text", "network-abuse@google.com"]]],
              },
            ],
          },
        ],
      },
    };
  };

  try {
    const first = await getWhois("2001:4860:4860::8888");
    assert.equal(calledUrls.length, 1);
    // Crucial check: literal colons, NO %3A encoding
    assert.equal(calledUrls[0], "https://rdap.arin.net/registry/ip/2001:4860:4860::8888");
    assert.equal(calledUrls[0].includes("%3A"), false);
    assert.equal(first.network_name, "GOOGLE-IPV6");
    assert.equal(first.organization, "Google LLC");
    assert.deepEqual(first.abuse_contacts, ["network-abuse@google.com"]);
    assert.equal(first.is_raw, false);

    // Second call hits LRU cache (no extra axios.get call)
    const second = await getWhois("2001:4860:4860::8888");
    assert.equal(calledUrls.length, 1);
    assert.equal(second.network_name, "GOOGLE-IPV6");
  } finally {
    axios.get = originalGet;
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("getWhois isolates per-host 429 circuit breakers and falls back to rdap.org then RIPEstat", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipsearch-rdap-fb-"));
  const v4Path = path.join(tmpDir, "rdap-ipv4.json");
  const v6Path = path.join(tmpDir, "rdap-ipv6.json");
  fs.writeFileSync(v4Path, JSON.stringify(SAMPLE_IPV4_BOOTSTRAP));
  fs.writeFileSync(
    v6Path,
    JSON.stringify({
      version: "1.0",
      services: [
        [["2001:4800::/23"], ["https://rdap.arin.net/registry/"]],
        [["2a00::/12"], ["https://rdap.db.ripe.net/"]],
      ],
    }),
  );

  process.env.RDAP_IPV4_DB_PATH = v4Path;
  process.env.RDAP_IPV6_DB_PATH = v6Path;

  const originalGet = axios.get;
  const calls = [];

  axios.get = async (url, config) => {
    calls.push({ url, params: config?.params });
    if (url.startsWith("https://rdap.arin.net/")) {
      const err = new Error("Too Many Requests");
      err.response = { status: 429 };
      throw err;
    }
    if (url.startsWith("https://rdap.org/")) {
      const err = new Error("Not Found");
      err.response = { status: 404 };
      throw err;
    }
    if (url.startsWith("https://stat.ripe.net/")) {
      return {
        data: {
          data: {
            records: [
              [
                { key: "inet6num", value: "2001:4860::/32" },
                { key: "OrgName", value: "Google LLC" },
              ],
            ],
          },
        },
      };
    }
    if (url.startsWith("https://rdap.db.ripe.net/")) {
      return {
        data: {
          name: "RIPE-V6",
          handle: "2a00:1450::/32",
          startAddress: "2a00:1450::",
          endAddress: "2a00:1450:ffff::",
        },
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    // 1. ARIN 429 -> rdap.org 404 -> RIPEstat fallback succeeds with params.resource
    const res1 = await getWhois("2001:4860:4860::8844");
    assert.equal(res1.is_raw, true);
    assert.match(res1.raw_whois, /inet6num: 2001:4860::\/32/);
    assert.equal(calls[2].url, "https://stat.ripe.net/data/whois/data.json");
    assert.deepEqual(calls[2].params, { resource: "2001:4860:4860::8844" });

    // 2. ARIN breaker tripped, but RIPE host still works directly!
    const res2 = await getWhois("2a00:1450:4009::200e");
    assert.equal(res2.is_raw, false);
    assert.equal(res2.network_name, "RIPE-V6");
    assert.equal(calls[3].url, "https://rdap.db.ripe.net/ip/2a00:1450:4009::200e");
  } finally {
    axios.get = originalGet;
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("getWhois auto-fetches remote IANA bootstrap when local files are missing and handles IPv4-mapped IPv6 & irr_records", async () => {
  process.env.RDAP_IPV4_DB_PATH = "/nonexistent/rdap-ipv4.json";
  process.env.RDAP_IPV6_DB_PATH = "/nonexistent/rdap-ipv6.json";

  const originalGet = axios.get;
  const calledUrls = [];

  axios.get = async (url) => {
    calledUrls.push(url);
    if (url === "https://data.iana.org/rdap/ipv4.json") {
      return { data: SAMPLE_IPV4_BOOTSTRAP };
    }
    if (url === "https://data.iana.org/rdap/ipv6.json") {
      throw new Error("IANA unreachable");
    }
    if (url === "https://rdap.arin.net/registry/ip/8.8.8.8") {
      return {
        data: {
          name: "GOGL",
          handle: "NET-8-8-8-0-2",
          startAddress: "8.8.8.0",
          endAddress: "8.8.8.255",
        },
      };
    }
    if (url === "https://rdap.org/ip/2606:4700:4700::1111") {
      const err = new Error("Not Found");
      err.response = { status: 404 };
      throw err;
    }
    if (url === "https://stat.ripe.net/data/whois/data.json") {
      return {
        data: {
          data: {
            records: [],
            irr_records: [
              [
                { key: "route6", value: "2606:4700:4700::/48" },
                { key: "origin", value: "AS13335" },
              ],
            ],
          },
        },
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    // Invalid IP returns error cleanly
    assert.deepEqual(await getWhois("invalid-ip"), { error: "Invalid IP" });

    // IPv4-mapped IPv6 unwraps to IPv4 and auto-fetches ipv4.json from IANA
    const v4Mapped = await getWhois("::ffff:8.8.8.8");
    assert.equal(v4Mapped.is_raw, false);
    assert.equal(v4Mapped.network_name, "GOGL");
    assert.equal(v4Mapped.ip, "::ffff:8.8.8.8");
    assert.ok(calledUrls.includes("https://data.iana.org/rdap/ipv4.json"));
    assert.ok(calledUrls.includes("https://rdap.arin.net/registry/ip/8.8.8.8"));

    // When remote ipv6.json fetch fails, falls back to rdap.org (unencoded) then RIPEstat irr_records
    const irrFallback = await getWhois("2606:4700:4700::1111");
    assert.equal(irrFallback.is_raw, true);
    assert.match(irrFallback.raw_whois, /route6: 2606:4700:4700::\/48/);
    assert.ok(calledUrls.includes("https://rdap.org/ip/2606:4700:4700::1111"));
  } finally {
    axios.get = originalGet;
    resetForTests();
  }
});
