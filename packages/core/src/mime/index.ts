export {
  buildMessage,
  type BuiltMessage,
  type Draft,
  type DraftAttachment,
  type RandomSource,
} from "./build.ts";

export { formatAddress, formatDate, KastenMimeError, type MailAddress } from "./encode.ts";

export {
  messageIds,
  parseMessage,
  replyReferences,
  type ParsedAddress,
  type ParsedAttachment,
  type ParsedHeader,
  type ParsedMessage,
  type ReplyReferences,
} from "./parse.ts";

export {
  attachmentName,
  parseMediaType,
  partBody,
  partBytes,
  partText,
  readHeaders,
  readMime,
  type HeaderField,
  type MediaType,
  type MimePart,
  type MimeTree,
  type PartKind,
} from "./structure.ts";
