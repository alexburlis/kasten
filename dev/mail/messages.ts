// The test messages that `./kasten dev mail` delivers: an attachment, a non-ASCII subject and sender,
// an HTML message with remote images (to test blocking) and a three-message thread. Every run gets
// new Message-IDs, so running it again adds new mail instead of duplicates.
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

import {
  attachmentPart,
  mailbox,
  messageDate,
  multipart,
  newMessageId,
  renderMessage,
  textPart,
  encodedWords,
} from "../lib/mime.ts";

import type { Header } from "../lib/mime.ts";

export interface DevMessage {
  readonly label: string;
  readonly from: string;
  readonly messageId: string;
  readonly raw: string;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
}

/** A 48x48 picture of a closed box, as a PNG. */
export function boxPng(): Buffer {
  const size = 48;
  const rows: Buffer[] = [];

  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);

    for (let x = 0; x < size; x += 1) {
      const edge = x < 6 || x >= size - 6 || y < 6 || y >= size - 6;
      const lid = y >= 14 && y < 18;
      const [r, g, b] = edge || lid ? [31, 58, 95] : [242, 201, 76];
      row.writeUInt8(r, 1 + x * 3);
      row.writeUInt8(g, 2 + x * 3);
      row.writeUInt8(b, 3 + x * 3);
    }

    rows.push(row);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PACKING_LIST = `Packing list for Saturday
- Water, 2 litres each
- Rain jacket
- Snacks: Müsli bars, dried mango
- Map (the trail forks after the café)
`;

const NEWSLETTER_HTML = `<!doctype html>
<html><body style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto;">
<h1>This week on the trail</h1>
<p><img src="https://images.trail-weekly.example.test/hero-sunrise.jpg" width="600" height="300"
  alt="A mountain trail at sunrise"></p>
<p>Three routes for short autumn days, a gear check, and a reader's photo of the week.</p>
<p><a href="https://trail-weekly.example.test/autumn-routes">Read the routes</a></p>
<p><img src="https://images.trail-weekly.example.test/reader-photo.jpg" width="300" height="200"
  alt="Reader's photo: a lake below a ridge"></p>
<img src="https://track.trail-weekly.example.test/open.gif?r=dev" width="1" height="1" alt="">
</body></html>
`;

const NEWSLETTER_TEXT = `This week on the trail

Three routes for short autumn days, a gear check, and a reader's photo of the week.
Read the routes: https://trail-weekly.example.test/autumn-routes
`;

function headers(
  from: string,
  to: readonly string[],
  subject: string,
  date: Date,
  messageId: string,
): Header[] {
  return [
    ["From", from],
    ["To", to.join(", ")],
    ["Subject", encodedWords(subject)],
    ["Date", messageDate(date)],
    ["Message-ID", `<${messageId}>`],
  ];
}

/** The dev messages for `to`, dated relative to `now`. */
export function devMessages(to: string, now: Date): DevMessage[] {
  const minutes = (n: number): Date => new Date(now.getTime() - n * 60_000);
  const id = (prefix: string): string => newMessageId("example.test", prefix);
  const tag = randomBytes(2).toString("hex");

  const alex = mailbox("Alex Rivera", "alex.rivera@example.test");
  const priya = mailbox("Priya Shah", "priya@example.test");
  const hike = `Weekend hike? (${tag})`;
  const [m1, m2, m3] = [id("hike-1"), id("hike-2"), id("hike-3")];
  const message: DevMessage[] = [];

  message.push({
    label: "thread 1 of 3",
    from: "alex.rivera@example.test",
    messageId: m1,
    raw: renderMessage(
      [...headers(alex, [to], hike, minutes(180), m1), ["Cc", priya]],
      textPart(
        "Hi both,\n\nShall we do the ridge loop on Saturday? Start at 9 from the car park.\n\nAlex\n",
      ),
    ),
  });

  message.push({
    label: "thread 2 of 3",
    from: "priya@example.test",
    messageId: m2,
    raw: renderMessage(
      [
        ...headers(priya, [alex], `Re: ${hike}`, minutes(120), m2),
        ["Cc", to],
        ["In-Reply-To", `<${m1}>`],
        ["References", `<${m1}>`],
      ],
      textPart(
        "Yes please! 9 works. I'll bring the map.\n\nPriya\n\n> Shall we do the ridge loop?\n",
      ),
    ),
  });

  message.push({
    label: "thread 3 of 3",
    from: "alex.rivera@example.test",
    messageId: m3,
    raw: renderMessage(
      [
        ...headers(alex, [priya, to], `Re: ${hike}`, minutes(60), m3),
        ["In-Reply-To", `<${m2}>`],
        ["References", `<${m1}> <${m2}>`],
      ],
      textPart("Great, see you both at 9. Bring a rain jacket, just in case.\n\nAlex\n"),
    ),
  });

  const photosId = id("attachment");
  message.push({
    label: "attachments (PNG and text)",
    from: "nadia@example.test",
    messageId: photosId,
    raw: renderMessage(
      headers(
        mailbox("Nadia Okafor", "nadia@example.test"),
        [to],
        "The box logo and the packing list",
        minutes(50),
        photosId,
      ),
      multipart("mixed", [
        textPart("Hi,\n\nHere are the box logo and the packing list for Saturday.\n\nNadia\n"),
        attachmentPart("kasten-box.png", "image/png", boxPng()),
        attachmentPart(
          "packing-list.txt",
          "text/plain; charset=utf-8",
          Buffer.from(PACKING_LIST, "utf8"),
        ),
      ]),
    ),
  });

  const umlautId = id("utf8");
  message.push({
    label: "non-ASCII subject and sender",
    from: "juergen.mueller@example.test",
    messageId: umlautId,
    raw: renderMessage(
      headers(
        mailbox("Jürgen Müller", "juergen.mueller@example.test"),
        [to],
        "Grüße aus Köln: Café, Übersicht und 日本の写真 ☕",
        minutes(30),
        umlautId,
      ),
      textPart(
        "Hallo!\n\nViele Grüße aus Köln. Die Übersicht kommt morgen, versprochen.\n" +
          "Und die Fotos aus Japan: 東京の朝 🌅\n\nBis bald,\nJürgen\n",
      ),
    ),
  });

  const newsId = id("newsletter");
  message.push({
    label: "HTML with remote images",
    from: "news@trail-weekly.example.test",
    messageId: newsId,
    raw: renderMessage(
      headers(
        mailbox("Trail Weekly", "news@trail-weekly.example.test"),
        [to],
        "This week on the trail",
        minutes(10),
        newsId,
      ),
      multipart("alternative", [textPart(NEWSLETTER_TEXT), textPart(NEWSLETTER_HTML, "html")]),
    ),
  });

  return message;
}
