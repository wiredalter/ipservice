# IPSearch

[![Website](https://img.shields.io/badge/Website-ipsearch.uk-10b981?style=flat-square&logo=googlechrome&logoColor=white)](https://ipsearch.uk)
[![JSON](https://img.shields.io/badge/JSON-ipsearch.uk%2Fjson-09090b?style=flat-square&logo=json&logoColor=white)](https://ipsearch.uk/json)

An IP intelligence API and web service. It provides real-time geolocation, ISP/ASN details, and risk analysis (VPN, Proxy, and Tor detection).

## Features

* **Dual Interface:** Web UI for human users and a JSON/Text API for automated scripts (`curl`/`wget`).
* **Deep Risk Analysis:** Detects VPNs, Datacenters, Tor Exit Nodes, and Public Proxies.
* **Integrated Threat Intelligence:** Aggregates real-time reputation data from CrowdSec, AbuseIPDB, GreenSnow, FireHOL, and SpamCop.
* **Smart Labeling:** Distinguishes between "Safe Cloud" infrastructure (e.g., AWS/Oracle content delivery) and high-risk VPN/Proxy hosting.
* **Privacy First:** Engineered to run entirely in-memory with zero logging of user IP addresses.
* **Dockerized:** Simplified deployment using `docker compose`.

## Usage

### Web Interface

Visit the homepage, [ipsearch.uk](https://ipsearch.uk) to see your own connection details, or search for any IP address manually.

### CLI / API Access

Developers and system administrators can use standard command-line tools to fetch data.

**Plain Text (IP Address Only):**
Returns the detected public IP address as a string.

```bash
curl ipsearch.uk
```

**JSON Output (Full Metadata):**
Returns a complete data object containing location, network, and threat intelligence details.

```bash
curl ipsearch.uk/json
```

**Manual IP Lookup:**
Append `?ip=` to query a specific address.

```bash
curl "ipsearch.uk/json?ip=8.8.8.8"
```

**Example JSON Response:**

```json
{
  "ip": "8.8.8.8",
  "hostname": "dns.google",
  "country": "United States",
  "city": "Mountain View",
  "region": "California",
  "timezone": "America/Chicago",
  "coordinates": "37.751, -97.822",
  "latitude": 37.751,
  "longitude": -97.822,
  "zip": "N/A",
  "asn": "AS15169",
  "org": "GOOGLE",
  "is_proxy": false,
  "proxy_type": "No",
  "usage_type": "Cloud Infrastructure",
  "threat": "None",
  "provider": "N/A"
}
```

## Installation (Self-Hosted)

### Prerequisites

1. **Clone the repository:**

```bash
git clone https://github.com/wiredalter/ipservice.git
cd ipservice
```

2. **Download Databases:**

The service requires the following database files in the `ip_dbs/` directory:

* `GeoLite2-City.mmdb` (MaxMind)
* `GeoLite2-ASN.mmdb` (MaxMind)
* `ipinfo-asn.mmdb` (IPinfo)
* `IP2LOCATION-LITE-DB11.IPV6.BIN` (IP2Location)
* `IP2PROXY-LITE-PX11.BIN` (IP2Location)

These can be fetched and updated automatically using the maintenance scripts in `db_scripts/`.

### Deployment

For a production deployment using Caddy, CrowdSec, automated database updates, and dual-stack IPv4/IPv6 support, refer to the full [Self-Hosting Guide](/selfhost.md) or visit `/selfhost` on your instance.

A production `docker-compose.yml` integrates the application with Caddy (`ghcr.io/buildplan/cs-caddy:2.11.4`) and CrowdSec (`crowdsecurity/crowdsec:v1.8.1`). Run:

```bash
docker compose up -d
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port to listen on (default: `4040`) |
| `ABUSEIPDB_API_KEY` | No | Enables AbuseIPDB reputation checks |
| `CROWDSEC_API_KEY` | No | Enables CrowdSec threat intelligence |
| `SNIFFCAT_API_KEY` | No | Enables SniffCat VPN/proxy detection |
| `SPAMVERIFY_API_KEY` | No | Enables SpamVerify reputation checks |
| `CROWDSEC_URL` | No | CrowdSec local API URL (default: `http://crowdsec:8080`) |
| `MAX_MEMORY_MB` | No | Memory limit for the `/health` endpoint check |

## License & Attributions

This project is licensed under the **[MIT License](LICENSE)**.

* This product includes GeoLite2 data created by MaxMind, available from [https://www.maxmind.com](https://www.maxmind.com).
* This product uses IP2Location LITE data available from [https://lite.ip2location.com](https://lite.ip2location.com).
* Threat intelligence data aggregated from [CrowdSec](https://www.crowdsec.net/), [AbuseIPDB](https://www.abuseipdb.com/), [GreenSnow](https://greensnow.co/), [FireHOL](https://iplists.firehol.org/), and [SpamCop](https://www.spamcop.net/).
* Fallback data, in case local database has issues, comes from the API of [https://www.geojs.io](https://www.geojs.io/).
* Map tiles provided by [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors and rendered with [MapLibre GL JS](https://maplibre.org/).
