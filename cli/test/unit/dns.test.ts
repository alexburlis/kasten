import { describe, expect, it } from "vitest";

import { validateConfig } from "../../src/config.ts";
import { dnsZoneText } from "../../src/dns.ts";
import { isRecord } from "../../src/json.ts";
import { exampleConfigJson } from "./fixtures.ts";

import type { JsonRecord } from "../../src/json.ts";

function example(dns: JsonRecord = {}): string {
  const json = exampleConfigJson();
  const record = isRecord(json) ? json : {};
  const base = isRecord(record["dns"]) ? record["dns"] : {};

  return dnsZoneText(validateConfig({ ...record, dns: { ...base, ...dns } }, "/etc/kasten"));
}

/** The record lines only, with runs of spaces collapsed, so tests do not depend on column widths. */
function records(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith(";"))
    .map((line) => line.replace(/ +/gu, " "));
}

describe("dnsZoneText", () => {
  it("prints the host, SES, SPF, DMARC and MX records for the example config", () => {
    expect(records(example())).toEqual([
      "mx.example.com. 3600 IN A 203.0.113.10 ; MX host: other mail servers connect here on port 25; IPv4 is required",
      "mx.example.com. 3600 IN AAAA 2001:db8::10 ; MX host: other mail servers connect here on port 25 over IPv6",
      "mail.example.com. 3600 IN A 203.0.113.10 ; Mail API: JMAP and sign-in on port 443; IPv4 is required",
      "mail.example.com. 3600 IN AAAA 2001:db8::10 ; Mail API: JMAP and sign-in on port 443 over IPv6",
      "<SES DKIM token 1>._domainkey.example.com. 3600 IN CNAME <SES DKIM token 1>.dkim.amazonses.com. ; SES Easy DKIM: copy token 1 from the SES console",
      "<SES DKIM token 2>._domainkey.example.com. 3600 IN CNAME <SES DKIM token 2>.dkim.amazonses.com. ; SES Easy DKIM: copy token 2 from the SES console",
      "<SES DKIM token 3>._domainkey.example.com. 3600 IN CNAME <SES DKIM token 3>.dkim.amazonses.com. ; SES Easy DKIM: copy token 3 from the SES console",
      'example.com. 3600 IN TXT "v=spf1 include:amazonses.com -all" ; SPF: only SES sends for this domain',
      '_dmarc.example.com. 3600 IN TXT "v=DMARC1; p=quarantine" ; DMARC',
      "example.com. 3600 IN MX 10 mx.example.com. ; incoming mail goes to the VPS",
    ]);
  });

  it("puts the MX record last and says why", () => {
    const text = example();

    expect(text.indexOf("; MX: change these last")).toBeGreaterThan(
      text.indexOf("_dmarc.example.com."),
    );
    expect(text).toContain(
      "; app.example.com: the web app. Point it at the app host, never at the mail VPS",
    );
  });

  it("uses real DKIM tokens and the optional records when they are configured", () => {
    const lines = records(
      example({
        sesDkimTokens: {
          "example.com": [
            "abcdefghijklmnop0123456789abcdef",
            "bbcdefghijklmnop0123456789abcdef",
            "cbcdefghijklmnop0123456789abcdef",
          ],
        },
        customMailFrom: "bounce",
        tlsRptAddress: "tls-reports@example.com",
        dmarcPolicy: "reject",
        dmarcReportAddress: "dmarc@example.com",
        ttl: 300,
      }),
    );

    expect(lines).toContain(
      "abcdefghijklmnop0123456789abcdef._domainkey.example.com. 300 IN CNAME abcdefghijklmnop0123456789abcdef.dkim.amazonses.com. ; SES Easy DKIM 1 of 3",
    );
    expect(lines).toContain(
      "bounce.example.com. 300 IN MX 10 feedback-smtp.eu-central-1.amazonses.com. ; SES custom MAIL FROM: bounces come back to SES",
    );
    expect(lines).toContain(
      'bounce.example.com. 300 IN TXT "v=spf1 include:amazonses.com ~all" ; SPF for the custom MAIL FROM',
    );
    expect(lines).toContain(
      '_smtp._tls.example.com. 300 IN TXT "v=TLSRPTv1; rua=mailto:tls-reports@example.com" ; Optional TLS-RPT: senders report TLS failures to this address',
    );
    expect(lines).toContain(
      '_dmarc.example.com. 300 IN TXT "v=DMARC1; p=reject; rua=mailto:dmarc@example.com" ; DMARC',
    );
  });

  it("points the DKIM CNAMEs at dkim.amazonses.com in eu-central-1", () => {
    const lines = records(example({ sesRegion: "eu-central-1" }));

    expect(lines.filter((line) => line.includes(" CNAME "))).toEqual(
      [1, 2, 3].map(
        (n) =>
          `<SES DKIM token ${n}>._domainkey.example.com. 3600 IN CNAME <SES DKIM token ${n}>.dkim.amazonses.com. ; SES Easy DKIM: copy token ${n} from the SES console`,
      ),
    );
  });

  it("points the DKIM CNAMEs at the region's own domain in a region that has one", () => {
    for (const region of ["eu-central-2", "af-south-1", "us-gov-east-1"]) {
      const lines = records(example({ sesRegion: region }));

      expect(lines, region).toContain(
        `<SES DKIM token 1>._domainkey.example.com. 3600 IN CNAME <SES DKIM token 1>.dkim.${region}.amazonses.com. ; SES Easy DKIM: copy token 1 from the SES console`,
      );
    }

    expect(records(example({ sesRegion: "us-gov-west-1" }))).toContain(
      "<SES DKIM token 1>._domainkey.example.com. 3600 IN CNAME <SES DKIM token 1>.dkim.amazonses.com. ; SES Easy DKIM: copy token 1 from the SES console",
    );
  });

  it("tells the reader that the target SES shows for the identity wins", () => {
    expect(example()).toContain(
      "; SES Easy DKIM: the CNAME targets follow AWS's region table. Where SES shows another target for a token, use that one.",
    );
  });

  it("prints a placeholder when the VPS address is unknown, and no AAAA without IPv6", () => {
    const lines = records(example({ ipv4: null, ipv6: null }));

    expect(lines).toContain(
      "mx.example.com. 3600 IN A <VPS IPv4 address> ; MX host: other mail servers connect here on port 25; IPv4 is required",
    );
    expect(lines.some((line) => line.includes(" AAAA "))).toBe(false);
  });
});
