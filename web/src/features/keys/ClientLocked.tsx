// After `kasten lock`, this app may read mail but may not change the key set or MFA. A device
// without a key restores it from the recovery sheet; a key made here has to be installed by the
// operator, with `kasten-cli keys set` and `kasten-cli lock`.
import { actions } from "../../state/actions.ts";
import { useAppState } from "../../state/store.ts";
import { TaskScreen } from "../../ui/parts.tsx";
import { formatFingerprint, operatorRequest } from "./fingerprint.ts";

export function ClientLocked(props: {
  readonly publicKey: string | null;
  readonly fingerprint: string | null;
}) {
  const account = useAppState((state) => state.account?.username ?? "");

  if (props.publicKey === null || props.fingerprint === null) {
    return (
      <TaskScreen title="Add your mail key to this device">
        <p>
          Restore it from the recovery sheet you printed when you made it. New to Kasten, or lost
          your sheet? Make a new key, and your server's operator installs it.
        </p>
        <div class="task-buttons">
          <button class="button primary wide" type="button" onClick={() => actions.startRestore()}>
            Restore from recovery sheet
          </button>
          <button class="button wide" type="button" onClick={() => actions.startCreateKey()}>
            Make a new key
          </button>
        </div>
      </TaskScreen>
    );
  }

  const request = operatorRequest(account, props.fingerprint, props.publicKey);

  return (
    <TaskScreen title="Get your new key installed">
      <p>
        Your server lets only its operator install a new key. Copy the request and send it to them.
        Until it's installed, new mail is not encrypted to this key.
      </p>
      <p>
        Fingerprint: <span class="mono fingerprint">{formatFingerprint(props.fingerprint)}</span>
      </p>
      <pre class="mono public-key" data-testid="public-key">
        {props.publicKey.trim()}
      </pre>
      <div class="task-buttons">
        <button
          class="button wide"
          type="button"
          onClick={() => void navigator.clipboard.writeText(request)}
        >
          Copy request for your operator
        </button>
        <button
          class="button primary wide"
          type="button"
          onClick={() => void actions.confirmKeyInstalled()}
        >
          It's installed
        </button>
        <button class="button wide" type="button" onClick={() => actions.startRestore()}>
          Use my existing key instead
        </button>
      </div>
    </TaskScreen>
  );
}
