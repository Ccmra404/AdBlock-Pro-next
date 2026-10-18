# Third-party notices

This project includes or redistributes the following upstream components and rule data. Their licenses remain in force; this notice does not relicense upstream materials.

- **AdGuard Home v0.107.79**: unmodified ARM64 binary at `bin/AdGuardHome`. License: GPL-3.0. Source release: https://github.com/AdguardTeam/AdGuardHome/releases/tag/v0.107.79. The expected binary SHA-256 is recorded in `upstream/adguard-home.json`.
- **10007 filter snapshot**: `bin/data/filters/10007.txt`, from https://github.com/lingeringsound/10007_auto. Repository license metadata reports GPL-3.0.
- **AWAvenue Ads Rule snapshot**: `bin/data/filters/1791638912.txt`, from https://github.com/TG-Twilight/AWAvenue-Ads-Rule. Repository license metadata reports GPL-3.0.
- **curl 8.23.0**: ARM64 Android binary at `bin/curl`, built from the upstream source with OpenSSL 3.5.9. curl is licensed under the curl license; OpenSSL is licensed under Apache-2.0. Full license texts are included at `licenses/curl-COPYING.txt` and `licenses/openssl-LICENSE.txt`.
- **Mozilla CA root certificates (2026-09-25)**: PEM bundle at `certs/cacert.pem`, distributed by https://curl.se/docs/caextract.html under MPL-2.0. Source, checksum and update instructions are in `certs/README.md`; the license is at `licenses/cacert-MPL-2.0.txt`.

- **go-openai v1.43.0**: OpenAI-compatible API client linked into the optional `bin/adblock-ai` helper. Source: https://github.com/sashabaranov/go-openai/tree/v1.43.0. Apache-2.0 license: `licenses/go-openai-Apache-2.0.txt`.

See each upstream repository for its complete license and current source. The original AdBlock Pro code is licensed under GPL-3.0-only. The maintainer-approved public app-domain snapshot is included at `rules/shared-app-domains.txt`; local personal lists, credentials and device query logs are not included.
