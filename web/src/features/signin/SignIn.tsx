import { actions } from "../../state/actions.ts";
import { useAppState } from "../../state/store.ts";
import { ErrorText, TaskScreen } from "../../ui/parts.tsx";

export function SignIn(props: { readonly message: string | null }) {
  const apiUrl = useAppState((state) => state.config?.apiUrl ?? "");
  const host = apiUrl === "" ? "your server" : new URL(apiUrl).host;

  return (
    <TaskScreen title="Sign in">
      <p>Your mail is stored encrypted on {host}. This device decrypts it.</p>
      <ErrorText text={props.message} />
      <button class="button primary wide" type="button" onClick={() => void actions.signIn()}>
        Sign in
      </button>
    </TaskScreen>
  );
}
