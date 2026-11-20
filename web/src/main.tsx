import "./lib/zod-config.ts";
import "./styles/app.css";

import { render } from "preact";

import { App } from "./app/App.tsx";
import { actions } from "./state/actions.ts";

const root = document.getElementById("app");

if (root !== null) {
  render(<App />, root);
  void actions.boot();
}
