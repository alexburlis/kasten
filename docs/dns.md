# DNS records

This page lists every DNS record Kasten uses and why it exists. The examples use `example.com`, the VPS addresses `203.0.113.10` and `2001:db8::10`, and SES in `eu-central-1`. Use your own values.

## Before you start

You need:

- edit access to your domain's DNS;
- the VPS's public IPv4 address, and its IPv6 address if it has one;
- the SES domain identity, created as in [the AWS guide](aws-ses.md#4-create-the-domain-identity), with its three DKIM tokens;
- a `kasten.json` for your server, in `/var/lib/kasten/cli/` on the VPS, owned by `kasten:kasten` without group or other access, as in [the install guide](install-vps.md#7-prepare-the-configuration).

## Print your records

On the VPS, as root:

```sh
kasten-cli dns --config /etc/kasten/kasten.json
```

`kasten dns` reads only `kasten.json`. It needs no admin key, no secret files and no network. It therefore works before the first boot, once steps 1 to 5 of the [deploy order](../deploy/README.md#order-of-use) are done: `install.sh` has run, the images are loaded and `KASTEN_VERSION` is set.

You can also run it on your computer, with the `kasten-cli` image you built. In the directory that holds `kasten.json`, run `docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/config:ro" kasten-cli:<version> dns --config /config/kasten.json`.

It prints zone-file lines, with the TTL from `dns.ttl` (3600 seconds by default):

- A records for `serverHostname` and `mailApiHostname`, from `dns.ipv4`. Without `dns.ipv4`, the value is the placeholder `<VPS IPv4 address>`.
- AAAA records for both names, only when `dns.ipv6` is set.
- For each domain, the three SES DKIM CNAME records, with the DKIM domain of `dns.sesRegion` (see the DKIM note below). Without `dns.sesDkimTokens` for that domain, the names and values hold the placeholders `<SES DKIM token 1>` to `<SES DKIM token 3>`. Add the three tokens from SES to `kasten.json`, as in [the AWS guide](aws-ses.md#4-create-the-domain-identity), and run it again.
- For each domain, the SPF record and the DMARC record.
- The optional records below, when `kasten.json` asks for them.
- The MX record for each domain, last.
- A comment for the app host. It prints no record for it, because the app host is yours to choose.
- When `serverHostname` or `mailApiHostname` is not in one of your domains, a last comment tells you to create its A and AAAA records in that host's own zone.

It does not print the PTR, CAA, MTA-STS or BIMI records. Replace every `<...>` placeholder before you paste.

## The records

Create every record except the MX first. Change the MX last, when you move your mail in.

| Name                              | Type       | Example value                       | Why it exists                                                                                                       |
| --------------------------------- | ---------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `mx.example.com`                  | A          | `203.0.113.10`                      | The address that other mail servers connect to on port 25                                                           |
| `mx.example.com`                  | AAAA       | `2001:db8::10`                      | The same over IPv6. Add it only after an external port-25 test over IPv6 passes, even though `kasten dns` prints it |
| `mail.example.com`                | A          | `203.0.113.10`                      | The mail API: JMAP and sign-in on port 443. Stalwart's certificate covers this name and the MX name                 |
| `mail.example.com`                | AAAA       | `2001:db8::10`                      | The same over IPv6                                                                                                  |
| `app.example.com`                 | A or CNAME | The app host's address              | The web app. It must not point at the mail VPS                                                                      |
| `<token1>._domainkey.example.com` | CNAME      | `<token1>.dkim.amazonses.com`       | SES signs your mail with DKIM. This proves that your domain sent it                                                 |
| `<token2>._domainkey.example.com` | CNAME      | `<token2>.dkim.amazonses.com`       | The second of the three DKIM keys                                                                                   |
| `<token3>._domainkey.example.com` | CNAME      | `<token3>.dkim.amazonses.com`       | The third of the three DKIM keys                                                                                    |
| `example.com`                     | TXT        | `v=spf1 include:amazonses.com -all` | SPF: says that only SES sends mail for this domain                                                                  |
| `_dmarc.example.com`              | TXT        | `v=DMARC1; p=quarantine`            | DMARC: tells receivers to treat unsigned mail claiming to be from you as spam                                       |
| `example.com`                     | MX         | `10 mx.example.com.`                | Sends your incoming mail to the VPS. Change it last                                                                 |

Notes on the values:

- **The app name** can be on any domain. If your DNS host offers a proxy or CDN, for example Cloudflare's orange cloud, turn it off for this name. No third party may sit in the path of the code that handles your key. This keeps the DNS host off the normal path, but not out of reach: whoever controls the DNS account can point the name at another host or turn the proxy on. When another name in the zone is proxied, Cloudflare already holds a certificate that covers this name. Protect the DNS account like the app host ([who can read what](security.md#the-parts-and-who-can-read-what)).
- **DKIM.** `kasten dns` takes the target's domain from `dns.sesRegion`, following the "DKIM domains" table in AWS's [SES endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html#ses_dkim_domains), read on 4 November 2026. Most regions, `eu-central-1` among them, use `dkim.amazonses.com`. Eleven regions use their own, `dkim.<region>.amazonses.com`: `af-south-1`, `ap-northeast-3`, `ap-south-2`, `ap-southeast-3`, `ap-southeast-5`, `ca-west-1`, `eu-central-2`, `eu-south-1`, `il-central-1`, `me-central-1` and `us-gov-east-1`. SES can still show another domain for an identity (its `SigningHostedZone`). Compare the printed targets with the records that SES shows, and where they differ, use the one SES shows.
- **SPF.** `kasten dns` prints exactly `v=spf1 include:amazonses.com -all`. If anything else sends mail as your domain, add its `include:` to the same record. A domain has only one SPF record. With SES's default MAIL FROM, receivers check SPF on SES's own bounce domain; your mail passes DMARC through DKIM.
- **DMARC.** `kasten dns` takes the policy from `dns.dmarcPolicy` (`none`, `quarantine` or `reject`; `quarantine` by default). If another service sends as your domain and you have not checked its DKIM, start with `none` and change to `quarantine` later. To receive daily DMARC reports, set `dns.dmarcReportAddress`, for example to `dmarc@example.com`; the record then ends with `rua=mailto:dmarc@example.com`. Those reports arrive as normal mail.
- **IPv4 is required.** Many senders still reach mail servers only over IPv4.

## Optional records

`kasten dns` prints each of the first three records only when the `kasten.json` field in the last column is set. It does not print the PTR and CAA records.

| Name                     | Type | Example value                                    | Why                                                                                                                                                                                                                                     | `kasten.json`        |
| ------------------------ | ---- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `bounce.example.com`     | MX   | `10 feedback-smtp.eu-central-1.amazonses.com.`   | Custom MAIL FROM: bounces go to a subdomain of yours instead of `amazonses.com`. The region comes from `dns.sesRegion`. See [the AWS guide](aws-ses.md#5-optional-custom-mail-from)                                                     | `dns.customMailFrom` |
| `bounce.example.com`     | TXT  | `v=spf1 include:amazonses.com ~all`              | SPF for that MAIL FROM subdomain. SPF then aligns with your domain too                                                                                                                                                                  | `dns.customMailFrom` |
| `_smtp._tls.example.com` | TXT  | `v=TLSRPTv1; rua=mailto:tls-reports@example.com` | TLS-RPT: other mail servers report TLS failures when they deliver to you. The reports arrive as normal mail                                                                                                                             | `dns.tlsRptAddress`  |
| `203.0.113.10` (PTR)     | PTR  | `mx.example.com.`                                | Reverse DNS. Receiving does not need it, but it makes logs and tests clearer. Set it in the VPS provider's panel                                                                                                                        | none                 |
| `example.com`            | CAA  | `0 issue "letsencrypt.org"`                      | Only if you use CAA records already. They must allow the certificate authority of `http.acme.directory`. The example directory, `https://acme-v02.api.letsencrypt.org/directory`, is Let's Encrypt, whose CAA name is `letsencrypt.org` | none                 |

`dns.customMailFrom` is one label, for example `bounce`, and makes `bounce.example.com`.

## Records Kasten does not need

- SRV or autoconfig records for IMAP, POP or SMTP submission: those protocols are off.
- MTA-STS and BIMI.
- Any record at SES for receiving: SES only sends.

## Check the records

Run these from any computer, after the records are saved:

```sh
dig +short A mail.example.com
dig +short A mx.example.com
dig +short CNAME <token1>._domainkey.example.com
dig +short TXT example.com
dig +short TXT _dmarc.example.com
dig +short MX example.com
```

Each command prints the value you saved. SES shows the domain as verified when it finds all three DKIM records.

## Switching MX

1. One day before the switch, lower the TTL of the old MX record to 300 seconds.
2. On the day, replace the old MX value with `10 mx.example.com.`.
3. Keep the old provider's mailbox until the first day passes. If incoming mail fails, put the old MX value back.

[The install guide](install-vps.md#15-move-your-mail-in) has the full switch procedure.
