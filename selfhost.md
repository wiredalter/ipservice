Self-Hosting IPSearch
=====================

Production deployment guide covering Docker Compose, Caddy reverse proxy, CrowdSec AppSec WAF, and automated database synchronization.


1\. Architecture Overview
-------------------------

The deployment is composed of three interconnected services running inside a shared Docker bridge network with dual-stack IPv4 and IPv6 capabilities:

**ipsearch**

Node.js backend (Express) executing in-memory IP geolocation lookups (MaxMind and IP2Location), threat score calculation, WHOIS/RDAP checks, and CLI output formatting. Listens internally on port 4040.

**caddy**

Custom Caddy build (`ghcr.io/buildplan/cs-caddy:2.11.4`) bundled with the CrowdSec Layer 7 bouncer and AppSec module. Handles automated Let's Encrypt TLS certificates, security headers, and CLI bypass logic on port 80. Requires the CrowdSec AppSec listener on port 7422.

**crowdsec**

Security engine running log acquisition, AppSec WAF inspection, and a Local API (LAPI) queried by the backend application to check real-time IP ban status.

2\. Directory Structure
-----------------------

Place all deployment configurations, database files, and persistent state within a dedicated root folder (e.g., `/home/user/ipsearch` or `/opt/ipsearch`). The layout mirrors the volume mounts specified in Docker Compose:

    ipsearch/
    ├── caddy/
    │   ├── Caddyfile
    │   ├── config/
    │   │   └── caddy/
    │   ├── data/
    │   │   └── caddy/
    │   └── logs/
    │       ├── ip-access.log
    │       ├── ip-cli-access.log
    │       └── system-access.log
    ├── crowdsec/
    │   ├── config/
    │   │   ├── acquis.d/
    │   │   │   ├── appsec.yaml
    │   │   │   └── caddy.yaml
    │   │   ├── acquis.yaml
    │   │   ├── appsec-configs/
    │   │   ├── appsec-rules/
    │   │   ├── collections/
    │   │   ├── config.yaml
    │   │   ├── profiles.yaml
    │   │   └── ...
    │   └── data/
    │       ├── crowdsec.db
    │       └── ...
    ├── db_scripts/
    │   ├── .env.geolite2
    │   ├── .env_ip2db
    │   ├── .env_ip2px
    │   ├── .env.ipinfo
    │   ├── geolite2-update.sh
    │   ├── geolite2-update-asn.sh
    │   ├── ip2location-db.sh
    │   ├── ip2location-px.sh
    │   └── ipinfo-update.sh
    ├── ip_dbs/
    │   ├── GeoLite2-ASN.mmdb
    │   ├── GeoLite2-City.mmdb
    │   ├── IP2LOCATION-LITE-DB11.IPV6.BIN
    │   ├── IP2PROXY-LITE-PX11.BIN
    │   └── ipinfo-asn.mmdb
    ├── docker-compose.yml
    └── .env

Run the following shell command on your host server to prepare the required directory skeleton:

    mkdir -p caddy/config caddy/data caddy/logs \
             crowdsec/config/acquis.d crowdsec/data \
             db_scripts ip_dbs

3\. DNS Record Setup at Registrar
---------------------------------

The service utilizes four distinct subdomains to accommodate standard web traffic, plain CLI commands, and explicit single-stack testing for IPv4 and IPv6:

| Host / Name                    | Record Type | Target Value                      | Purpose                                                                                                   |
| ------------------------------ | ----------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ipsearch.yourdomain.com`      | A           | `<SERVER_IPV4>`                   | Dual-stack primary entry point (IPv4 resolution)                                                          |
| `ipsearch.yourdomain.com`      | AAAA        | `<SERVER_IPV6>`                   | Dual-stack primary entry point (IPv6 resolution)                                                          |
| `www.ipsearch.yourdomain.com`  | A / AAAA    | `<SERVER_IPV4>` / `<SERVER_IPV6>` | Web canonical alias pointing to primary host                                                              |
| `ipv4.ipsearch.yourdomain.com` | A           | `<SERVER_IPV4>`                   | IPv4-only endpoint. Contains no AAAA record, forcing dual-stack clients to resolve exclusively over IPv4. |
| `ipv6.ipsearch.yourdomain.com` | AAAA        | `<SERVER_IPV6>`                   | IPv6-only endpoint. Contains no A record, forcing clients to resolve exclusively over IPv6.               |

Note: If managing DNS through Cloudflare, configure these entries with Proxy status set to "DNS Only" (grey cloud). Proxying traffic hides the real source IP behind Cloudflare edges unless explicitly reconfigured with proxy headers.

4\. Databases and Update Scripts
--------------------------------

The application reads five binary databases mounted read-only at `/app/db` inside the container. The repository provides maintenance scripts inside `db_scripts/` to automate validation, staging, and atomic replacement of each database:

| Database File                    | Provider    | Update Script                       | Description                                                                                  |
| -------------------------------- | ----------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `GeoLite2-City.mmdb`             | MaxMind     | `db_scripts/geolite2-update.sh`     | Provides city, country, postal code, latitude/longitude, and timezone mapping.               |
| `GeoLite2-ASN.mmdb`              | MaxMind     | `db_scripts/geolite2-update-asn.sh` | Resolves Autonomous System Number (ASN) and organization name.                               |
| `ipinfo-asn.mmdb`                | IPinfo      | `db_scripts/ipinfo-update.sh`       | Supplemental/fallback ASN intelligence file. Validated against official SHA256 API checksum. |
| `IP2LOCATION-LITE-DB11.IPV6.BIN` | IP2Location | `db_scripts/ip2location-db.sh`      | Dual-stack database providing secondary ISP and geographic coordinate resolution.            |
| `IP2PROXY-LITE-PX11.BIN`         | IP2Location | `db_scripts/ip2location-px.sh`      | Identifies proxies, VPN exit gateways, Tor nodes, and hosting/datacenter ranges.             |

### Configuring Script Environment Files

Each script reads an optional local configuration file in `db_scripts/`. Set directory permissions to `chmod 600` on these files:

    # db_scripts/.env.geolite2
    DEST_DIR="/home/user/ipsearch/ip_dbs"
    NTFY_ENABLED=false
    DISCORD_ENABLED=false
    
    # db_scripts/.env.ipinfo
    DEST_DIR="/home/user/ipsearch/ip_dbs"
    IPINFO_TOKEN="your_ipinfo_api_token"
    
    # db_scripts/.env_ip2db
    DEST_DIR="/home/user/ipsearch/ip_dbs"
    IP2_TOKEN="your_ip2location_download_token"
    DB_CODE="DB11LITEBINIPV6"
    TARGET_FILE="IP2LOCATION-LITE-DB11.IPV6.BIN"
    
    # db_scripts/.env_ip2px
    DEST_DIR="/home/user/ipsearch/ip_dbs"
    IP2_TOKEN="your_ip2location_download_token"
    DB_CODE="PX11LITEBIN"
    TARGET_FILE="IP2PROXY-LITE-PX11.BIN"

### Automating Updates with Cron

Configure periodic executions via the host system's crontab (`crontab -e`):

    # Run MaxMind and IPinfo updates every Wednesday and Saturday at 04:00
    0 4 * * 3,6 /bin/bash /home/user/ipsearch/db_scripts/geolite2-update.sh > /dev/null 2>&1
    15 4 * * 3,6 /bin/bash /home/user/ipsearch/db_scripts/geolite2-update-asn.sh > /dev/null 2>&1
    30 4 * * 3,6 /bin/bash /home/user/ipsearch/db_scripts/ipinfo-update.sh > /dev/null 2>&1
    
    # Run IP2Location updates on the 2nd day of every month at 05:00
    0 5 2 * * /bin/bash /home/user/ipsearch/db_scripts/ip2location-db.sh > /dev/null 2>&1
    20 5 2 * * /bin/bash /home/user/ipsearch/db_scripts/ip2location-px.sh > /dev/null 2>&1

Zero-Downtime Hot-Reloading

The backend engine monitors all database paths with Node.js `fs.watch`. When an update script replaces an `.mmdb` or `.BIN` file atomically using `mv`, the application automatically loads the new file into memory within two seconds without restarting containers or dropping active connections.

5\. Docker Compose Setup
------------------------

The `docker-compose.yml` file creates an isolated bridge network with pre-allocated static IPv4 and IPv6 subnets. This guarantees deterministic IP assignments required for CrowdSec bouncer authorizations:

    networks:
      ipsearch-net:
        driver: bridge
        name: ipsearch-net
        enable_ipv6: true
        ipam:
          config:
            - subnet: 172.30.0.0/16
              gateway: 172.30.0.1
            - subnet: fda1:b2c3:d4e5::/64
              gateway: fda1:b2c3:d4e5::1
    
    services:
      # --- Reverse Proxy and TLS Termination ---
      caddy:
        image: ghcr.io/buildplan/cs-caddy:2.11.4
        container_name: caddy
        ports:
          - "80:80"
          - "443:443"
          - "443:443/udp" # HTTP/3 QUIC
        volumes:
          - ./caddy/Caddyfile:/etc/caddy/Caddyfile
          - ./caddy/data:/data
          - ./caddy/config:/config
          - ./caddy/logs:/var/log/caddy
        environment:
          - LETSE_EMAIL=${LETSE_EMAIL}
          - CROWDSEC_CADDY_API_KEY=${CROWDSEC_CADDY_API_KEY}
        networks:
          ipsearch-net:
            ipv4_address: 172.30.0.20
            ipv6_address: fda1:b2c3:d4e5::20
        restart: unless-stopped
        depends_on:
          - ipsearch
          - crowdsec
        logging:
          driver: "json-file"
          options: { max-size: "5m", max-file: "3" }
        deploy:
          resources:
            limits: { cpus: '0.25', memory: 512M }
    
      # --- Application Engine ---
      ipsearch:
        image: ghcr.io/wiredalter/ipservice:latest
        container_name: ipsearch
        restart: unless-stopped
        user: "node"
        security_opt:
          - no-new-privileges:true
        cap_drop:
          - ALL
        ports:
          - "127.0.0.1:4040:4040"
        environment:
          - NODE_ENV=production
          - PORT=4040
          - MAX_MEMORY_MB=1024
          - CROWDSEC_URL=http://crowdsec:8080
          - CROWDSEC_API_KEY=${CROWDSEC_API_KEY}
          - ABUSEIPDB_API_KEY=${ABUSEIPDB_API_KEY}
          - SNIFFCAT_API_KEY=${SNIFFCAT_API_KEY}
          - SPAMVERIFY_API_KEY=${SPAMVERIFY_API_KEY}
          - APP_URL=${APP_URL}
          - ADMIN_EMAIL=${ADMIN_EMAIL}
          - V4_API_URL=${V4_API_URL}
          - V6_API_URL=${V6_API_URL}
        networks:
          ipsearch-net:
            ipv4_address: 172.30.0.21
            ipv6_address: fda1:b2c3:d4e5::21
        volumes:
          - ./ip_dbs:/app/db:ro
        deploy:
          resources:
            limits: { cpus: '0.50', memory: 512M }
    
      # --- Threat Intelligence and Intrusion Prevention ---
      crowdsec:
        image: crowdsecurity/crowdsec:v1.8.1
        container_name: crowdsec
        restart: unless-stopped
        networks:
          ipsearch-net:
            ipv4_address: 172.30.0.25
            ipv6_address: fda1:b2c3:d4e5::25
        volumes:
          - ./crowdsec/config:/etc/crowdsec:rw
          - ./crowdsec/data:/var/lib/crowdsec/data:rw
          - ./caddy/logs:/var/log/caddy:ro
          - /var/log/syslog:/var/log/host/syslog:ro
          - /var/log/auth.log:/var/log/host/auth.log:ro
          - /var/log/kern.log:/var/log/host/kern.log:ro
        environment:
          - TZ=Europe/London
          - GID=1000
          - COLLECTIONS=crowdsecurity/appsec-virtual-patching crowdsecurity/appsec-generic-rules crowdsecurity/caddy crowdsecurity/linux
        ports:
          - "127.0.0.1:8080:8080"
          - "127.0.0.1:6060:6060"
        healthcheck:
          test: ["CMD", "cscli", "lapi", "status"]
          interval: 1m
          timeout: 15s
          retries: 3
        logging:
          driver: "json-file"
          options: { max-size: "5m", max-file: "3" }

6\. Complete Caddyfile Configuration
------------------------------------

Place this file at `caddy/Caddyfile`. Replace `ipsearch.uk` with your registered domain name:

    # --- Global options ---
    {
    	email {env.LETSE_EMAIL}
    	admin :2019
    	metrics
    
    	log {
    		output file /var/log/caddy/system-access.log {
    			mode 0640
    			roll_size 10mb
    			roll_keep 5
    			roll_keep_for 360h
    		}
    		format json
    		level INFO
    	}
    
    	# --- CrowdSec Bouncer Configuration ---
    	crowdsec {
    		api_url http://crowdsec:8080
    		api_key {env.CROWDSEC_CADDY_API_KEY}
    		appsec_url http://crowdsec:7422
    		ticker_interval 15s
    		metrics_interval 10m
    	}
    }
    
    (secure_headers) {
    	header {
    		Strict-Transport-Security "max-age=31536000; includeSubDomains"
    		X-Frame-Options "SAMEORIGIN"
    		X-Content-Type-Options "nosniff"
    		X-XSS-Protection "1; mode=block"
    		Referrer-Policy "strict-origin-when-cross-origin"
    		Permissions-Policy "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"
    	}
    }
    
    # --- Internal Healthcheck ---
    :2020 {
    	respond "OK" 200
    }
    
    # --- IP Service (HTTP for CLI Tools) ---
    http://ipsearch.uk, http://ipv6.ipsearch.uk, http://ipv4.ipsearch.uk {
    	# Enable logging so CrowdSec can read the access logs
    	log {
    		output file /var/log/caddy/ip-cli-access.log {
    			mode 0640
    			roll_size 5MiB
    			roll_keep 3
    			roll_keep_for 180h
    		}
    		format json
    	}
    
    	# 1. Route ALL port 80 traffic through CrowdSec first
    	route {
    		crowdsec
    		appsec
    
    		# 2. Match exact User-Agents from server.js logic
    		@cli {
    			header_regexp User-Agent "(?i)(curl|wget|httpie|python|powershell|aiohttp|go-http-client)"
    		}
    
    		# 3. If it's a CLI tool, proxy directly over plain HTTP
    		handle @cli {
    			reverse_proxy ipsearch:4040 {
    				header_up -CF-Connecting-IP
    				header_up -X-Real-IP
    			}
    		}
    
    		# 4. For all other HTTP traffic (e.g., standard browsers), enforce HTTPS
    		handle {
    			redir https://{host}{uri} permanent
    		}
    	}
    }
    
    # --- IP Service (HTTPS for Web Browsers) ---
    https://ipsearch.uk, https://www.ipsearch.uk, https://ipv6.ipsearch.uk, https://ipv4.ipsearch.uk {
    	log {
    		output file /var/log/caddy/ip-access.log {
    			mode 0640
    			roll_size 5MiB
    			roll_keep 3
    			roll_keep_for 180h
    		}
    		format json
    	}
    
    	route {
    		crowdsec
    		appsec
    
    		import secure_headers
    		header Content-Security-Policy "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://unpkg.com https://static.cloudflareinsights.com/; style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; img-src 'self' data: https://*.openstreetmap.org https://server.arcgisonline.com https://www.abuseipdb.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://server.arcgisonline.com https://*.tile.openstreetmap.org https://*.ipsearch.uk https://unpkg.com https://bash.ws https://*.bash.ws; worker-src 'self' blob: https://unpkg.com;"
    
    		reverse_proxy ipsearch:4040 {
    			header_up -CF-Connecting-IP
    			header_up -X-Real-IP
    		}
    	}
    }

### Why CLI Routing is Configured on Port 80

When users run commands like `curl ipsearch.uk` or `wget -qO- ipsearch.uk`, standard web servers issue an HTTP 301/308 redirect to HTTPS. CLI utilities do not follow redirects unless the user explicitly passes flags (such as `-L` with curl).

By evaluating the `User-Agent` header with regular expressions inside the HTTP block, Caddy selectively serves CLI requests directly on port 80 without requiring SSL handshakes or redirect loops. All standard browser traffic continues to be upgraded to HTTPS automatically.

### Using Cloudflare Proxy (Orange Cloud)

If you run this service behind Cloudflare's proxy network, the backend relies on the `CF-Connecting-IP` header to determine the user's real IP address.

In the `Caddyfile` template above, we aggressively strip `CF-Connecting-IP` to prevent IP spoofing attacks. If you are using Cloudflare, you must **remove** the `header_up -CF-Connecting-IP` directives from your `reverse_proxy` blocks.

**Security Warning:** If you allow the `CF-Connecting-IP` header, you _must_ ensure attackers cannot connect to your Caddy server directly to spoof it. You should configure your server's firewall (ufw/iptables) to only accept incoming connections on ports 80 and 443 from [Cloudflare's official IP ranges](https://www.cloudflare.com/ips/). Alternatively, you can drop non-Cloudflare traffic directly within your `Caddyfile` like this:

    @cloudflare {
        # Cloudflare's IPv4 ranges
        remote_ip 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22
    }
    
    handle @cloudflare {
        reverse_proxy ipsearch:4040
    }
    
    # Drop any requests that didn't come through Cloudflare
    handle {
        abort
    }

7\. CrowdSec and AppSec Setup
-----------------------------

The custom Caddy image (`ghcr.io/buildplan/cs-caddy:2.11.4`) compiled with CrowdSec integration contains both the Layer 7 bouncer and AppSec WAF modules. In the `Caddyfile`, the directives `appsec_url http://crowdsec:7422` and `appsec` instruct Caddy to route incoming request bodies and headers to the CrowdSec AppSec engine for real-time inspection.

Critical Prerequisite: AppSec Listener Required for Caddy

Caddy will fail to start or reject incoming requests if the CrowdSec AppSec listener is not active on port 7422. Because Caddy and CrowdSec run as distinct containers on the `ipsearch-net` bridge network, CrowdSec must bind AppSec to `0.0.0.0:7422` (not 127.0.0.1) so Caddy can reach it over the internal network.

### 1\. AppSec Acquisition Configuration

Create `crowdsec/config/acquis.d/appsec.yaml` to activate the AppSec listener inside CrowdSec:

    listen_addr: 0.0.0.0:7422
    appsec_config: crowdsecurity/appsec-default
    name: caddy-appsec
    source: appsec
    labels:
      type: appsec

### 2\. Log Acquisition Configuration

Create `crowdsec/config/acquis.d/caddy.yaml` so CrowdSec ingests the access logs generated by Caddy:

    filenames:
      - /var/log/caddy/*.log
    labels:
      type: caddy

### 3\. Registering Bouncers

Two distinct bouncers must be created using the CrowdSec command-line interface (`cscli`):

Bouncer A: caddy-bouncer (Caddy Proxy Filter)

Enables the Caddy reverse proxy to block banned IPs and communicate with the AppSec WAF module.

    docker exec crowdsec cscli bouncers add caddy-bouncer

Copy the generated key and assign it to `CROWDSEC_CADDY_API_KEY` in your `.env` file.

Bouncer B: ip-service (Application Reputation Check)

Authorizes the Node.js backend to query the CrowdSec LAPI (`GET /v1/decisions?ip=...`) during IP reputation analysis.

    docker exec crowdsec cscli bouncers add ip-service

Copy the generated key and assign it to `CROWDSEC_API_KEY` in your `.env` file.

### 4\. Verifying Registered Bouncers

Verify both bouncers are active and connected with valid credentials:

    docker exec crowdsec cscli bouncers list

Expected output format:

    -----------------------------------------------------------------------------------------------------------------------
     Name           IP Address   Valid  Last API pull         Type              Version   Auth Type 
    -----------------------------------------------------------------------------------------------------------------------
     caddy-bouncer  172.30.0.20  OK     2026-09-14T17:49:45Z  caddy-cs-bouncer  v0.14.1   api-key   
     ip-service     172.30.0.21  OK     2026-09-14T05:19:29Z  axios             1.20.0    api-key   
    -----------------------------------------------------------------------------------------------------------------------

8\. Customizing and Building from Source
----------------------------------------

If you want to modify branding, change hardcoded domain names, update policies, or remove public documentation to make the service completely your own, you can clone the source repository and build a custom container image locally.

A. Customize Web UI and Metadata

*   **Branding and Titles:** Edit `views/index.html` to replace the title, meta tags, header logo, search input placeholders, and footer links.
*   **Terms and Privacy:** Edit `views/terms.html` to replace company or operator names, disclaimers, and contact information.
*   **Favicons:** Replace the icon set in `views/favicon/` and update `site.webmanifest`.

B. Update Hardcoded Domain URLs and Endpoints

*   **Frontend Config:** In `docker-compose.yml`, set your public URLs in `APP_URL`, `V4_API_URL`, and `V6_API_URL`. The frontend dynamically fetches these via the `/api/config` endpoint in `server.js`.
*   **Caddy Configuration:** Replace all instances of `ipsearch.uk` in `caddy/Caddyfile` with your own domain name.

C. Optionally Remove the Self-Hosting Guide

If you do not want to expose the self-hosting guide on your public instance:

1.  Delete the file: `rm views/selfhost.html`
2.  Remove the route in `server.js`:
    
        // Remove or comment out these lines:
        app.get("/selfhost", (req, res) => {
          res.sendFile(path.join(__dirname, "views", "selfhost.html"));
        });
    
3.  Remove the "Self Host" link from the footer in `views/index.html`.

D. Compile Tailwind CSS and Build the Local Image

The project uses Tailwind CSS via `@tailwindcss/cli` in `package.json`. Compile styles locally or let Docker build them automatically:

    # Recompile CSS locally if making template adjustments
    npm run build:css
    
    # Build your custom Docker image
    docker build -t my-ipservice:latest .

In `docker-compose.yml`, switch the `ipsearch` service from the remote registry image to your local build:

      ipsearch:
        build: .
        image: my-ipservice:latest
        container_name: ipsearch
        ...

9\. Environment Variables
-------------------------

Create an environment configuration file named `.env` in the project root:

    # --- TLS / Let's Encrypt ---
    LETSE_EMAIL=admin@yourdomain.com
    ADMIN_EMAIL=admin@yourdomain.com
    
    # --- CrowdSec API Keys ---
    CROWDSEC_CADDY_API_KEY=your_generated_caddy_bouncer_key
    CROWDSEC_API_KEY=your_generated_ip_service_bouncer_key
    
    # --- External Threat Intelligence APIs (Optional) ---
    ABUSEIPDB_API_KEY=
    SNIFFCAT_API_KEY=
    SPAMVERIFY_API_KEY=
    
    # --- Service Hostnames ---
    APP_URL=https://ipsearch.yourdomain.com
    V4_API_URL=https://ipv4.ipsearch.yourdomain.com/api/info
    V6_API_URL=https://ipv6.ipsearch.yourdomain.com/api/info

| Variable Name            | Required | Description                                                                          |
| ------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `LETSE_EMAIL`            | Yes      | Email address provided to Let's Encrypt for TLS expiration notices.                  |
| `CROWDSEC_CADDY_API_KEY` | Yes      | API key generated by `cscli bouncers add caddy-bouncer`.                             |
| `CROWDSEC_API_KEY`       | Yes      | API key generated by `cscli bouncers add ip-service`.                                |
| `ABUSEIPDB_API_KEY`      | No       | Enables live reputation queries against the AbuseIPDB API.                           |
| `SNIFFCAT_API_KEY`       | No       | Enables VPN and proxy fraud risk evaluation through SniffCat.                        |
| `SPAMVERIFY_API_KEY`     | No       | Enables spam score verification through SpamVerify.                                  |
| `V4_API_URL`             | Yes      | Full URL pointing to the IPv4-only information endpoint for client interface checks. |
| `V6_API_URL`             | Yes      | Full URL pointing to the IPv6-only information endpoint for client interface checks. |
| `MAX_MEMORY_MB`          | No       | Threshold in megabytes for the `/health` status endpoint (default: 1024).            |

10\. Step-by-Step Deployment
----------------------------

Step 1: Set up directories and files

Clone or copy the project files to your server and initialize the directory tree:

    git clone https://github.com/wiredalter/ipservice.git ipsearch
    cd ipsearch
    mkdir -p caddy/config caddy/data caddy/logs \
             crowdsec/config/acquis.d crowdsec/data \
             ip_dbs

Step 2: Populate IP intelligence databases

Configure credentials in `db_scripts/` and execute the fetch scripts to populate `ip_dbs/`:

    chmod +x db_scripts/*.sh
    ./db_scripts/geolite2-update.sh
    ./db_scripts/geolite2-update-asn.sh
    ./db_scripts/ipinfo-update.sh
    ./db_scripts/ip2location-db.sh
    ./db_scripts/ip2location-px.sh

Step 3: Configure AppSec and start CrowdSec

Ensure `crowdsec/config/acquis.d/appsec.yaml` and `crowdsec/config/acquis.d/caddy.yaml` are in place, then launch CrowdSec to register bouncers:

    docker compose up -d crowdsec
    docker exec crowdsec cscli bouncers add caddy-bouncer
    docker exec crowdsec cscli bouncers add ip-service

Step 4: Configure .env and launch full stack

Insert the bouncer keys into `.env`, review `caddy/Caddyfile` domain names, and start all containers:

    docker compose up -d

11\. Verification and Testing
-----------------------------

Execute the following verification requests from an external machine to confirm all proxy routes, CLI formats, and dual-stack subdomains are operational:

Plain Text IP (Port 80 CLI Route)

    curl http://ipsearch.yourdomain.com

Full JSON Intelligence

    curl http://ipsearch.yourdomain.com/json

Formatted CLI Dashboard

    curl http://ipsearch.yourdomain.com/cli

Specific IP Lookup

    curl "http://ipsearch.yourdomain.com/json?ip=1.1.1.1"

Reputation Endpoint (CrowdSec / Abuse Check)

    curl "http://ipsearch.yourdomain.com/api/reputation?ip=1.1.1.1"

Single-Stack Testing

    # Force IPv4 resolution
    curl http://ipv4.ipsearch.yourdomain.com
    
    # Force IPv6 resolution
    curl http://ipv6.ipsearch.yourdomain.com

Container Health Status

    curl http://127.0.0.1:4040/health
    docker exec crowdsec cscli lapi status
