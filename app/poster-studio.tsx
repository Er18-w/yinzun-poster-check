"use client";

import { PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Tool = "select" | "ocr" | "repair" | "text" | "enhance";
type Rect = { x: number; y: number; w: number; h: number };
type OcrBox = Rect & { text: string; confidence: number };
type ImageInfo = { name: string; width: number; height: number; size: number };
type Frame = { pixels: ImageData };

const PRINT_PRESETS = {
  A4: { label: "A4 · 210 × 297 mm", width: 210, height: 297 },
  A3: { label: "A3 · 297 × 420 mm", width: 297, height: 420 },
  A2: { label: "A2 · 420 × 594 mm", width: 420, height: 594 },
  square: { label: "方形 · 300 × 300 mm", width: 300, height: 300 },
  custom: { label: "自定义尺寸", width: 297, height: 420 },
} as const;

const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: "select", icon: "⌖", label: "选择" },
  { id: "ocr", icon: "文", label: "验字" },
  { id: "repair", icon: "✦", label: "修复" },
  { id: "text", icon: "T", label: "换字" },
  { id: "enhance", icon: "◐", label: "增强" },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizedRect(start: { x: number; y: number }, end: { x: number; y: number }): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y),
  };
}

function safeRect(rect: Rect, canvas: HTMLCanvasElement): Rect {
  const x = clamp(Math.round(rect.x), 0, canvas.width - 1);
  const y = clamp(Math.round(rect.y), 0, canvas.height - 1);
  return {
    x,
    y,
    w: clamp(Math.round(rect.w), 1, canvas.width - x),
    h: clamp(Math.round(rect.h), 1, canvas.height - y),
  };
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("无法生成导出文件"))), type, quality);
  });
}

function fillFromEdges(context: CanvasRenderingContext2D, target: Rect) {
  const canvas = context.canvas;
  const rect = safeRect(target, canvas);
  const left = Math.max(0, rect.x - 1);
  const top = Math.max(0, rect.y - 1);
  const right = Math.min(canvas.width - 1, rect.x + rect.w);
  const bottom = Math.min(canvas.height - 1, rect.y + rect.h);
  const source = context.getImageData(left, top, right - left + 1, bottom - top + 1);
  const output = context.createImageData(rect.w, rect.h);
  const sw = source.width;

  const pixel = (sx: number, sy: number, channel: number) => source.data[(sy * sw + sx) * 4 + channel];
  const hasLeft = rect.x > 0;
  const hasTop = rect.y > 0;
  const leftX = hasLeft ? 0 : Math.min(1, sw - 1);
  const rightX = sw - 1;
  const topY = hasTop ? 0 : Math.min(1, source.height - 1);
  const bottomY = source.height - 1;

  for (let y = 0; y < rect.h; y += 1) {
    const v = rect.h === 1 ? 0.5 : y / (rect.h - 1);
    const sy = clamp(y + (hasTop ? 1 : 0), 0, source.height - 1);
    for (let x = 0; x < rect.w; x += 1) {
      const u = rect.w === 1 ? 0.5 : x / (rect.w - 1);
      const sx = clamp(x + (hasLeft ? 1 : 0), 0, sw - 1);
      const index = (y * rect.w + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const horizontal = pixel(leftX, sy, channel) * (1 - u) + pixel(rightX, sy, channel) * u;
        const vertical = pixel(sx, topY, channel) * (1 - v) + pixel(sx, bottomY, channel) * v;
        output.data[index + channel] = Math.round((horizontal + vertical) / 2);
      }
      output.data[index + 3] = 255;
    }
  }
  context.putImageData(output, rect.x, rect.y);
}

function sharpenRegion(context: CanvasRenderingContext2D, target: Rect, amount = 0.48) {
  const rect = safeRect(target, context.canvas);
  const image = context.getImageData(rect.x, rect.y, rect.w, rect.h);
  const source = new Uint8ClampedArray(image.data);
  const width = rect.w;
  const height = rect.h;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const sharp = source[index + channel] * 5
          - source[index - 4 + channel]
          - source[index + 4 + channel]
          - source[index - width * 4 + channel]
          - source[index + width * 4 + channel];
        image.data[index + channel] = clamp(Math.round(source[index + channel] * (1 - amount) + sharp * amount), 0, 255);
      }
    }
  }
  context.putImageData(image, rect.x, rect.y);
}

function drawFittedText(
  context: CanvasRenderingContext2D,
  rect: Rect,
  text: string,
  options: { fontSize: number; family: string; color: string; weight: string; align: CanvasTextAlign },
) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return;
  let fontSize = options.fontSize;
  const setFont = () => { context.font = `${options.weight} ${fontSize}px ${options.family}`; };
  setFont();
  const widest = Math.max(...lines.map((line) => context.measureText(line).width));
  if (widest > rect.w * 0.92) {
    fontSize = Math.max(6, fontSize * ((rect.w * 0.92) / widest));
    setFont();
  }
  const lineHeight = fontSize * 1.22;
  const totalHeight = lineHeight * lines.length;
  const startY = rect.y + (rect.h - totalHeight) / 2 + lineHeight * 0.78;
  const x = options.align === "left" ? rect.x + rect.w * 0.04 : options.align === "right" ? rect.x + rect.w * 0.96 : rect.x + rect.w / 2;
  context.save();
  context.beginPath();
  context.rect(rect.x, rect.y, rect.w, rect.h);
  context.clip();
  context.fillStyle = options.color;
  context.textAlign = options.align;
  context.textBaseline = "alphabetic";
  lines.forEach((line, index) => context.fillText(line, x, startY + index * lineHeight));
  context.restore();
}

export function PosterStudio() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const originalRef = useRef<ImageData | null>(null);
  const undoRef = useRef<Frame[]>([]);
  const redoRef = useRef<Frame[]>([]);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const [image, setImage] = useState<ImageInfo | null>(null);
  const [activeTool, setActiveTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Rect | null>(null);
  const [draftSelection, setDraftSelection] = useState<Rect | null>(null);
  const [ocrBoxes, setOcrBoxes] = useState<OcrBox[]>([]);
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const [ocrSummary, setOcrSummary] = useState("尚未检查文字");
  const [preset, setPreset] = useState<keyof typeof PRINT_PRESETS>("A3");
  const [printWidth, setPrintWidth] = useState(297);
  const [printHeight, setPrintHeight] = useState(420);
  const [targetDpi, setTargetDpi] = useState(300);
  const [replaceText, setReplaceText] = useState("");
  const [fontSize, setFontSize] = useState(72);
  const [fontFamily, setFontFamily] = useState('"Microsoft YaHei","PingFang SC",sans-serif');
  const [fontWeight, setFontWeight] = useState("700");
  const [textColor, setTextColor] = useState("#171b16");
  const [textAlign, setTextAlign] = useState<CanvasTextAlign>("center");
  const [coverColor, setCoverColor] = useState("#ffffff");
  const [fitMode, setFitMode] = useState<"contain" | "cover">("contain");
  const [showExport, setShowExport] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [notice, setNotice] = useState("拖入海报开始检查");
  const [busy, setBusy] = useState(false);

  const effectiveDpi = useMemo(() => {
    if (!image || printWidth <= 0 || printHeight <= 0) return 0;
    return Math.round(Math.min(image.width / (printWidth / 25.4), image.height / (printHeight / 25.4)));
  }, [image, printHeight, printWidth]);

  const quality = effectiveDpi >= 300
    ? { label: "适合精细印刷", tone: "good", score: 96 }
    : effectiveDpi >= 220
      ? { label: "基本可印，建议远观", tone: "fair", score: 78 }
      : effectiveDpi > 0
        ? { label: "清晰度不足", tone: "bad", score: Math.max(28, Math.round(effectiveDpi / 3)) }
        : { label: "等待图片", tone: "waiting", score: 0 };

  const aspectMismatch = useMemo(() => {
    if (!image) return false;
    return Math.abs((image.width / image.height) / (printWidth / printHeight) - 1) > 0.025;
  }, [image, printHeight, printWidth]);

  const setCanvasPixels = useCallback((pixels: ImageData) => {
    canvasRef.current?.getContext("2d", { willReadFrequently: true })?.putImageData(pixels, 0, 0);
    setHistoryVersion((value) => value + 1);
  }, []);

  const pushHistory = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    undoRef.current.push({ pixels: context.getImageData(0, 0, canvas.width, canvas.height) });
    if (undoRef.current.length > 8) undoRef.current.shift();
    redoRef.current = [];
    setHistoryVersion((value) => value + 1);
  }, []);

  const undo = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    const previous = undoRef.current.pop();
    if (!canvas || !context || !previous) return;
    redoRef.current.push({ pixels: context.getImageData(0, 0, canvas.width, canvas.height) });
    setCanvasPixels(previous.pixels);
    setNotice("已撤销上一步");
  }, [setCanvasPixels]);

  const redo = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    const next = redoRef.current.pop();
    if (!canvas || !context || !next) return;
    undoRef.current.push({ pixels: context.getImageData(0, 0, canvas.width, canvas.height) });
    setCanvasPixels(next.pixels);
    setNotice("已恢复上一步");
  }, [setCanvasPixels]);

  const drawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const context = overlay.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, overlay.width, overlay.height);
    ocrBoxes.forEach((box) => {
      const risky = box.confidence < 82 || /[□�]/.test(box.text);
      context.fillStyle = risky ? "rgba(255, 104, 67, .16)" : "rgba(199, 255, 66, .10)";
      context.strokeStyle = risky ? "#ff6843" : "#99c927";
      context.lineWidth = Math.max(2, overlay.width / 1200);
      context.fillRect(box.x, box.y, box.w, box.h);
      context.strokeRect(box.x, box.y, box.w, box.h);
    });
    const rect = draftSelection || selection;
    if (rect) {
      context.save();
      context.fillStyle = "rgba(199, 255, 66, .13)";
      context.strokeStyle = "#c7ff42";
      context.lineWidth = Math.max(3, overlay.width / 900);
      context.setLineDash([Math.max(8, overlay.width / 170), Math.max(5, overlay.width / 260)]);
      context.fillRect(rect.x, rect.y, rect.w, rect.h);
      context.strokeRect(rect.x, rect.y, rect.w, rect.h);
      context.restore();
    }
  }, [draftSelection, ocrBoxes, selection]);

  useEffect(() => { drawOverlay(); }, [drawOverlay, historyVersion]);

  const acceptFile = useCallback(async (file?: File) => {
    if (!file || !file.type.startsWith("image/")) {
      setNotice("请选择 JPG、PNG 或 WebP 图片");
      return;
    }
    setBusy(true);
    const url = URL.createObjectURL(file);
    const source = new Image();
    source.onload = () => {
      const canvas = canvasRef.current;
      const overlay = overlayRef.current;
      const context = canvas?.getContext("2d", { willReadFrequently: true });
      if (!canvas || !overlay || !context) return;
      canvas.width = source.naturalWidth;
      canvas.height = source.naturalHeight;
      overlay.width = source.naturalWidth;
      overlay.height = source.naturalHeight;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0);
      originalRef.current = context.getImageData(0, 0, canvas.width, canvas.height);
      undoRef.current = [];
      redoRef.current = [];
      setImage({ name: file.name, width: source.naturalWidth, height: source.naturalHeight, size: file.size });
      setSelection(null);
      setOcrBoxes([]);
      setOcrSummary("尚未检查文字");
      setNotice(`已读取 ${source.naturalWidth} × ${source.naturalHeight} px`);
      setBusy(false);
      URL.revokeObjectURL(url);
    };
    source.onerror = () => {
      setNotice("图片读取失败，请尝试转换为 PNG 或 JPG");
      setBusy(false);
      URL.revokeObjectURL(url);
    };
    source.src = url;
  }, []);

  const canvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const overlay = overlayRef.current;
    if (!overlay) return { x: 0, y: 0 };
    const bounds = overlay.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) * (overlay.width / bounds.width), 0, overlay.width),
      y: clamp((event.clientY - bounds.top) * (overlay.height / bounds.height), 0, overlay.height),
    };
  };

  const startSelection = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!image) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = canvasPoint(event);
    dragStartRef.current = point;
    setDraftSelection({ x: point.x, y: point.y, w: 0, h: 0 });
  };

  const moveSelection = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!dragStartRef.current) return;
    setDraftSelection(normalizedRect(dragStartRef.current, canvasPoint(event)));
  };

  const endSelection = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!dragStartRef.current) return;
    const rect = normalizedRect(dragStartRef.current, canvasPoint(event));
    dragStartRef.current = null;
    setDraftSelection(null);
    if (rect.w > 5 && rect.h > 5) {
      setSelection(rect);
      setNotice("区域已框选，可进行局部修复或换字");
    }
  };

  const runOcr = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !image || ocrProgress !== null) return;
    setActiveTool("ocr");
    setOcrProgress(0);
    setOcrSummary("正在加载中文识别模型…");
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker(["chi_sim", "eng"], undefined, {
        logger: (message) => {
          if (typeof message.progress === "number") setOcrProgress(Math.round(message.progress * 100));
          if (message.status.includes("recognizing")) setOcrSummary("正在逐行核对海报文字…");
        },
      });
      const result = await worker.recognize(canvas, {}, { text: true, blocks: true });
      await worker.terminate();
      const words: OcrBox[] = [];
      result.data.blocks?.forEach((block) => block.paragraphs.forEach((paragraph) => paragraph.lines.forEach((line) => line.words.forEach((word) => {
        if (!word.text.trim()) return;
        words.push({
          x: word.bbox.x0,
          y: word.bbox.y0,
          w: word.bbox.x1 - word.bbox.x0,
          h: word.bbox.y1 - word.bbox.y0,
          text: word.text.trim(),
          confidence: word.confidence,
        });
      }))));
      setOcrBoxes(words);
      const risky = words.filter((word) => word.confidence < 82 || /[□�]/.test(word.text));
      setOcrSummary(words.length ? `识别 ${words.length} 处文字，${risky.length} 处建议人工确认` : "没有可靠识别到文字，请手动框选检查");
      setNotice("验字完成：橙色框优先检查，绿色框也可点击核对");
    } catch (error) {
      setOcrSummary("文字模型加载失败；仍可手动框选并替换坏字");
      setNotice(error instanceof Error ? error.message : "文字识别失败");
    } finally {
      setOcrProgress(null);
    }
  };

  const repairSelection = (mode: "edge" | "color") => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context || !selection) {
      setNotice("请先在海报上框选需要修复的区域");
      return;
    }
    pushHistory();
    const rect = safeRect(selection, canvas);
    if (mode === "edge") fillFromEdges(context, rect);
    else { context.fillStyle = coverColor; context.fillRect(rect.x, rect.y, rect.w, rect.h); }
    setOcrBoxes([]);
    setNotice(mode === "edge" ? "已使用四周纹理局部填补" : "已用纯色覆盖选区");
    setHistoryVersion((value) => value + 1);
  };

  const applyText = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context || !selection || !replaceText.trim()) {
      setNotice("请先框选坏字区域，并输入正确文字");
      return;
    }
    pushHistory();
    const rect = safeRect(selection, canvas);
    fillFromEdges(context, rect);
    drawFittedText(context, rect, replaceText, { fontSize, family: fontFamily, color: textColor, weight: fontWeight, align: textAlign });
    setOcrBoxes([]);
    setNotice("文字已局部替换，海报其余部分保持不变");
    setHistoryVersion((value) => value + 1);
  };

  const applySharpen = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    const rect = selection ? safeRect(selection, canvas) : { x: 0, y: 0, w: canvas.width, h: canvas.height };
    if (rect.w * rect.h > 24_000_000) {
      setNotice("整张图较大，请先框选需要增强的区域");
      return;
    }
    pushHistory();
    sharpenRegion(context, rect);
    setNotice(selection ? "已增强选区边缘清晰度" : "已轻度增强整张海报");
    setHistoryVersion((value) => value + 1);
  };

  const resetImage = () => {
    if (!originalRef.current) return;
    pushHistory();
    setCanvasPixels(originalRef.current);
    setSelection(null);
    setOcrBoxes([]);
    setNotice("已恢复最初导入的图片");
  };

  const exportCanvas = () => {
    const source = canvasRef.current;
    if (!source) throw new Error("请先导入海报");
    const width = Math.round((printWidth / 25.4) * targetDpi);
    const height = Math.round((printHeight / 25.4) * targetDpi);
    if (width * height > 80_000_000 || width > 16_000 || height > 16_000) throw new Error("导出尺寸过大，请降低 DPI 或成品尺寸");
    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const context = output.getContext("2d");
    if (!context) throw new Error("浏览器无法创建导出画布");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const scale = fitMode === "cover" ? Math.max(width / source.width, height / source.height) : Math.min(width / source.width, height / source.height);
    const drawWidth = source.width * scale;
    const drawHeight = source.height * scale;
    context.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return output;
  };

  const exportPng = async () => {
    setBusy(true);
    try {
      const output = exportCanvas();
      const blob = await canvasToBlob(output, "image/png");
      downloadBlob(blob, `${image?.name.replace(/\.[^.]+$/, "") || "poster"}-${printWidth}x${printHeight}mm-${targetDpi}dpi.png`);
      setNotice("高分辨率 PNG 已导出");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导出失败");
    } finally { setBusy(false); }
  };

  const exportPdf = async () => {
    setBusy(true);
    try {
      const output = exportCanvas();
      const jpg = await canvasToBlob(output, "image/jpeg", 0.98);
      const { PDFDocument } = await import("pdf-lib");
      const document = await PDFDocument.create();
      document.setTitle(image?.name || "印刷海报");
      document.setProducer("印准 · 海报印前修复台");
      const pageWidth = printWidth * 72 / 25.4;
      const pageHeight = printHeight * 72 / 25.4;
      const page = document.addPage([pageWidth, pageHeight]);
      const embedded = await document.embedJpg(await jpg.arrayBuffer());
      page.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
      const bytes = await document.save();
      const pdfBlob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
      downloadBlob(pdfBlob, `${image?.name.replace(/\.[^.]+$/, "") || "poster"}-${printWidth}x${printHeight}mm.pdf`);
      setNotice("精确成品尺寸 PDF 已导出");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PDF 导出失败");
    } finally { setBusy(false); }
  };

  const choosePreset = (key: keyof typeof PRINT_PRESETS) => {
    setPreset(key);
    if (key !== "custom") {
      setPrintWidth(PRINT_PRESETS[key].width);
      setPrintHeight(PRINT_PRESETS[key].height);
    }
  };

  const selectOcrBox = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragStartRef.current || activeTool !== "ocr") return;
    const point = canvasPoint(event);
    const box = [...ocrBoxes].reverse().find((item) => point.x >= item.x && point.x <= item.x + item.w && point.y >= item.y && point.y <= item.y + item.h);
    if (box) {
      setSelection(box);
      setReplaceText(box.text);
      setFontSize(Math.max(12, Math.round(box.h * 0.82)));
      setActiveTool("text");
      setNotice(`已选中“${box.text}”，可在右侧校正`);
    }
  };

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">印</div>
        <div className="brand-copy"><strong>印准</strong><span>海报印前修复台</span></div>
        <div className="history-controls">
          <button type="button" onClick={undo} disabled={!undoRef.current.length} title="撤销">↶</button>
          <button type="button" onClick={redo} disabled={!redoRef.current.length} title="重做">↷</button>
        </div>
        <div className="privacy-note"><i /> 图片仅在当前浏览器处理</div>
        <button className="ghost-button" type="button" onClick={() => setShowHelp(true)}>使用说明</button>
        <button className="export-button" type="button" disabled={!image || busy} onClick={() => setShowExport(true)}>导出印刷文件</button>
      </header>

      <section className="stage-layout">
        <aside className="toolrail" aria-label="修复工具">
          {TOOLS.map((tool) => (
            <button key={tool.id} className={`tool ${activeTool === tool.id ? "active" : ""}`} type="button" disabled={!image} onClick={() => { setActiveTool(tool.id); if (tool.id === "ocr") void runOcr(); }}>
              <b>{tool.icon}</b><span>{tool.label}</span>
            </button>
          ))}
        </aside>

        <section className="workspace">
          <div className="workspace-heading">
            <div><span className="eyebrow">工作区</span><h1>{image?.name || "新建印前检查"}</h1></div>
            {image && <div className="image-meta"><span>{image.width} × {image.height} px</span><span>{(image.size / 1024 / 1024).toFixed(1)} MB</span></div>}
          </div>

          {!image && (
            <label className="dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void acceptFile(event.dataTransfer.files[0]); }}>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void acceptFile(event.target.files?.[0])} />
              <div className="drop-visual" aria-hidden="true"><span /><span /><span /></div>
              <strong>把海报拖到这里</strong>
              <p>支持 JPG、PNG、WebP，建议保留原始大图</p>
              <span className="choose-button">选择图片</span>
            </label>
          )}

          {image && (
            <div className="editor-wrap" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void acceptFile(event.dataTransfer.files[0]); }}>
              <div className="editor-tip">
                <span>{activeTool === "ocr" ? "橙色区域需要重点核对；点击文字框可直接校正" : "在海报上拖动框选，只会修改选中的区域"}</span>
                <button type="button" onClick={() => { setSelection(null); setOcrBoxes([]); }}>清除标记</button>
              </div>
              <div className="canvas-viewport">
                <div className="canvas-stack">
                  <canvas ref={canvasRef} aria-label="海报编辑画布" />
                  <canvas
                    ref={overlayRef}
                    className="selection-layer"
                    aria-label="框选局部区域"
                    onPointerDown={startSelection}
                    onPointerMove={moveSelection}
                    onPointerUp={(event) => { endSelection(event); selectOcrBox(event); }}
                    onPointerCancel={endSelection}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="statusbar"><span className={busy ? "busy-dot" : "ready-dot"} />{busy ? "正在处理，请稍候…" : notice}<small>{selection ? `选区 ${Math.round(selection.w)} × ${Math.round(selection.h)} px` : ""}</small></div>
        </section>

        <aside className="inspector">
          <div className="panel-heading"><span className="eyebrow">印刷设置</span><b>目标成品</b></div>
          <label>常用尺寸
            <select value={preset} onChange={(event) => choosePreset(event.target.value as keyof typeof PRINT_PRESETS)}>
              {Object.entries(PRINT_PRESETS).map(([key, value]) => <option value={key} key={key}>{value.label}</option>)}
            </select>
          </label>
          <div className="two-fields">
            <label>宽度<input type="number" min="10" value={printWidth} onChange={(event) => { setPreset("custom"); setPrintWidth(Number(event.target.value)); }} /><small>mm</small></label>
            <label>高度<input type="number" min="10" value={printHeight} onChange={(event) => { setPreset("custom"); setPrintHeight(Number(event.target.value)); }} /><small>mm</small></label>
          </div>
          <button className="swap-button" type="button" onClick={() => { setPreset("custom"); setPrintWidth(printHeight); setPrintHeight(printWidth); }}>↔ 横竖互换</button>
          <label>目标精度
            <select value={targetDpi} onChange={(event) => setTargetDpi(Number(event.target.value))}>
              <option value="300">300 DPI · 标准印刷</option><option value="240">240 DPI · 海报</option><option value="150">150 DPI · 远观展板</option>
            </select>
          </label>

          <div className={`check-card ${quality.tone}`}>
            <div className="score-ring">{effectiveDpi || "—"}<small>{effectiveDpi ? "DPI" : ""}</small></div>
            <div><b>{quality.label}</b><p>{image ? `目标 ${targetDpi} DPI；当前尺寸下有效精度约 ${effectiveDpi} DPI。` : "拖入后显示有效 DPI、放大风险和文字可疑区域。"}</p></div>
          </div>
          {aspectMismatch && <div className="warning-strip">画面比例与成品尺寸不一致，导出时会留白或裁切。</div>}

          {image && <div className="context-panel">
            <div className="panel-divider" />
            {activeTool === "select" && <>
              <h2>当前检查</h2>
              <div className="fact-grid"><div><small>建议像素</small><b>{Math.round(printWidth / 25.4 * targetDpi)} × {Math.round(printHeight / 25.4 * targetDpi)}</b></div><div><small>图片像素</small><b>{image.width} × {image.height}</b></div></div>
              <button className="primary-action" type="button" onClick={() => void runOcr()}>开始检查海报文字</button>
              <button className="secondary-action" type="button" onClick={resetImage}>恢复原图</button>
            </>}
            {activeTool === "ocr" && <>
              <h2>文字检查</h2>
              <p className="panel-copy">{ocrSummary}</p>
              {ocrProgress !== null && <div className="progress-track"><i style={{ width: `${ocrProgress}%` }} /></div>}
              <button className="primary-action" type="button" disabled={ocrProgress !== null} onClick={() => void runOcr()}>{ocrProgress !== null ? `识别中 ${ocrProgress}%` : "重新检查文字"}</button>
              <p className="micro-note">首次运行会下载中文识别模型。OCR 只负责标记风险，印刷前仍建议逐字确认。</p>
            </>}
            {activeTool === "repair" && <>
              <h2>局部图形修复</h2>
              <p className="panel-copy">先框选崩坏图形。四周纹理填补适合纯色、渐变和简单背景。</p>
              <button className="primary-action" type="button" onClick={() => repairSelection("edge")}>用四周纹理填补</button>
              <label className="color-field">纯色覆盖<input type="color" value={coverColor} onChange={(event) => setCoverColor(event.target.value)} /></label>
              <button className="secondary-action" type="button" onClick={() => repairSelection("color")}>使用所选颜色覆盖</button>
            </>}
            {activeTool === "text" && <>
              <h2>替换坏字</h2>
              <label>正确文字<textarea value={replaceText} onChange={(event) => setReplaceText(event.target.value)} placeholder="输入要替换成的文字" /></label>
              <div className="two-fields"><label>字号<input type="number" min="6" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} /></label><label>颜色<input className="color-input" type="color" value={textColor} onChange={(event) => setTextColor(event.target.value)} /></label></div>
              <label>字体<select value={fontFamily} onChange={(event) => setFontFamily(event.target.value)}><option value={'"Microsoft YaHei","PingFang SC",sans-serif'}>清晰黑体</option><option value={'SimSun,"Songti SC",serif'}>宋体</option><option value={'KaiTi,"Kaiti SC",serif'}>楷体</option></select></label>
              <div className="two-fields"><label>字重<select value={fontWeight} onChange={(event) => setFontWeight(event.target.value)}><option value="400">常规</option><option value="700">粗体</option><option value="900">特粗</option></select></label><label>对齐<select value={textAlign} onChange={(event) => setTextAlign(event.target.value as CanvasTextAlign)}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label></div>
              <button className="primary-action" type="button" onClick={applyText}>填补背景并替换文字</button>
            </>}
            {activeTool === "enhance" && <>
              <h2>清晰度增强</h2>
              <p className="panel-copy">轻度锐化能改善边缘观感，但低像素图不会因此恢复真实细节。可框选后只增强局部。</p>
              <button className="primary-action" type="button" onClick={applySharpen}>{selection ? "增强当前选区" : "增强整张海报"}</button>
              <div className="micro-card"><b>真实印刷判断</b><span>最终仍以左侧显示的有效 DPI 为准；放大导出只是重采样。</span></div>
            </>}
          </div>}
        </aside>
      </section>

      {showExport && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowExport(false); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
          <button className="modal-close" type="button" onClick={() => setShowExport(false)}>×</button>
          <span className="eyebrow">导出</span><h2 id="export-title">准备交付印刷</h2>
          <div className="export-summary"><div><small>成品尺寸</small><b>{printWidth} × {printHeight} mm</b></div><div><small>导出像素</small><b>{Math.round(printWidth / 25.4 * targetDpi)} × {Math.round(printHeight / 25.4 * targetDpi)}</b></div><div><small>原图有效精度</small><b>{effectiveDpi} DPI</b></div></div>
          <label>比例不一致时<select value={fitMode} onChange={(event) => setFitMode(event.target.value as "contain" | "cover")}><option value="contain">完整保留，必要时留白</option><option value="cover">撑满页面，必要时裁切</option></select></label>
          <div className="export-options"><button type="button" onClick={() => void exportPdf()}><b>印刷 PDF</b><span>精确写入毫米尺寸，适合交付打印店</span></button><button type="button" onClick={() => void exportPng()}><b>高分辨率 PNG</b><span>按目标 DPI 重采样，方便平台上传</span></button></div>
          <div className={`preflight ${effectiveDpi >= targetDpi ? "pass" : "warn"}`}><b>{effectiveDpi >= targetDpi ? "✓ 清晰度通过" : "! 原图像素不足"}</b><span>{effectiveDpi >= targetDpi ? "当前原图满足目标 DPI。" : "仍可导出，但放大不会创造真实细节；建议缩小印刷尺寸或换更大原图。"}</span></div>
          <p className="micro-note">导出文件为 sRGB。若印刷厂要求专用 CMYK 色彩配置，仍需在专业排版软件中转换。</p>
        </section>
      </div>}

      {showHelp && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowHelp(false); }}>
        <section className="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
          <button className="modal-close" type="button" onClick={() => setShowHelp(false)}>×</button>
          <span className="eyebrow">三步完成</span><h2 id="help-title">从生图到放心印刷</h2>
          <ol><li><b>先定成品尺寸</b><span>工具按毫米尺寸计算真实有效 DPI，不会被“文件很大”误导。</span></li><li><b>验字并局部改</b><span>运行中文 OCR，点击可疑文字框；也可以手动画框，修一处不会改变其他内容。</span></li><li><b>导出前再确认</b><span>下载精确尺寸 PDF 或高分辨率 PNG。复杂纹理的 AI 补图暂不在本地版中执行。</span></li></ol>
        </section>
      </div>}
    </main>
  );
}
