import type { Metadata } from "next";
import { PosterStudio } from "./poster-studio";

export const metadata: Metadata = {
  title: "印准 · 海报印前修复",
  description: "拖入海报，检查清晰度、修复局部并导出印刷文件。",
};

export default function Home() {
  return <PosterStudio />;
}
