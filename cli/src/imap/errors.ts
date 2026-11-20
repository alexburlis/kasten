// IMAP failures. The import engine decides which of them are worth a retry.

/** The connection failed, closed, timed out or said BYE. A new connection may succeed. */
export class ImapConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapConnectionError";
  }
}

/** The server sent something this client cannot parse. Retrying would not help. */
export class ImapProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapProtocolError";
  }
}

/** A tagged NO or BAD, or an untagged BYE greeting. `code` is the response code name, if any. */
export class ImapStatusError extends Error {
  readonly status: string;
  readonly code: string | null;
  readonly text: string;
  readonly command: string;

  constructor(command: string, status: string, code: string | null, text: string) {
    super(`${command}: ${status}${code === null ? "" : ` [${code}]`} ${text}`.trim());
    this.name = "ImapStatusError";
    this.command = command;
    this.status = status;
    this.code = code;
    this.text = text;
  }
}

/** A certificate or other TLS failure. Never retried, never weakened. */
export class ImapTlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapTlsError";
  }
}
