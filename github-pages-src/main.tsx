import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PosterStudio } from "../app/poster-studio";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("页面挂载节点不存在");
}

createRoot(root).render(
  <StrictMode>
    <PosterStudio />
  </StrictMode>,
);
