import type { HierarchyNode } from "./types.js";

    export function formatLoadingBytes(byteCount: number) {
      if (!(Number.isFinite as (value: unknown) => value is number)(byteCount) || byteCount <= 0) {
        return "0 B";
      }
      const units = ["B", "KB", "MB", "GB"];
      let value = byteCount;
      let unitIndex = 0;
      while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
      }
      const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
      return `${value.toFixed(digits)} ${units[unitIndex]}`;
    }

    export function afterPaint() {
      return new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }

    export function sanitizeWeight(value: unknown, fallback: number) {
      const parsed = Number(value);
      if (!(Number.isFinite as (value: unknown) => value is number)(parsed) || parsed < 0) {
        return fallback;
      }
      return parsed;
    }

    export function formatMetricValue(value: number) {
      if (!(Number.isFinite as (value: unknown) => value is number)(value)) {
        return "0";
      }
      const rounded = Math.round(value * 100) / 100;
      if (Math.abs(rounded - Math.round(rounded)) < 1e-9) {
        return Math.round(rounded).toLocaleString();
      }
      return rounded.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      });
    }

    export function clampValue(value: number, min: number, max: number) {
      if (min > max) {
        return (min + max) / 2;
      }
      return Math.max(min, Math.min(max, value));
    }

    export function hoverMetaLine(label: string, value: string) {
      return `<div class="hover-meta-line"><span class="hover-meta-label">${escapeHtml(label)}:</span> ${escapeHtml(value)}</div>`;
    }

    export function nodeInstanceLabel(node: HierarchyNode) {
      const value = typeof node?.name === "string" ? node.name.trim() : "";
      return value || "(root)";
    }

    export function isGenericViewerTitle(title: string) {
      const normalized = (title || "").trim().toLowerCase();
      return (
        !normalized ||
        normalized === "hiers" ||
        normalized === "hier" ||
        normalized === "hierarchy" ||
        normalized === "hierarchy viewer"
      );
    }

    export function formatBuildTime(unixMs: number) {
      if (!(Number.isFinite as (value: unknown) => value is number)(unixMs) || unixMs <= 0) {
        return "";
      }
      const date = new Date(unixMs);
      if (Number.isNaN(date.getTime())) {
        return "";
      }
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date);
    }

    export function buildSubtitleText(title: string, builtAtUnixMs: number) {
      const parts: string[] = [];
      if (!isGenericViewerTitle(title)) {
        parts.push(title);
      }
      const buildTime = formatBuildTime(builtAtUnixMs);
      if (buildTime) {
        parts.push(`Built ${buildTime}`);
      }
      return parts.join(" · ");
    }

    export function hexToRgb(hex: string) {
      const normalized = hex.replace("#", "");
      if (normalized.length !== 6) {
        return { r: 0, g: 0, b: 0 };
      }
      return {
        r: Number.parseInt(normalized.slice(0, 2), 16),
        g: Number.parseInt(normalized.slice(2, 4), 16),
        b: Number.parseInt(normalized.slice(4, 6), 16)
      };
    }

    export function rgbToHex(rgb: { r: number; g: number; b: number }) {
      const toHex = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
      return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
    }

    export function mixHexColors(left: string, right: string, ratio: number) {
      const amount = clampValue(ratio, 0, 1);
      const a = hexToRgb(left);
      const b = hexToRgb(right);
      return rgbToHex({
        r: a.r + (b.r - a.r) * amount,
        g: a.g + (b.g - a.g) * amount,
        b: a.b + (b.b - a.b) * amount
      });
    }

    export function hexToRgba(hex: string, alpha: number) {
      const rgb = hexToRgb(hex);
      return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clampValue(alpha, 0, 1)})`;
    }

    export function validTheme(theme: string) {
      return [
        "warm-paper",
        "vscode-dark",
        "github-light",
        "tokyo-night",
        "nord",
        "solarized-light",
        "catppuccin-latte",
      ].includes(theme);
    }

    export function nextFrame() {
      return new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }

    export function normalizeAnalysisLegendFilter(raw: unknown) {
      if (Array.isArray(raw)) {
        const seen = new Set();
        const normalized: string[] = [];
        for (const entry of raw as unknown[]) {
          if (typeof entry !== "string") {
            continue;
          }
          if (entry !== "descendant" && !/^bucket-[1-4]$/.test(entry)) {
            continue;
          }
          if (seen.has(entry)) {
            continue;
          }
          seen.add(entry);
          normalized.push(entry);
        }
        return normalized;
      }
      if (
        raw === "descendant" ||
        (typeof raw === "string" && /^bucket-[1-4]$/.test(raw))
      ) {
        return [raw];
      }
      return [];
    }

    export function escapeHtml(text: string) {
      return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
    }

    export function clamp(value: number, min: number, max: number) {
      return Math.min(max, Math.max(min, value));
    }
