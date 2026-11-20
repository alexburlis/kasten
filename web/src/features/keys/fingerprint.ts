// Pure helpers for showing a key and asking the operator to install it, with no app state, so
// unit tests can import them.

/** 40 hex digits in groups of four, as GnuPG prints them. */
export function formatFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{1,4}/gu) ?? []).join(" ");
}

/**
 * What the operator needs to install a key made on this device after `kasten lock`: the account,
 * the fingerprint, and one block to paste into a root shell on the server, with the commands of
 * "Rotate your mail key" in docs/operations.md and the public key in a here-document.
 */
export function operatorRequest(account: string, fingerprint: string, publicKey: string): string {
  const spaced = formatFingerprint(fingerprint);

  return [
    `Please install my new Kasten mail key for ${account}.`,
    "",
    `Fingerprint: ${spaced}`,
    "",
    "On the server, paste this block into a root shell:",
    "",
    "setpriv --reuid=kasten --regid=kasten --init-groups sh -c 'umask 077 && cat >/var/lib/kasten/cli/new-key.pub.asc' <<'KASTEN_KEY'",
    publicKey.trim(),
    "KASTEN_KEY",
    `kasten-cli keys set --account ${account} --key /etc/kasten/new-key.pub.asc --config /etc/kasten/kasten.json`,
    `kasten-cli lock --account ${account} --user-fingerprint "${spaced}" --config /etc/kasten/kasten.json`,
    "",
  ].join("\n");
}
