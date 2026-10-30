import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./ui/App";
import ModelsWindow from "./ui/config/ModelsWindow";
import SettingsWindow from "./ui/config/SettingsWindow";
import HelpPage from "./ui/pages/HelpPage";
import "./ui/styles.css";

function Root() {
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  if (hash.startsWith("#/config/models")) return <ModelsWindow />;
  if (hash.startsWith("#/config/settings")) return <SettingsWindow />;
  if (hash.startsWith("#/help")) return <HelpPage />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
