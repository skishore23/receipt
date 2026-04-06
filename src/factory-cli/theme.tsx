import React from "react";
import { Alert, ThemeProvider, defaultTheme, extendTheme } from "@inkjs/ui";
import type { TextProps } from "ink";

export type FactoryThemeToken =
  | "accent"
  | "muted"
  | "success"
  | "warning"
  | "danger"
  | "border"
  | "selection"
  | "hotkey"
  | "logInfo"
  | "logError"
  | "text";

const colorEnabled = !process.env.NO_COLOR;
const unicodeEnabled = process.env.RECEIPT_FORCE_ASCII !== "1" && process.env.TERM !== "dumb";

const palette: Readonly<Record<FactoryThemeToken, TextProps["color"]>> = {
  accent: "cyan",
  muted: "gray",
  success: "green",
  warning: "yellow",
  danger: "red",
  border: "blue",
  selection: "magenta",
  hotkey: "blueBright",
  logInfo: "cyanBright",
  logError: "redBright",
  text: "white",
};

export const terminalTheme = {
  colorEnabled,
  unicodeEnabled,
  borderStyle: unicodeEnabled ? ("round" as const) : ("classic" as const),
  glyphs: {
    bullet: unicodeEnabled ? "•" : "*",
    pointer: unicodeEnabled ? "›" : ">",
    divider: unicodeEnabled ? "─" : "-",
    ellipsis: unicodeEnabled ? "…" : "...",
  },
};

export const tone = (token: FactoryThemeToken): TextProps["color"] | undefined =>
  colorEnabled ? palette[token] : undefined;

export const statusColor = (value: string | undefined): TextProps["color"] | undefined => {
  const normalized = (value ?? "").toLowerCase();
  if (!normalized) return tone("muted");
  if (normalized.includes("fail") || normalized.includes("error") || normalized.includes("cancel") || normalized.includes("conflict")) {
    return tone("danger");
  }
  if (normalized.includes("block") || normalized.includes("attention") || normalized.includes("warn")) {
    return tone("warning");
  }
  if (normalized.includes("complete") || normalized.includes("ready") || normalized.includes("promot") || normalized.includes("success")) {
    return tone("success");
  }
  if (normalized.includes("active") || normalized.includes("running") || normalized.includes("execut") || normalized.includes("merge") || normalized.includes("validat")) {
    return tone("accent");
  }
  return tone("muted");
};

const inkUiTheme = extendTheme(defaultTheme, {
  components: {
    Spinner: {
      styles: {
        frame: () => ({ color: tone("accent") }),
        label: () => ({ color: tone("muted") }),
      },
    },
    Badge: {
      styles: {
        container: ({ color }: { readonly color?: TextProps["color"] }) => ({ color, bold: true }),
        label: () => ({ bold: true }),
      },
    },
    StatusMessage: {
      styles: {
        icon: ({ variant }: { readonly variant: "success" | "error" | "warning" | "info" }) => ({
          color: variant === "success"
            ? tone("success")
            : variant === "error"
              ? tone("danger")
              : variant === "warning"
                ? tone("warning")
                : tone("accent"),
        }),
        message: () => ({ color: tone("text") }),
      },
    },
    Alert: {
      styles: {
        title: () => ({ color: tone("text"), bold: true }),
        message: () => ({ color: tone("muted") }),
      },
    },
    UnorderedList: {
      styles: {
        marker: () => ({ color: tone("accent") }),
      },
      config: () => ({ marker: terminalTheme.glyphs.pointer }),
    },
  },
});

type FactoryThemeProviderProps = {
  readonly children: React.ReactNode;
};

export const FactoryThemeProvider = ({ children }: FactoryThemeProviderProps): React.ReactElement => (
  <ThemeProvider theme={inkUiTheme}>{children}</ThemeProvider>
);

type InlineAlertProps = {
  readonly variant: "success" | "error" | "warning" | "info";
  readonly title: string;
  readonly children: React.ReactNode;
};

export const InlineAlert = ({ variant, title, children }: InlineAlertProps): React.ReactElement => (
  <Alert variant={variant} title={title}>
    {children}
  </Alert>
);
