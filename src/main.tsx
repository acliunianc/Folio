import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import RailWindow from "./RailWindow";
import "./index.css";

const label = "__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "main";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{label === "rail" || label === "rail-panel" ? <RailWindow /> : <App />}</React.StrictMode>,
);
